const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Sanitizer.sanitizeName (src/escape.js) is the storage-boundary normalizer for
// names captured from Steam's DOM (game titles, curator names). It's pure, so we
// load escape.js in Node (vm + a window stub) and assert the contract — no
// browser, no Steam. Mirrors the enumerate/decision-matrix unit pattern.
function loadILAP() {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'escape.js'), 'utf8'), sandbox);
    const Sanitizer = sandbox.window.ILAP.Sanitizer;
    return { sanitizeName: Sanitizer.sanitizeName, Sanitizer, serialChain: sandbox.window.ILAP.serialChain };
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

    test('strips bidi overrides and isolates, keeps the joiners real names need', () => {
        // \p{Cc} does not cover \p{Cf}, and a name is third-party text: an
        // unterminated RLO reverses the text AROUND it wherever the name is shown
        // (the popup history, the badge tooltip). Cosmetic — nothing decides on a
        // name — but it is spoofing, and it is free to cut.
        const RLO = '‮', LRE = '‪', PDF = '‬';
        const LRI = '⁦', PDI = '⁩', RLM = '‏';
        expect(ILAP.sanitizeName('Portal' + RLO + ' 2')).toBe('Portal 2');
        expect(ILAP.sanitizeName(LRI + 'Half-Life' + PDI)).toBe('Half-Life');
        expect(ILAP.sanitizeName('a' + RLM + LRE + PDF + 'b')).toBe('ab');

        // NOT all of \p{Cf}: ZWJ and ZWNJ live there too and carry meaning, so
        // cutting them would corrupt legitimate names rather than protect them.
        const ZWJ = '‍', ZWNJ = '‌';
        expect(ILAP.sanitizeName('क्' + ZWJ + 'ष')).toBe('क्' + ZWJ + 'ष');
        expect(ILAP.sanitizeName('a' + ZWNJ + 'b')).toBe('a' + ZWNJ + 'b');
        // An emoji ZWJ sequence stays one glyph.
        expect(ILAP.sanitizeName('\u{1F468}' + ZWJ + '\u{1F4BB}')).toBe('\u{1F468}' + ZWJ + '\u{1F4BB}');
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

// ILAP.serialChain (src/escape.js): the one write chain every storage module in
// every world builds its read-modify-writes on.
test.describe('serialChain (unit)', () => {
    const tick = () => new Promise(r => setTimeout(r, 0));

    test('runs one at a time in call order, even when an earlier one is slower', async () => {
        const serial = loadILAP().serialChain();
        const order = [];
        const slow = serial(async () => { await tick(); await tick(); order.push('slow'); return 1; });
        const fast = serial(async () => { order.push('fast'); return 2; });
        expect(await Promise.all([slow, fast])).toEqual([1, 2]);
        expect(order).toEqual(['slow', 'fast']);
    });

    test('a failure reaches its own caller and does not wedge the chain', async () => {
        const serial = loadILAP().serialChain();
        const failed = serial(async () => { throw new Error('write failed'); });
        const next = serial(async () => 'still runs');
        await expect(failed).rejects.toThrow('write failed');
        expect(await next).toBe('still runs');
    });

    test('each chain is its own: one module waiting does not hold up another', async () => {
        const ILAP = loadILAP();
        const a = ILAP.serialChain(), b = ILAP.serialChain();
        let release;
        a(() => new Promise(r => { release = r; }));
        expect(await b(async () => 'b done')).toBe('b done');
        release();
    });
});

