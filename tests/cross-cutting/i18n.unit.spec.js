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

    test('offLangChange retires a subscriber, and the rest still fire', () => {
        // A UI that can be taken off the page and put back needs this: the curator
        // button is removed and re-injected on every master-toggle flip, and one
        // subscription left behind per flip is a subscription that accumulates.
        const { i18n } = loadI18n();
        const seen = [];
        const leaving = () => seen.push('gone');
        i18n.onLangChange(leaving);
        i18n.onLangChange(() => seen.push('stays'));

        i18n.offLangChange(leaving);
        i18n.setLang('ru');
        expect(seen).toEqual(['stays']);

        // Unsubscribing something that never subscribed is a no-op, not a splice
        // of whatever sits at index -1.
        i18n.offLangChange(() => {});
        i18n.setLang('de');
        expect(seen).toEqual(['stays', 'stays']);
    });

    test('a subscriber that unsubscribes mid-notify does not skip its neighbour', () => {
        // setLang walks a COPY for exactly this: splicing the live array from
        // inside the walk would slide the next subscriber past the index.
        const { i18n } = loadI18n();
        const seen = [];
        const first = () => { seen.push('first'); i18n.offLangChange(first); };
        i18n.onLangChange(first);
        i18n.onLangChange(() => seen.push('second'));

        i18n.setLang('ru');
        expect(seen).toEqual(['first', 'second']);
        i18n.setLang('de');
        expect(seen).toEqual(['first', 'second', 'second']);
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

// The dictionary vs. the code that reaches into it. The specs above prove the 19
// bundles agree with each other; these two prove they agree with the product —
// the direction a locale-only diff (a key renamed, a hint deleted) breaks. Neither
// failure can show up in an E2E: an unknown key renders as the raw key name, which
// no assertion looks at, and a dead key renders as nothing at all.
function sourceFiles() {
    const root = path.join(__dirname, '..', '..');
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(js|html)$/.test(e.name)) out.push(p);
        }
    };
    walk(path.join(root, 'src'));
    walk(path.join(root, 'ui'));
    return out.filter(p => !/i18n\.js$/.test(p));   // the dictionary itself is not a reference
}

test.describe('i18n — dictionary vs. the code (unit)', () => {
    const { i18n } = loadI18n();
    const enKeys = Object.keys(i18n.DICT.en);
    const files = sourceFiles();

    test('every key the code asks for exists (no string rendered as its own key name)', () => {
        const unknown = [];
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            const refs = [
                ...src.matchAll(/data-i18n=["']([\w-]+)["']/g),
                ...src.matchAll(/\bt\(\s*'([a-z0-9_]+)'/g),
            ];
            for (const m of refs) {
                if (!enKeys.includes(m[1])) unknown.push(`${m[1]} @ ${path.basename(file)}`);
            }
        }
        expect(unknown, 'keys referenced but not in DICT.en').toEqual([]);
    });

    test('no key outlives its last use (a dead string costs 19 translations)', () => {
        // Substring match, not the reference patterns above: a key assembled at
        // runtime must count as used, and its literal half still appears verbatim.
        const all = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
        expect(enKeys.filter(k => !all.includes(k)), 'keys in DICT.en nothing references').toEqual([]);
    });
});
