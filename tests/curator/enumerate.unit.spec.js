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
    });
});
