// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// src/steam-activity.js tells the ignore gate what the user does on a Steam
// page: input marks them active, and every ignore POST the PAGE sends is
// counted, its 429 escalating the shared penalty. The POST is seen through the
// page's resource timeline, which was verified live: Steam's app page and
// search send it by XHR to `/ignorerecommendation/`, the React calendar by
// fetch to `/ignorerecommendation` with no trailing slash. On Firefox our own
// content-script fetch lands in that timeline too, so utils.js marks each POST
// it sends and the watcher skips those: their caller already counted them.
//
// Loaded with the real utils.js, so the mark/claim pairing is the shipped one;
// the gate is a recorder.
function load({ master = true } = {}) {
    const listeners = {};
    let observerCb = null;
    let masterChange = null;
    let perfNow = 1000;
    const calls = { activity: 0, native: [] };
    const fetched = [];
    const sandbox = {
        window: {
            addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
        },
        console,
        document: { cookie: 'sessionid=abc', querySelector: () => null, getElementById: () => null },
        location: { origin: 'https://store.steampowered.com' },
        performance: { now: () => perfNow },
        PerformanceObserver: class {
            constructor(cb) { observerCb = cb; }
            observe() {}
        },
        fetch: (url) => {
            fetched.push(url);
            return Promise.resolve({ status: 200, ok: true, headers: { get: () => null } });
        },
        // fetchWithTimeout leaves its deadline timer running by design; it must
        // not hold the worker.
        setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
        clearTimeout, AbortController, URL, URLSearchParams,
        Date, Math, Object, Promise, Set, Map, String, RegExp, JSON,
    };
    vm.createContext(sandbox);
    for (const f of ['escape.js', 'stats.js', 'steam-net.js', 'utils.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', f), 'utf8'), sandbox);
    }
    sandbox.window.ILAP.IgnoreGate = {
        noteUserActivity: () => { calls.activity++; return Promise.resolve(); },
        noteNativeIgnore: (status) => { calls.native.push(status); return Promise.resolve(); },
    };
    // The real watch reads storage first; the stub answers at once.
    sandbox.window.ILAP.MasterSwitch = {
        watch: ({ onInit, onChange }) => { onInit(master); masterChange = onChange; },
    };
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'steam-activity.js'), 'utf8'), sandbox);

    const entry = (name, startTime, responseStatus) => ({ name, startTime, responseStatus });
    return {
        ILAP: sandbox.window.ILAP,
        calls, fetched,
        setNow: (t) => { perfNow = t; },
        observe: (...entries) => observerCb({ getEntries: () => entries }),
        entry,
        fire: (type, event) => listeners[type].forEach(fn => fn(event)),
        setMaster: (on) => masterChange(on),
    };
}

// A trusted input event whose composed path is `nodes` (innermost first).
const input = (nodes, isTrusted = true) => ({ isTrusted, composedPath: () => nodes });
const el = (id, className) => ({ nodeType: 1, id: id || '', className: className || '' });

test.describe('Steam page activity (unit)', () => {

    test('the page load itself counts as activity', () => {
        const { calls } = load();
        expect(calls.activity).toBe(1);
    });

    test('with the master switch off nothing is written, and turning it on resumes', () => {
        const { calls, fire, observe, entry, setMaster } = load({ master: false });
        const url = 'https://store.steampowered.com/recommended/ignorerecommendation/';
        fire('pointerdown', input([el('', 'search_result_row')]));
        observe(entry(url, 10, 429));
        expect(calls.activity).toBe(0);
        expect(calls.native).toEqual([]);
        setMaster(true);
        fire('pointerdown', input([el('', 'search_result_row')]));
        observe(entry(url, 20, 200));
        expect(calls.activity).toBe(1);
        expect(calls.native).toEqual([200]);
        setMaster(false);
        fire('keydown', input([el('store_nav_search_term')]));
        expect(calls.activity).toBe(1);
    });

    test('trusted input on Steam\'s page counts; synthetic input does not', () => {
        const { calls, fire } = load();
        fire('pointerdown', input([el('', 'search_result_row'), el('', '')]));
        fire('keydown', input([el('store_nav_search_term')]));
        fire('pointerdown', input([el('', 'search_result_row')], false));
        expect(calls.activity).toBe(1 + 2);
    });

    test('input on the extension\'s own UI does not count', () => {
        // The widget host, the toast, the curator controls: none of them sends
        // anything to Steam by itself. An SVG node's className is not a string.
        const { calls, fire } = load();
        fire('pointerdown', input([{ nodeType: 1, id: '', className: { baseVal: 'x' } }, el('ilap-widget-host')]));
        fire('pointerdown', input([el('ilap-toast')]));
        fire('pointerdown', input([el('', 'btn ilap-curator-ctl')]));
        expect(calls.activity).toBe(1);
    });

    test('an ignore POST from the page is counted with its status, with or without the slash', () => {
        const { calls, observe, entry } = load();
        observe(
            entry('https://store.steampowered.com/recommended/ignorerecommendation/', 10, 200),
            entry('https://store.steampowered.com/recommended/ignorerecommendation', 20, 429),
        );
        expect(calls.native).toEqual([200, 429]);
    });

    test('a browser that does not expose the status counts the POST as status 0', () => {
        const { calls, observe, entry } = load();
        observe(entry('https://store.steampowered.com/recommended/ignorerecommendation/', 10, undefined));
        expect(calls.native).toEqual([0]);
    });

    test('other requests are not ignore POSTs', () => {
        const { calls, observe, entry } = load();
        observe(
            entry('https://store.steampowered.com/dynamicstore/userdata/?_=1', 10, 200),
            entry('https://store.steampowered.com/recommended/ignorerecommendationx/', 10, 200),
            entry('https://store.steampowered.com/recommended/', 10, 200),
            entry('https://example.com/recommended/ignorerecommendation/', 10, 200),
            entry('not a url', 10, 200),
        );
        expect(calls.native).toEqual([]);
    });

    test('our own POST is skipped once; a page POST next to it still counts', async () => {
        const { ILAP, calls, fetched, setNow, observe, entry } = load();
        setNow(5000);
        await ILAP.apiIgnoreGame('10', 0);
        expect(fetched).toHaveLength(1);
        const url = 'https://store.steampowered.com/recommended/ignorerecommendation/';
        // Our POST's entry, a few ms off the mark: skipped, and its 429 is the
        // caller's to report.
        observe(entry(url, 5003, 429));
        expect(calls.native).toEqual([]);
        // The mark is spent: a second entry at the same time is the page's.
        observe(entry(url, 5004, 200));
        expect(calls.native).toEqual([200]);
    });

    test('a mark far from the entry does not swallow a page POST', async () => {
        const { ILAP, calls, setNow, observe, entry } = load();
        setNow(5000);
        await ILAP.apiIgnoreGame('10', 0);
        observe(entry('https://store.steampowered.com/recommended/ignorerecommendation/', 6000, 200));
        expect(calls.native).toEqual([200]);
    });

    test('an old mark expires instead of piling up', async () => {
        const { ILAP, calls, setNow, observe, entry } = load();
        setNow(5000);
        await ILAP.apiIgnoreGame('10', 0);
        setNow(25000);                                      // past the 15 s TTL
        await ILAP.apiIgnoreGame('11', 0);
        expect(ILAP.OwnIgnorePosts._starts).toEqual([25000]);
        observe(entry('https://store.steampowered.com/recommended/ignorerecommendation/', 5000, 200));
        expect(calls.native).toEqual([200]);
    });
});
