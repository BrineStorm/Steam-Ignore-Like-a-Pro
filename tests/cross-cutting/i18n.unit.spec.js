const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// i18n contract (src/i18n.js) as a Node unit — no browser. Guards the three
// things the E2E language specs (en/ru/de DOM relabel) can't see:
//  1. per-locale DICT completeness — a key missing in one locale silently
//     falls back to English at runtime, so no E2E ever fails on it;
//  2. placeholder integrity — `{n}` / `{type}` must survive verbatim in every
//     translation or substitution breaks only in that locale;
//  3. the t() fallback ladder itself (locale → en → raw key) and setLang's
//     unknown-code fallback.

function loadI18n() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'i18n.js'),
        'utf8'
    );
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP;
}

const placeholders = (s) => (String(s).match(/\{\w+\}/g) || []).sort();

test.describe('i18n — dictionary integrity (unit)', () => {
    const { i18n } = loadI18n();
    const DICT = i18n.DICT;
    const enKeys = Object.keys(DICT.en);

    test('every locale carries every en key (no silent English fallback)', () => {
        for (const loc of Object.keys(DICT)) {
            const missing = enKeys.filter(k => !Object.prototype.hasOwnProperty.call(DICT[loc], k));
            expect(missing, `${loc} is missing keys`).toEqual([]);
        }
    });

    test('no locale carries keys unknown to en (catches typo\'d key names)', () => {
        for (const loc of Object.keys(DICT)) {
            const extra = Object.keys(DICT[loc]).filter(k => !Object.prototype.hasOwnProperty.call(DICT.en, k));
            expect(extra, `${loc} has extra keys`).toEqual([]);
        }
    });

    test('placeholders ({n}, {type}, …) survive verbatim in every translation', () => {
        // Derived from en, so a new placeholder key is guarded automatically.
        const keysWithPh = enKeys.filter(k => placeholders(DICT.en[k]).length > 0);
        expect(keysWithPh.length).toBeGreaterThan(0); // sanity: dq_cap_reached & toasts
        for (const key of keysWithPh) {
            const want = placeholders(DICT.en[key]);
            for (const loc of Object.keys(DICT)) {
                expect(placeholders(DICT[loc][key]), `${loc}.${key}`).toEqual(want);
            }
        }
    });

    test('every LANGUAGES entry has a DICT bundle (picker never offers a dead locale)', () => {
        const dead = i18n.getLanguages().filter(l => !l.translated).map(l => l.code);
        expect(dead).toEqual([]);
    });
});

test.describe('i18n — t() contract (unit)', () => {

    test('t() resolves from the current locale after setLang', () => {
        const { t, i18n } = loadI18n();
        i18n.setLang('ru');
        expect(t('total_ignored')).toBe(i18n.DICT.ru.total_ignored);
        i18n.setLang('de');
        expect(t('total_ignored')).toBe(i18n.DICT.de.total_ignored);
    });

    test('a key present in en but not in the locale falls back to the en string', () => {
        const { t, i18n } = loadI18n();
        // The shipped DICT is complete (asserted above), so simulate the gap.
        i18n.DICT.en.__test_only = 'english only';
        i18n.setLang('de');
        expect(t('__test_only')).toBe('english only');
    });

    test('an unknown key comes back as the raw key', () => {
        const { t, i18n } = loadI18n();
        i18n.setLang('ru');
        expect(t('__no_such_key__')).toBe('__no_such_key__');
    });

    test('setLang with an unknown code falls back to en', () => {
        const { t, i18n } = loadI18n();
        i18n.setLang('xx');
        expect(i18n.getLang()).toBe('en');
        expect(t('total_ignored')).toBe(i18n.DICT.en.total_ignored);
    });

    test('onLangChange fires only on an effective change, with the new code', () => {
        // The live-redraw mechanism for content-script UIs (curator button, DQ
        // panel): subscribers re-render when the effective language changes.
        const { i18n } = loadI18n();
        const seen = [];
        i18n.onLangChange((code) => seen.push(code));
        i18n.setLang('ru');
        i18n.setLang('ru');   // same effective language → no notification
        i18n.setLang('xx');   // unknown → en, which IS a change from ru
        expect(seen).toEqual(['ru', 'en']);
    });

    test('a throwing subscriber does not block the others', () => {
        const { i18n } = loadI18n();
        const seen = [];
        i18n.onLangChange(() => { throw new Error('boom'); });
        i18n.onLangChange((code) => seen.push(code));
        i18n.setLang('de');
        expect(seen).toEqual(['de']);
    });

    test('params substitution replaces every occurrence and leaves no braces', () => {
        const { t, i18n } = loadI18n();
        for (const loc of ['en', 'ru', 'ja']) {
            i18n.setLang(loc);
            const cap = t('dq_cap_reached', { n: 42 });
            expect(cap, `${loc} dq_cap_reached`).toContain('42');
            expect(cap, `${loc} dq_cap_reached`).not.toContain('{n}');
            const toast = t('curator_toast_added', { type: 'XKindX' });
            expect(toast, `${loc} curator_toast_added`).toContain('XKindX');
            expect(toast, `${loc} curator_toast_added`).not.toContain('{type}');
        }
    });
});
