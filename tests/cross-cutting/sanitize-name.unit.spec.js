const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// window.ILAP.sanitizeName (src/utils.js) is the storage-boundary normalizer for
// names captured from Steam's DOM (game titles, curator names). It's pure, so we
// load utils.js in Node (vm + a window stub) and assert the contract — no
// browser, no Steam. Mirrors the enumerate/decision-matrix unit pattern.
function loadILAP() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'utils.js'),
        'utf8'
    );
    const sandbox = { window: {}, document: { cookie: '' } };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP;
}

test.describe('sanitizeName — storage boundary normalizer (unit)', () => {
    const ILAP = loadILAP();

    test('strips tag delimiters so a name cannot carry markup', () => {
        // The XSS payload survives only as inert text — no '<' or '>' remain, so a
        // render path that forgot to escape still couldn't form a tag.
        expect(ILAP.sanitizeName('<img src=x onerror=alert(1)>')).toBe('img src=x onerror=alert(1)');
        expect(ILAP.sanitizeName('Portal <2>')).toBe('Portal 2');
        expect(ILAP.sanitizeName('a<script>b')).not.toContain('<');
    });

    test('drops control chars and collapses whitespace', () => {
        expect(ILAP.sanitizeName('Half\tLife\n\n2')).toBe('Half Life 2');
        expect(ILAP.sanitizeName('  spaced   out  ')).toBe('spaced out');
        // A NUL byte is a control char but not \s — verifies the \p{Cc} strip.
        expect(ILAP.sanitizeName('a' + String.fromCharCode(0) + 'b')).toBe('a b');
    });

    test('clamps length to the cap', () => {
        expect(ILAP.sanitizeName('A'.repeat(500)).length).toBe(120);
        expect(ILAP.sanitizeName('AB'.repeat(500), 10).length).toBe(10);
    });

    test('handles null / undefined / non-string', () => {
        expect(ILAP.sanitizeName(null)).toBe('');
        expect(ILAP.sanitizeName(undefined)).toBe('');
        expect(ILAP.sanitizeName(12345)).toBe('12345');
    });

    test('leaves an ordinary game name untouched', () => {
        expect(ILAP.sanitizeName('Counter-Strike 2')).toBe('Counter-Strike 2');
    });
});
