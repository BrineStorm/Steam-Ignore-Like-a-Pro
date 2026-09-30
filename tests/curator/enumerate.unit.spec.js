const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Curator enumeration logic (src/curator/enumerate.js) is pure (parsing / URL /
// filtering) plus an async fetch loop with fully injectable fetch/sleep/rand.
// Load it directly in Node (vm + a window stub) and assert the contract — no
// browser, no Steam, no real network. Mirrors the decision-matrix unit pattern.
function loadEnumerator() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'curator', 'enumerate.js'),
        'utf8'
    );
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.Curator.Enumerator;
}

// One recommendation row, shaped like Steam's real results_html: the wrapper is
// class="recommendation" (inner nodes carry suffixes), data-ds-appid appears
// TWICE on the capsule <a>, and the type is a SINGLE-quoted color_* class.
function row(appid, color) {
    return `
        <div data-panel="{}" role="button" class="recommendation" >
            <div>
                <a data-ds-appid="${appid}" data-ds-itemkey="App_${appid}"
                   class="store_capsule price_inline" data-ds-appid="${appid}"
                   href="https://store.steampowered.com/app/${appid}/Foo/">
                    <div class="capsule capsule_image_ctn"><img alt="Foo"></div>
                </a>
            </div>
            <a href="https://store.steampowered.com/app/${appid}/Foo/" class="recommendation_link">
                <div class="recommendation_midcol">
                    <div class="recommendation_stats"><div class="recommendation_type_ctn">
                        <img> <span class='color_${color}'>label</span>
                    </div></div>
                </div>
            </a>
        </div>`;
}

const HTML = row('111', 'not_recommended') + row('222', 'informational') + row('333', 'recommended');

test.describe('Curator enumeration — pure logic (unit)', () => {
    const E = loadEnumerator();

    test('parseResults extracts one {appid,type} per row (de-dups the double appid)', () => {
        const parsed = E.parseResults(HTML);
        expect(parsed).toEqual([
            { appid: '111', type: 'not_recommended' },
            { appid: '222', type: 'informational' },
            { appid: '333', type: 'recommended' },
        ]);
    });

    test('parseResults is robust to empty / junk input', () => {
        expect(E.parseResults('')).toEqual([]);
        expect(E.parseResults('<div>no rows here</div>')).toEqual([]);
    });

    test('categorize folds rows into per-type appid lists and de-dups across pages', () => {
        const apps = E.categorize([
            { appid: '111', type: 'not_recommended' },
            { appid: '111', type: 'not_recommended' }, // duplicate across pages
            { appid: '222', type: 'informational' },
            { appid: '333', type: 'recommended' },
            { appid: '444', type: 'unknown' },          // dropped — never queued
        ]);
        expect(apps).toEqual({
            not_recommended: ['111'],
            informational: ['222'],
            recommended: ['333'],
        });
    });

    test('filterAppids maps each filter to the right subset', () => {
        const apps = { not_recommended: ['1', '2'], informational: ['3'], recommended: ['4'] };
        expect(E.filterAppids(apps, 'not_recommended')).toEqual(['1', '2']);
        expect(E.filterAppids(apps, 'informational')).toEqual(['3']);
        expect(E.filterAppids(apps, 'all_but_recommended')).toEqual(['1', '2', '3']);
        // default falls back to not_recommended; recommended is never ignored
        expect(E.filterAppids(apps, 'whatever')).toEqual(['1', '2']);
    });

    test('buildUrl targets the ajax endpoint with start/count and stable params', () => {
        const url = E.buildUrl('45186708', 500, 500);
        expect(url).toContain('/curator/45186708/ajaxgetfilteredrecommendations/');
        expect(url).toContain('start=500');
        expect(url).toContain('count=500');
        expect(url).toContain('sort=recent');
        expect(url).toContain('reset=false');
    });

    test('enumerate reads pages until total_count is covered, then categorizes', async () => {
        const urls = [];
        const pages = [
            { success: 1, total_count: 3, results_html: HTML },
        ];
        let i = 0;
        const fetchImpl = async (url) => {
            urls.push(url);
            const data = pages[i++];
            return { ok: true, json: async () => data };
        };
        const result = await E.enumerate('999', {
            fetch: fetchImpl,
            sleep: () => Promise.resolve(),
            rand: () => 0,
            count: 500,
        });

        expect(urls).toHaveLength(1);                 // one read covers all 3
        expect(result.total).toBe(3);
        expect(result.apps.not_recommended).toEqual(['111']);
        expect(result.apps.informational).toEqual(['222']);
        expect(result.apps.recommended).toEqual(['333']);
    });

    test('enumerate paginates across multiple reads for a large list', async () => {
        // total_count 4, count 2 → two reads of two rows each.
        const pageA = { success: 1, total_count: 4, results_html: row('1', 'not_recommended') + row('2', 'not_recommended') };
        const pageB = { success: 1, total_count: 4, results_html: row('3', 'informational') + row('4', 'recommended') };
        const queue = [pageA, pageB];
        let i = 0;
        const result = await E.enumerate('999', {
            fetch: async () => ({ ok: true, json: async () => queue[i++] }),
            sleep: () => Promise.resolve(),
            rand: () => 0,
            count: 2,
        });
        expect(result.total).toBe(4);
        expect(result.apps.not_recommended).toEqual(['1', '2']);
        expect(result.apps.informational).toEqual(['3']);
        expect(result.apps.recommended).toEqual(['4']);
    });

    test('enumerate stops cleanly on a failed response', async () => {
        const result = await E.enumerate('999', {
            fetch: async () => ({ ok: false }),
            sleep: () => Promise.resolve(),
            rand: () => 0,
        });
        expect(result.apps.not_recommended).toEqual([]);
        expect(result.partial, 'a failed first read is a partial run').toBe(true);
    });

    // `partial` is what keeps a half-read curator out of the 7-day retention
    // cache (EnqueueService.resolve). It has to be false on every clean finish,
    // or a working curator would be re-enumerated on every re-add; and true
    // whenever we stopped short, or a truncated list would be served as the
    // whole thing until the TTL ran out.
    test('a run that covers total_count is not partial', async () => {
        const page = { success: 1, total_count: 1, results_html: row('1', 'not_recommended') };
        const result = await E.enumerate('999', {
            fetch: async () => ({ ok: true, json: async () => page }),
            sleep: () => Promise.resolve(),
            rand: () => 0,
            count: 1,
        });
        expect(result.apps.not_recommended).toEqual(['1']);
        expect(result.partial).toBe(false);
    });

    test('a read that fails PART-WAY keeps its rows but reports partial', async () => {
        // total_count 4, count 2: page one lands, page two dies on the network.
        const pageA = { success: 1, total_count: 4, results_html: row('1', 'not_recommended') + row('2', 'not_recommended') };
        let i = 0;
        const result = await E.enumerate('999', {
            fetch: async () => {
                if (i++ === 0) return { ok: true, json: async () => pageA };
                throw new Error('network');
            },
            sleep: () => Promise.resolve(),
            rand: () => 0,
            count: 2,
        });
        // The rows already read are kept — the job still runs on them...
        expect(result.apps.not_recommended).toEqual(['1', '2']);
        // ...but this must never be cached as the complete curator.
        expect(result.partial).toBe(true);
    });

    test('a short page is the server saying "no more", not a partial run', async () => {
        // total_count lies high (stale), but the second page comes back empty:
        // that is Steam's own count being wrong, not a failure of ours.
        const pageA = { success: 1, total_count: 99, results_html: row('1', 'not_recommended') };
        const pageB = { success: 1, total_count: 99, results_html: '' };
        const queue = [pageA, pageB];
        let i = 0;
        const result = await E.enumerate('999', {
            fetch: async () => ({ ok: true, json: async () => queue[i++] }),
            sleep: () => Promise.resolve(),
            rand: () => 0,
            count: 1,
        });
        expect(result.apps.not_recommended).toEqual(['1']);
        expect(result.partial).toBe(false);
    });

    test('markup we cannot parse at all is a partial run, not an empty curator', async () => {
        // What a Valve markup change looks like from in here: the server reports
        // rows, parseResults reads none. The run must not be cached, or the
        // emptiness it produced would be served for the whole retention week and
        // every re-add inside it would fail identically without a request.
        const page = { success: 1, total_count: 99, results_html: '<div class="rec_v2">x</div>' };
        const result = await E.enumerate('999', {
            fetch: async () => ({ ok: true, json: async () => page }),
            sleep: () => Promise.resolve(),
            rand: () => 0,
            count: 1,
        });
        expect(result.apps.not_recommended).toEqual([]);
        expect(result.partial, 'nothing parsed while the server reports rows').toBe(true);
    });

    test('a curator that really has nothing is NOT partial', async () => {
        // The same empty result, with the server agreeing it is empty: cacheable.
        const page = { success: 1, total_count: 0, results_html: '' };
        const result = await E.enumerate('999', {
            fetch: async () => ({ ok: true, json: async () => page }),
            sleep: () => Promise.resolve(),
            rand: () => 0,
            count: 1,
        });
        expect(result.partial).toBe(false);
    });

    test('hitting our own page ceiling short of total_count is partial', async () => {
        const page = { success: 1, total_count: 99, results_html: row('1', 'not_recommended') };
        const result = await E.enumerate('999', {
            fetch: async () => ({ ok: true, json: async () => page }),
            sleep: () => Promise.resolve(),
            rand: () => 0,
            count: 1,
            maxPages: 2,
        });
        expect(result.partial, 'stopped by maxPages, not by Steam').toBe(true);
    });
});
