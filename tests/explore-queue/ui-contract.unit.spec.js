// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The Queue Helper's toast is drawn into Steam's own page, which makes it the
// one surface where the page is a party to the conversation. Two rules come out
// of that, and neither is visible from a screenshot:
//
//   1. its controls answer to real input only. Run starts an unattended ignore
//      run, Fast-forward walks the queue, Disable writes a setting — a page
//      script calling .click() on any of them must get nothing. The master
//      switch and the rate gate are checked LATER and would let a forged click
//      through;
//   2. it reaches its own nodes through its own subtree. A page carrying an
//      element with the same id used to take the handler while the real button
//      sat dead, because the toast looked its children up by document id.
//
// Both were live defects, both are one careless edit away from returning, and
// the E2E suite cannot see either: Playwright's clicks are trusted, and a
// decoy-id page is not something a live store page provides.

const UI_SRC = path.join(__dirname, '..', '..', 'src', 'explore-queue', 'ui.js');

function loadUI() {
    const sandbox = {
        window: { ILAP: { Sanitizer: { escapeHTML: (s) => String(s) }, t: (k) => k, Explore: {} } },
        document: { getElementById: () => null, querySelectorAll: () => [] },
        Object, Array, String, Math, Date, WeakMap,
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(UI_SRC, 'utf8'), sandbox, { filename: 'ui.js' });
    return sandbox.window.ILAP.Explore.UI;
}

test.describe('Explore Queue toast — contract with the page it lives in (unit)', () => {

    test('a handler wrapped for real input ignores a forged event', () => {
        const ActionUI = loadUI();
        const seen = [];
        const handler = ActionUI._real((e) => seen.push(e));

        handler({ isTrusted: false });                 // a page script's .click()
        handler({});                                   // no flag at all
        handler(undefined);                            // called with no event
        expect(seen, 'a forged event must not reach the handler').toEqual([]);

        const real = { isTrusted: true };
        handler(real);
        expect(seen).toEqual([real]);
    });

    test('every control in the toast is wrapped, and none is looked up by document id', () => {
        // Read as source rather than driven through a DOM: what matters is that
        // no handler is EVER assigned bare, and a fake DOM would only prove it
        // for the paths the fake happens to reach.
        const src = fs.readFileSync(UI_SRC, 'utf8');

        // `onclick = something` must be `onclick = ActionUI._real(...)`. The
        // hover handlers (onmouseenter/leave) only restyle and are exempt.
        const clickAssignments = [...src.matchAll(/\.onclick\s*=\s*([^\n]+)/g)].map(m => m[1].trim());
        expect(clickAssignments.length, 'no click handlers found — did the toast move?')
            .toBeGreaterThan(3);
        expect(clickAssignments.filter(a => !a.startsWith('ActionUI._real(')),
            'a toast control was wired without the real-input guard').toEqual([]);

        // The toast is appended to document.body, so a document-wide lookup can
        // resolve to the page's node instead of ours.
        const globalLookups = [...src.matchAll(/document\.(getElementById|querySelector|querySelectorAll)\(/g)]
            .map(m => m[0]);
        expect(globalLookups, 'reach the toast through its own node, not the document').toEqual([]);
    });
});
