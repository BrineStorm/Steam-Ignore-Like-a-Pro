// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadEscape } = require('../_escape.js');

// CreatorControl (src/manual-ignore/creators-ui.js): what a gesture or a pill
// click on a creator's link queues, in Node. The page painting is E2E.
const SRC = path.join(__dirname, '..', '..', 'src');

function loadControl(state, overrides) {
    const sandbox = {
        window: {}, URL, Promise, Map, Set, Array, String, Object, setTimeout, clearTimeout,
        location: { href: 'https://store.steampowered.com/sale/x' },
        document: { querySelectorAll: () => [] },
    };
    vm.createContext(sandbox);
    loadEscape(sandbox);
    vm.runInContext(fs.readFileSync(path.join(SRC, 'manual-ignore', 'gestures.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(path.join(SRC, 'manual-ignore', 'creators-ui.js'), 'utf8'), sandbox);
    const calls = { enqueued: [], toasts: [], reads: 0, appReads: 0 };
    const control = new sandbox.window.ILAP.ManualIgnore.CreatorControl(Object.assign({
        read: async () => ({ mirror: state.mirror, job: null, cursor: 0 }),
        effective: (mirror) => new Map(Object.entries(mirror.ignored)),
        enqueue: async (spec) => { calls.enqueued.push(spec); return { kind: 'added' }; },
        fetchClanId: async () => { calls.reads++; return '33019580'; },
        fetchAppCreators: async () => { calls.appReads += 1; return []; },
        isLoggedIn: async () => true,
        isSignedIn: async () => true,
        isEnabled: () => true,
        toast: (key) => calls.toasts.push(key),
        t: (key) => key,
        creatorPath: sandbox.window.ILAP.ManualIgnore.creatorPath,
        linkSelector: sandbox.window.ILAP.ManualIgnore.CREATOR_LINK,
    }, overrides));
    return { control, calls, sandbox };
}

// A link as the control reads it.
const link = (href, text) => ({
    getAttribute: (n) => (n === 'href' ? href : null),
    textContent: text,
    closest: () => null,
});

test.describe('ManualIgnore — creator links (unit)', () => {
    test('a gesture on a creator page link reads its clan id once and queues the ignore', async () => {
        const { control, calls } = loadControl({ mirror: { ignored: {}, followed: [] } });
        await control.refresh();
        const a = link('/publisher/8floor?snr=1', ' 8floor ');
        await control.request({ link: a, ignore: true });
        expect(calls.enqueued).toEqual([{ clanid: '33019580', name: '8floor', ignore: true }]);
        expect(calls.toasts).toEqual(['creator_ignored_toast']);
        // Known by its path from now on: no second read.
        await control.request({ link: a, ignore: false });
        expect(calls.reads).toBe(1);
    });

    test('a followed creator is refused with a word, an ignored one is left as it is', async () => {
        const { control, calls } = loadControl({ mirror: { ignored: { 4: 'Valve' }, followed: ['33019580'] } });
        await control.refresh();
        await control.request({ link: link('/developer/8floor', '8floor'), ignore: true });
        expect(calls.toasts).toEqual(['creator_followed']);
        control.byPath.set('developer/valve', '4');
        await control.request({ link: link('/developer/valve', 'Valve'), ignore: true });
        expect(calls.enqueued).toEqual([]);
        // Un-ignoring it queues the rollback with the name the account has.
        await control.request({ link: link('/developer/valve', 'VALVE'), ignore: false });
        expect(calls.enqueued).toEqual([{ clanid: '4', name: 'Valve', ignore: false }]);
    });

    test('no page, no clan id: the user is told; signed out or master off: nothing at all', async () => {
        const none = loadControl({ mirror: { ignored: {}, followed: [] } }, { fetchClanId: async () => null });
        await none.control.request({ link: link('/franchise/x', 'X'), ignore: true });
        expect(none.calls.toasts).toEqual(['creator_no_page']);

        const out = loadControl({ mirror: { ignored: {}, followed: [] } }, { isLoggedIn: async () => false });
        await out.control.request({ link: link('/developer/x', 'X'), ignore: true });
        const off = loadControl({ mirror: { ignored: {}, followed: [] } }, { isEnabled: () => false });
        await off.control.request({ link: link('/developer/x', 'X'), ignore: true });
        for (const c of [out.calls, off.calls]) {
            expect(c.reads).toBe(0);
            expect(c.enqueued).toEqual([]);
            expect(c.toasts).toEqual([]);
        }
    });

    test('a game page asks Steam for its creators only with the master on and signed in', async () => {
        const off = loadControl({ mirror: { ignored: {}, followed: [] } }, { isEnabled: () => false });
        await off.control.boot('/app/10/');
        expect(off.calls.appReads).toBe(0);

        const out = loadControl({ mirror: { ignored: {}, followed: [] } }, { isSignedIn: async () => false });
        await out.control.boot('/app/10/');
        expect(out.calls.appReads).toBe(0);

        const on = loadControl({ mirror: { ignored: {}, followed: [] } });
        await on.control.boot('/sale/x');
        expect(on.calls.appReads).toBe(0);
        await on.control.boot('/app/10/');
        expect(on.calls.appReads).toBe(1);
    });

    test('the master coming on reads once what the boot did not, and never twice', async () => {
        let enabled = false;
        const { control, calls } = loadControl({ mirror: { ignored: {}, followed: [] } }, { isEnabled: () => enabled });
        await control.boot('/app/10/');
        expect(calls.appReads).toBe(0);
        enabled = true;
        await control.resume();
        await control.resume();
        expect(calls.appReads).toBe(1);
    });

    test('a signed-out visitor gets no pill on a game page: its click could only do nothing', async () => {
        const row = Object.assign(link('/developer/x', 'X'), { closest: () => ({}), dataset: {}, nextElementSibling: null });
        const out = loadControl({ mirror: { ignored: {}, followed: [] } }, { isSignedIn: async () => false });
        out.sandbox.document.querySelectorAll = () => [row];
        const wired = [];
        out.control._wirePill = (l) => wired.push(l);
        await out.control.boot('/app/10/');
        out.control.paint();
        expect(wired).toEqual([]);

        const on = loadControl({ mirror: { ignored: {}, followed: [] } });
        on.sandbox.document.querySelectorAll = () => [row];
        on.control._wirePill = (l) => wired.push(l);
        await on.control.boot('/app/10/');
        expect(wired).toContain(row);
    });

    test('a clan id read on a click repaints the page, also when nothing is sent', async () => {
        const { control, calls } = loadControl({ mirror: { ignored: { 33019580: '8floor' }, followed: [] } });
        await control.refresh();
        let paints = 0;
        control.paint = () => { paints++; };
        await control.request({ link: link('/developer/8floor', '8floor'), ignore: true });
        expect(calls.enqueued).toEqual([]);
        expect(paints).toBe(1);
    });

    test('two creators of one name on a game page are known by their pages alone', async () => {
        const { control, calls } = loadControl({ mirror: { ignored: {}, followed: [] } }, {
            fetchAppCreators: async () => [
                { id: '1', name: 'Same' }, { id: '2', name: 'Same' }, { id: '3', name: 'Dev' }, { id: '3', name: 'Dev' }],
        });
        await control.boot('/app/10/');
        const row = (href, text) => Object.assign(link(href, text), { closest: () => ({}) });
        expect(control.idOf(row('/search/?franchise=Same', 'Same'))).toBe(null);
        expect(control.idOf(row('/search/?developer=Dev', 'Dev'))).toBe('3');
        await control.request({ link: row('/franchise/Same', 'Same'), ignore: true });
        expect(calls.reads).toBe(1);
        expect(calls.enqueued).toEqual([{ clanid: '33019580', name: 'Same', ignore: true }]);
    });

    test('a full creator job says so', async () => {
        const { control, calls } = loadControl({ mirror: { ignored: {}, followed: [] } },
            { enqueue: async () => ({ kind: 'full' }) });
        await control.request({ link: link('/developer/x', 'X'), ignore: true });
        expect(calls.toasts).toEqual(['creator_queue_stuck']);
    });

    test('only creator page links are gesture targets', () => {
        const { control } = loadControl({ mirror: { ignored: {}, followed: [] } });
        expect(control.creatorPath('https://store.steampowered.com/developer/Valve/?snr=1')).toBe('developer/valve');
        expect(control.creatorPath('/franchise/Rainbow6Franchise')).toBe('franchise/rainbow6franchise');
        expect(control.creatorPath('/search/?developer=Ubisoft%20Montreal')).toBe(null);
        expect(control.creatorPath('https://example.com/developer/x')).toBe(null);
    });
});
