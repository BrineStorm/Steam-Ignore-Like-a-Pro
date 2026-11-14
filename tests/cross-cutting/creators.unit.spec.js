// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadEscape } = require('../_escape.js');

// src/creators.js: the creator mirror's pure transforms and the two page
// parsers, in Node. The reads themselves are a store tab's (paced GETs).
function loadCreators() {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    loadEscape(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'creators.js'), 'utf8'), sandbox);
    return sandbox.window.ILAP.Creators;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

test.describe('Creators (unit)', () => {
    test('a sync takes Steam\'s two lists and keeps the names it knows', () => {
        const C = loadCreators();
        const before = { ignored: { 4: 'Valve', 9: 'Gone' }, followed: ['1'] };
        const after = C.synced(before, new Set(['4', '33019580']), new Set(['2']), 100);
        expect(plain(after)).toEqual({ ignored: { 4: 'Valve', 33019580: '' }, followed: ['2'], ts: 100 });
        expect(C.unnamed(after)).toEqual(['33019580']);
        // A changed answer (no list) leaves the mirror as it was.
        expect(plain(C.synced(before, null, new Set(), 100))).toEqual(before);
    });

    test('a name the page did not give is asked again only after a day', () => {
        const C = loadCreators();
        const day = C.NAME_RETRY_MS;
        let m = C.named({ ignored: { 4: '', 5: '' }, followed: [] }, '4', '', 1000);
        expect(plain(m.tried)).toEqual({ 4: 1000 });
        expect(C.unnamed(m, 1000 + day - 1)).toEqual(['5']);
        expect(C.unnamed(m, 1000 + day)).toEqual(['4', '5']);
        // A sync keeps the time for a creator still unnamed and drops the rest.
        m = C.synced(Object.assign(m, { tried: { 4: 1000, 9: 1000 } }), new Set(['4']), new Set(), 2000);
        expect(plain(m.tried)).toEqual({ 4: 1000 });
        // A name that comes later clears the time.
        m = C.named(m, '4', 'Four', 3000);
        expect(plain(m)).toEqual({ ignored: { 4: 'Four' }, followed: [], ts: 2000 });
        // A creator no longer ignored is left out.
        expect(C.named(m, '7', '', 4000).tried).toBeUndefined();
    });

    test('a landed POST adds or takes off one creator', () => {
        const C = loadCreators();
        const m = C.noted({}, 33019580, '8floor ltd', true);
        expect(plain(m.ignored)).toEqual({ 33019580: '8floor ltd' });
        expect(plain(C.noted(m, '33019580', '', false).ignored)).toEqual({});
        // Garbage in storage reads as an empty mirror.
        expect(plain(C.asMirror('x'))).toEqual({ ignored: {}, followed: [] });
    });

    test('what the user sees is the mirror with the waiting entries over it, in order', () => {
        const C = loadCreators();
        const mirror = { ignored: { 4: 'Valve', 5: 'Five' }, followed: [] };
        const job = { appids: ['6', '4', '6'], meta: {
            6: { name: 'Six', ignore: false }, 4: { name: 'Valve', ignore: false } } };
        // Entry 0 already drained; 4 is being rolled back, 6 was last asked off.
        const seen = C.effective(mirror, job, 1);
        expect([...seen.keys()].sort()).toEqual(['5']);
        const ignoring = C.effective(mirror, { appids: ['7'], meta: { 7: { name: 'Seven', ignore: true } } }, 0);
        expect(ignoring.get('7')).toBe('Seven');
    });

    test('the name comes from the English og:title, the clan id from Steam\'s own button', () => {
        const C = loadCreators();
        expect(C.nameFromPage('<meta property="og:title" content="Steam Curator: Tom &amp; Jerry &quot;Games&quot;">'))
            .toBe('Tom & Jerry "Games"');
        expect(C.nameFromPage('<title>x</title>')).toBe('');
        expect(C.clanIdFromPage('<a onclick="IgnoreCurator( 33075774, true ); return false;">')).toBe('33075774');
        expect(C.clanIdFromPage('<a>nothing</a>')).toBe(null);
    });
});

// The one read a store tab and the popup share: the mirror, the creator job
// and its cursor, as `effective` takes them.
test('readState reads the mirror with the creator job and its cursor', async () => {
    const stored = { ilap_creators: { ignored: { 4: 'Valve' }, followed: [] } };
    const sandbox = {
        window: {},
        chrome: { storage: { local: { get: (k, cb) => cb({ [k]: stored[k] }), set: (o, cb) => cb && cb() } } },
    };
    vm.createContext(sandbox);
    loadEscape(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'creators.js'), 'utf8'), sandbox);
    const C = sandbox.window.ILAP.Creators;
    const job = { id: 'job_creator', type: 'creator', appids: ['4', '9'], meta: { 4: { ignore: false }, 9: { name: 'Nine', ignore: true } } };
    const store = {
        CREATOR_JOB_ID: 'job_creator', JOB_TYPE: { CREATOR: 'creator' },
        jobType: (j) => j.type || 'curator',
        getQueue: async () => [{ id: 'c1', type: 'curator', appids: [] }, job],
        getCursor: async (id) => (id === 'job_creator' ? 1 : undefined),
    };
    const state = await C.readState(store);
    expect(plain(state.mirror)).toEqual({ ignored: { 4: 'Valve' }, followed: [] });
    expect(state.job).toBe(job);
    expect(state.cursor).toBe(1);
    // From the cursor on: '4' was already sent, '9' still waits.
    expect(Array.from(C.effective(state.mirror, state.job, state.cursor))).toEqual([['4', 'Valve'], ['9', 'Nine']]);

    const none = await C.readState(Object.assign({}, store, { getQueue: async () => [], getCursor: async () => undefined }));
    expect(none.job).toBe(null);
    expect(none.cursor).toBe(0);
});
