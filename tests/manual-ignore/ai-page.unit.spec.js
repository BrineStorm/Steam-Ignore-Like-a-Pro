// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The AI note on a game's own page (src/manual-ignore/ai-page.js): when it shows
// and which kind its flag names, in Node. The game counts as its capsules do
// (src/ai-disclosure.js counts, the real word rules). Drawing it is the E2E
// spec's (ai-page.spec.js).
const src = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', ...p), 'utf8');

function load() {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(src('presets.js'), sandbox);
    vm.runInContext(src('ai-disclosure.js'), sandbox);
    vm.runInContext(src('manual-ignore', 'ai-page.js'), sandbox);
    return sandbox.window.ILAP;
}

const DATA = {
    ai: { 2025: [10, 20, 30, 40, 50, 60] },
    aikeep: { translation: [20, 60], ingame: [30] },
    aimanual: [40],
    airemoved: [50, 60],
};
const KEEP_BOTH = { translation: true, ingame: true };
const KEEP_NONE = { translation: false, ingame: false };
const LOW = 1;
const HIGH = 3;

function note({ appid = '10', level = LOW, keep = KEEP_NONE, enabled = true, found = null } = {}) {
    const ILAP = load();
    const n = new ILAP.ManualIgnore.AiPageNote({
        pageAppid: appid,
        isEnabled: () => enabled,
        aiGames: async (k) => ILAP.aiGames(DATA, k),
        aiKinds: async () => ILAP.aiKinds(DATA),
        disclosure: () => found,
        rules: ILAP.AiDisclosure,
        nameOf: () => 'Race or Crash',
        place: () => null,
        header: () => null,
        fit: () => {},
        setCollapsed: () => {},
        label: (k) => k,
        t: (k) => k,
        lang: () => 'en',
        reduceMotion: () => true,
    });
    n.setOptions({ level, keep });
    return n;
}
const page = (text) => ({ block: {}, heading: 'AI Generated Content Disclosure', text });

test.describe('ManualIgnore — the AI note on a game page (unit)', () => {
    test('a listed game shows with the kind the lists know, with or without a disclosure on its page', async () => {
        expect(await note({ appid: '10' }).verdict()).toEqual({ kind: 'ai', found: null });
        expect((await note({ appid: '20', found: page('Translated with DeepL.') }).verdict()).kind).toBe('translation');
        expect((await note({ appid: '30' }).verdict()).kind).toBe('ingame');
    });

    test('a game the lists mark by hand shows as manual, the boxes keep it in', async () => {
        expect(await note({ appid: '40' }).verdict()).toEqual({ kind: 'manual', found: null });
        expect((await note({ appid: '40', keep: KEEP_BOTH }).verdict()).kind).toBe('manual');
    });

    test('a game whose disclosure was removed shows as removed, the boxes go by its last text', async () => {
        expect(await note({ appid: '50' }).verdict()).toEqual({ kind: 'removed', found: null });
        expect((await note({ appid: '60' }).verdict()).kind).toBe('removed');
        expect((await note({ appid: '50', keep: KEEP_BOTH }).verdict()).kind).toBe('removed');
        expect(await note({ appid: '60', keep: KEEP_BOTH }).verdict()).toBe(null);
    });

    test('a disclosure back on the page of a removed game makes it an AI game again', async () => {
        const found = page('All art was generated with AI.');
        expect(await note({ appid: '50', found }).verdict()).toEqual({ kind: 'ai', found });
    });

    test('a box that keeps a listed game keeps its note away, as it keeps its capsules unflagged', async () => {
        expect(await note({ appid: '20', keep: KEEP_BOTH }).verdict()).toBe(null);
        expect(await note({ appid: '30', keep: KEEP_BOTH }).verdict()).toBe(null);
        expect((await note({ appid: '10', keep: KEEP_BOTH }).verdict()).kind).toBe('ai');
    });

    test('a game newer than the lists shows by its page\'s disclosure, its kind by the word rules', async () => {
        expect(await note({ appid: '99' }).verdict()).toBe(null);
        expect(await note({ appid: '99', found: page('') }).verdict()).toBe(null);
        expect((await note({ appid: '99', found: page('All art was generated with AI.') }).verdict()).kind).toBe('ai');
        expect((await note({ appid: '99', found: page('Characters talk with you through an LLM in real time.') }).verdict()).kind)
            .toBe('ingame');
        expect((await note({ appid: '99', found: page('The game was translated into Japanese with DeepL.') }).verdict()).kind)
            .toBe('translation');
        // The boxes keep those too.
        expect(await note({ appid: '99', keep: KEEP_BOTH, found: page('The game was translated into Japanese with DeepL.') }).verdict())
            .toBe(null);
    });

    test('nothing at Off or with the master off; High shows it like Low', async () => {
        expect(await note({ level: 0 }).verdict()).toBe(null);
        expect(await note({ enabled: false }).verdict()).toBe(null);
        expect((await note({ level: HIGH }).verdict()).kind).toBe('ai');
    });

    test('the note is folded only when the stored choice is true', () => {
        const n = note();
        expect(n.collapsed).toBe(false);
        for (const [v, want] of [[true, true], [false, false], [undefined, false], ['true', false], [1, false]]) {
            n.setOptions({ level: LOW, keep: KEEP_NONE, collapsed: v });
            expect(n.collapsed).toBe(want);
        }
    });

    test('every hook is required', () => {
        const ILAP = load();
        expect(() => new ILAP.ManualIgnore.AiPageNote({})).toThrow(/AiPageNote needs deps\./);
        const ok = {
            pageAppid: '10', isEnabled: () => true, aiGames: async () => new Set(), aiKinds: async () => new Map(),
            disclosure: () => null, rules: ILAP.AiDisclosure, nameOf: () => '', place: () => null,
            header: () => null, fit: () => {}, setCollapsed: () => {}, label: (k) => k, t: (k) => k,
            lang: () => 'en', reduceMotion: () => true,
        };
        expect(() => new ILAP.ManualIgnore.AiPageNote(ok)).not.toThrow();
        for (const fn of ['header', 'fit', 'setCollapsed', 't']) {
            expect(() => new ILAP.ManualIgnore.AiPageNote(Object.assign({}, ok, { [fn]: undefined }))).toThrow(new RegExp('deps\\.' + fn + '$'));
        }
        expect(() => new ILAP.ManualIgnore.AiPageNote(Object.assign({}, ok, { pageAppid: 'x' }))).toThrow(/pageAppid/);
        expect(() => new ILAP.ManualIgnore.AiPageNote(Object.assign({}, ok, { rules: {} }))).toThrow(/rules/);
    });
});
