// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const vm = require('vm');
const { loadSettingsSchema } = require('../_settings-schema.js');

// src/settings-schema.js: the one place a setting's key, default and reading
// rule live. Every reader in all three worlds goes through it, so a slip here
// is a slip everywhere — and the readers used to disagree on exactly these
// rules (a missing key read as off in one module, on in another).
function loadSchema() {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    loadSettingsSchema(sandbox);
    return sandbox.window.ILAP.Settings;
}

test.describe('Settings schema (unit)', () => {

    test('isOn: only an explicit false turns a switch off', () => {
        const S = loadSchema();
        expect(S.isOn(false)).toBe(false);
        // A key never written (fresh install) or cleared is ON.
        expect(S.isOn(undefined)).toBe(true);
        expect(S.isOn(null)).toBe(true);
        expect(S.isOn(true)).toBe(true);
    });

    test('normalizeShortcut maps the legacy values and clamps the rest, like normalizeUnignore', () => {
        const S = loadSchema();
        expect(S.normalizeShortcut('swipeRightRight')).toBe('swipeRight');
        expect(S.normalizeShortcut('swipeRightLeft')).toBe('swipeLeft');
        for (const v of S.BINDINGS.concat(S.OFF)) expect(S.normalizeShortcut(v)).toBe(v);
        // Unclamped, a value from no build we shipped reached `event[key]` as
        // undefined — a gesture dead with no symptom — and a <select> with no
        // such option, i.e. blank. null means "keep what you have".
        expect(S.normalizeShortcut('bogus')).toBe(null);
        expect(S.normalizeShortcut(undefined)).toBe(null);
        expect(S.normalizeShortcut('__proto__')).toBe(null);
    });

    test('normalizeUnignore accepts the offered values only, else null (the reader keeps its binding)', () => {
        const S = loadSchema();
        for (const v of S.UNIGNORE_KEYS) expect(S.normalizeUnignore(v)).toBe(v);
        expect(S.normalizeUnignore('swipeRightRight')).toBe(null);   // no legacy values for this key
        expect(S.normalizeUnignore('bogus')).toBe(null);
        expect(S.normalizeUnignore(undefined)).toBe(null);
    });

    test('the vocabulary holds together: defaults are offered values, OFF closes the un-ignore list', () => {
        const S = loadSchema();
        expect(S.UNIGNORE_KEYS).toEqual(S.BINDINGS.concat(S.OFF));
        for (const k of ['SHORTCUT', 'PLATFORM', 'UNIGNORE']) {
            expect(S.BINDINGS).toContain(S.DEFAULTS[k]);
        }
        // The three defaults are three different gestures: one gesture cannot
        // start two actions on a fresh install.
        expect(new Set([S.DEFAULTS.SHORTCUT, S.DEFAULTS.PLATFORM, S.DEFAULTS.UNIGNORE]).size).toBe(3);
        expect(Object.values(S.Q_MODES)).toContain(S.DEFAULTS.Q_MODE);
    });

    test('normalizeAiLevel stores Off to High only: none stored, Max, a fraction or junk reads as Low, the default', () => {
        const S = loadSchema();
        const L = S.AI_LEVELS;
        expect([L.OFF, L.LOW, L.MEDIUM, L.HIGH, L.MAX]).toEqual([0, 1, 2, 3, 4]);
        for (const v of [L.OFF, L.LOW, L.MEDIUM, L.HIGH]) expect(S.normalizeAiLevel(v)).toBe(v);
        // Max is the joke on the slider and is never stored; a stored one is Low.
        for (const v of [L.MAX, 5, -1, 1.5, '2', null, undefined, NaN, true]) {
            expect(S.normalizeAiLevel(v)).toBe(L.LOW);
        }
    });

    test('the boxes each stored level sets: Low clears both, Medium and High tick both, Off has none', () => {
        const S = loadSchema();
        const L = S.AI_LEVELS;
        expect(S.AI_LEVEL_KEEP[L.LOW]).toEqual({ translation: false, ingame: false });
        expect(S.AI_LEVEL_KEEP[L.MEDIUM]).toEqual({ translation: true, ingame: true });
        expect(S.AI_LEVEL_KEEP[L.HIGH]).toEqual({ translation: true, ingame: true });
        expect(S.AI_LEVEL_KEEP[L.OFF]).toBeUndefined();
        expect(S.AI_LEVEL_KEEP[L.MAX]).toBeUndefined();
        expect(Object.isFrozen(S.AI_LEVEL_KEEP)).toBe(true);
        expect(Object.isFrozen(S.AI_LEVEL_KEEP[L.MEDIUM])).toBe(true);
    });

    test('normalizeShot keeps an offered style, anything else is the default crossed-out AI', () => {
        const S = loadSchema();
        expect(S.SHOTS).toEqual(['emoji', 'swipe', 'ai', 'tomato', 'random']);
        expect(S.DEFAULTS.AI_SHOT).toBe('ai');
        for (const v of S.SHOTS) expect(S.normalizeShot(v)).toBe(v);
        // A style no shipped build offers ('bullet'), the 67 that is no style to
        // pick any more, a wrong case or a number.
        for (const v of ['bullet', '67', 'Swipe', '', null, undefined, 67]) {
            expect(S.normalizeShot(v)).toBe(S.DEFAULTS.AI_SHOT);
        }
        expect(Object.isFrozen(S.SHOTS)).toBe(true);
    });

    test('normalizeShotEmoji keeps an emoji of the grid, anything else is the thumbs down', () => {
        const S = loadSchema();
        expect(S.SHOT_EMOJI).toHaveLength(20);
        expect(new Set(S.SHOT_EMOJI).size).toBe(20);
        expect(S.SHOT_EMOJI[0]).toBe(S.DEFAULTS.AI_SHOT_EMOJI);
        expect(S.DEFAULTS.AI_SHOT_EMOJI).toBe('\u{1F44E}');
        for (const v of S.SHOT_EMOJI) expect(S.normalizeShotEmoji(v)).toBe(v);
        // Not in the grid: another emoji, the trash can without its variation
        // selector, text, nothing, a number.
        for (const v of ['\u{1F600}', '\u{1F5D1}', 'x', '', null, undefined, 1]) {
            expect(S.normalizeShotEmoji(v)).toBe(S.DEFAULTS.AI_SHOT_EMOJI);
        }
        expect(Object.isFrozen(S.SHOT_EMOJI)).toBe(true);
    });

    test('every key is an ilap_ key and none repeats', () => {
        const keys = Object.values(loadSchema().KEYS);
        for (const k of keys) expect(k).toMatch(/^ilap_/);
        expect(new Set(keys).size).toBe(keys.length);
    });

    test('the schema is frozen: no reader can rewrite a key or a default for the others', () => {
        const S = loadSchema();
        expect(Object.isFrozen(S)).toBe(true);
        expect(Object.isFrozen(S.KEYS)).toBe(true);
        expect(Object.isFrozen(S.DEFAULTS)).toBe(true);
        expect(Object.isFrozen(S.BINDINGS)).toBe(true);
    });
});
