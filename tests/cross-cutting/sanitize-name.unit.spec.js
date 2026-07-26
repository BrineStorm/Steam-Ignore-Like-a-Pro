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
    // escape.js owns the shared string helpers (escapeHTML + sanitizeName) for
    // all three worlds, stats.js the Last-Ignored record shape for the two that
    // write it, steam-net.js the Steam reads for the two that fetch; all three
    // load before utils.js wherever it runs — the sandbox mirrors that.
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'escape.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'stats.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'steam-net.js'), 'utf8'), sandbox);
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

test.describe('escapeHTML — render boundary escaper (unit)', () => {
    const esc = loadILAP().Sanitizer.escapeHTML;

    test('escapes every character that could open markup or break an attribute', () => {
        expect(esc('<img src=x onerror=alert(1)>'))
            .toBe('&lt;img src=x onerror=alert(1)&gt;');
        expect(esc(`"' & <>`)).toBe('&quot;&#039; &amp; &lt;&gt;');
        // The ampersand goes first, so an escaped entity is not re-escaped.
        expect(esc('a & <b>')).toBe('a &amp; &lt;b&gt;');
    });

    test('only null/undefined become the empty string — a real 0 or false survives', () => {
        // Callers escape counts ("0 skipped"), and the earlier falsy guard
        // silently swallowed the zero.
        expect(esc(0)).toBe('0');
        expect(esc(false)).toBe('false');
        expect(esc('')).toBe('');
        expect(esc(null)).toBe('');
        expect(esc(undefined)).toBe('');
    });
});
