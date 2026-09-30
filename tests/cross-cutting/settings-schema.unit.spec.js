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
