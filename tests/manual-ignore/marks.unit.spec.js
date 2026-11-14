// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The three mark models of a Manual-Ignore tab (src/manual-ignore/marks.js) as
// Node units: what each keeps, what it tells the renderer, and what a reload
// brings back. IgnoreManager's use of them is master-gate.unit's.

function loadMarks() {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'manual-ignore', 'marks.js'), 'utf8');
    const sandbox = { window: { ILAP: { ManualIgnore: {} } } };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.ManualIgnore;
}

const memorySession = (init) => {
    const store = new Map(init ? [['ilap_session_map_v2', JSON.stringify(init)]] : []);
    return { get: (k) => store.get(k) || null, set: (k, v) => store.set(k, v), raw: () => JSON.parse(store.get('ilap_session_map_v2')) };
};

// A renderer that records what it was asked. `greyed`: the appids whose
// capsule Steam greys out.
function recorder(greyed = []) {
    const calls = [];
    return {
        calls,
        steamGreyed: (link) => (greyed.includes(link.appid) ? { flag: link.appid } : null),
        tintSteamFlag: (flag, appid, reason) => calls.push(['tint', appid, reason]),
        untintSteamFlag: (appid) => calls.push(['untint', appid]),
        render: (link, key, reason) => calls.push(['render', key, reason]),
        unrender: (key) => calls.push(['unrender', key]),
    };
}

test.describe('ManualIgnore — mark models (unit)', () => {
    test('BadgeMarks: a reload brings back every row this tab wrote, and nothing the page forged', () => {
        const { BadgeMarks } = loadMarks();
        const now = Date.now();
        const session = memorySession([
            ['620', 2, now - 1000, 1], ['400', 0, now - 500], ['70', 0],
            ['1"]', 0, now], [620, 0, now], ['999', 0, now + 3600000],
        ]);
        const marks = new BadgeMarks(session);
        expect(marks.appids()).toEqual(['620', '400', '70', '999']);
        expect(marks.reason('620')).toBe(2);
        expect(marks.isAuto('620')).toBe(true);
        expect(marks.isAuto('400')).toBe(false);
        expect(marks.queuedAt('400')).toBe(now - 500);
        // No time, or one from the future: none (a cancel then errs safe).
        expect(marks.queuedAt('70')).toBe(undefined);
        expect(marks.queuedAt('999')).toBe(undefined);
    });

    test('BadgeMarks: add, delete and save round-trip through the session', () => {
        const { BadgeMarks } = loadMarks();
        const session = memorySession();
        const marks = new BadgeMarks(session);
        marks.add('620', 0, 111, true);
        marks.add('400', 2, 222);
        marks.save();
        expect(session.raw()).toEqual([['620', 0, 111, 1], ['400', 2, 222]]);
        expect(marks.delete('620')).toBe(true);
        expect(marks.delete('620')).toBe(false);
        expect(marks.isAuto('620')).toBe(false);
        marks.save();
        expect(new BadgeMarks(session).appids()).toEqual(['400']);
        // A swipe on a game the switch had badged takes the AI mark off.
        marks.add('400', 0, 333, true);
        marks.add('400', 2, 444);
        expect(marks.isAuto('400')).toBe(false);
    });

    test('BadgeMarks: an unreadable session is an empty one', () => {
        const { BadgeMarks } = loadMarks();
        const marks = new BadgeMarks({ get: () => '{not json', set: () => {} });
        expect(marks.size).toBe(0);
    });

    test('TintMarks: Steam\'s grey counts until the game is un-ignored on this page', () => {
        const { TintMarks } = loadMarks();
        const r = recorder(['620']);
        const tints = new TintMarks(r);
        const link = { appid: '620' };
        expect(tints.greyed(link, '620')).toEqual({ flag: '620' });
        expect(tints.claims(link, '620')).toBe(true);
        expect(tints.claims({ appid: '400' }, '400')).toBe(false);
        tints.noteUnignored('620');
        expect(tints.greyed(link, '620')).toBe(null);
        // Still claimed: the switch leaves a game un-ignored here.
        expect(tints.claims({ appid: '400' }, '620')).toBe(true);
    });

    test('TintMarks: a tint paints on a greyed link only, and clear and hide take it off', () => {
        const { TintMarks } = loadMarks();
        const r = recorder(['620']);
        const tints = new TintMarks(r);
        tints.paint({ appid: '620' }, '620');
        expect(r.calls).toEqual([]);
        tints.set('620', 2);
        tints.paint({ appid: '620' }, '620');
        tints.paint({ appid: '400' }, '620');   // a link Steam does not grey
        expect(r.calls).toEqual([['tint', '620', 2]]);
        tints.hide();
        expect(tints.has('620')).toBe(true);    // the model stays for a re-enable
        expect(tints.clear('620')).toBe(true);
        expect(tints.clear('620')).toBe(false);
        expect(r.calls.slice(1)).toEqual([['untint', '620'], ['untint', '620']]);
    });

    test('BundleMarks: only bundle keys are kept, a mark that goes takes its badges, paint badges art links only', () => {
        const { BundleMarks } = loadMarks();
        const r = recorder();
        const bundles = new BundleMarks(r);
        bundles.set(['bundle_232', 'sub_7', 'junk"]', 'app_5']);
        expect(bundles.list()).toEqual(['bundle_232', 'sub_7']);
        bundles.set(['sub_7']);
        expect(r.calls).toEqual([['unrender', 'bundle_232']]);

        const link = (href, art) => ({ getAttribute: () => href, querySelector: () => (art ? {} : null) });
        const root = { querySelectorAll: () => [
            link('https://store.steampowered.com/sub/7/', true),
            link('/sub/7/', false),          // a text link: no gesture, no badge
            link('/sub/70/', true),
            link('/bundle/232/', true),      // no longer marked
        ] };
        r.calls.length = 0;
        bundles.paint(root);
        expect(r.calls).toEqual([['render', 'sub_7', 0]]);
        bundles.hide();
        expect(r.calls.slice(1)).toEqual([['unrender', 'sub_7']]);
    });

    test('BundleMarks: with no mark the page is not read', () => {
        const { BundleMarks } = loadMarks();
        const bundles = new BundleMarks(recorder());
        bundles.paint({ querySelectorAll: () => { throw new Error('read'); } });
    });

    test('each model checks its collaborator as it is built', () => {
        // BadgeMarks swallows every storage error, so a missing session would
        // only show as badges gone after a reload.
        const { BadgeMarks, TintMarks, BundleMarks } = loadMarks();
        expect(() => new BadgeMarks()).toThrow(/BadgeMarks needs session/);
        expect(() => new BadgeMarks({ get: () => null })).toThrow(/BadgeMarks needs session/);
        expect(() => new TintMarks({ steamGreyed() {} })).toThrow(/TintMarks needs renderer/);
        expect(() => new BundleMarks({ render() {} })).toThrow(/BundleMarks needs renderer/);
    });
});
