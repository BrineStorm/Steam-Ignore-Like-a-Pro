const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// What the curator button's menu says (src/curator/menu.js), from the queue's
// state. Real filters and the real escaper. Its mouse and keyboard run live in
// tests/curator/enqueue.spec.js.

function loadMenu(t) {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    for (const file of ['escape.js', 'curator/filters.js', 'curator/menu.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', file), 'utf8'), sandbox);
    }
    const W = sandbox.window;
    return W.ILAP.Curator.createButtonMenu({
        t: t || ((key) => key), esc: W.ILAP.Sanitizer.escapeHTML, filters: W.ILAP_Filters,
    });
}

// One row's markup by its filter value.
const rowOf = (html, value) => {
    const at = html.indexOf(`data-value="${value}"`);
    expect(at).toBeGreaterThan(-1);
    const open = html.lastIndexOf('<div', at);
    const next = html.indexOf('<div class="ilap-curator-opt', at);
    return html.slice(open, next < 0 ? undefined : next);
};

const NR = 'not_recommended', INF = 'informational', BOTH = 'all_but_recommended';

test.describe('Curator button menu — what its rows say (unit)', () => {
    test('with nothing queued every row takes a pick', () => {
        const html = loadMenu().rowsHtml(new Set(), new Set(), 0);
        for (const value of [NR, INF, BOTH]) {
            const row = rowOf(html, value);
            expect(row).not.toMatch(/ active| locked|aria-disabled|ilap-opt-pill|ilap-opt-del/);
        }
        expect(html).not.toContain('ilap-curator-warn');
    });

    test('a queued filter wears the pill and the cross, and what it covers is locked', () => {
        const html = loadMenu().rowsHtml(new Set([BOTH]), new Set([NR, INF]), 0);
        const own = rowOf(html, BOTH);
        expect(own).toContain('ilap-curator-opt active');
        expect(own).toContain('ilap-opt-pill');
        expect(own).toContain('data-act="remove"');
        for (const value of [NR, INF]) {
            const row = rowOf(html, value);
            expect(row).toContain('ilap-curator-opt locked');
            expect(row).toContain('aria-disabled="true"');
            expect(row).not.toContain('ilap-opt-del');
        }
    });

    test('with one review type queued the other one stays open', () => {
        const html = loadMenu().rowsHtml(new Set([NR]), new Set([NR]), 0);
        expect(rowOf(html, NR)).toContain('active');
        // Picking either of these adds what the queue lacks: Informational.
        expect(rowOf(html, INF)).not.toMatch(/ active| locked/);
        expect(rowOf(html, BOTH)).not.toMatch(/ active| locked/);
    });

    test('the re-stage warning shows only with nothing queued, in whole hours from one', () => {
        const hours = [];
        const menu = loadMenu((key, params) => {
            if (params && 'h' in params) hours.push(params.h);
            return key;
        });
        expect(menu.rowsHtml(new Set(), new Set(), 5 * 60 * 1000)).toContain('ilap-curator-warn');
        menu.rowsHtml(new Set(), new Set(), 3 * 3600000);
        expect(hours).toEqual([1, 3]);
        expect(menu.rowsHtml(new Set([NR]), new Set([NR]), 3600000)).not.toContain('ilap-curator-warn');
        expect(menu.rowsHtml(new Set(), new Set(), 0)).not.toContain('ilap-curator-warn');
    });

    test('a translation with markup in it is escaped everywhere it lands', () => {
        const evil = '<img src=x onerror=alert(1)>"';
        const html = loadMenu(() => evil).rowsHtml(new Set([NR]), new Set([NR]), 3600000);
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
        // The cross's attributes close where they should.
        const own = rowOf(html, NR);
        expect((own.match(/aria-label="/g) || []).length).toBe(1);
        expect(own).not.toMatch(/aria-label="[^"]*"[^ >]/);
    });
});
