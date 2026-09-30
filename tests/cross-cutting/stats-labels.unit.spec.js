// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The Last-Ignored history labels (src/stats.js): one table for every source,
// and the MI reason → label mapping both drain hosts use.
function loadStats() {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'stats.js'), 'utf8'), sandbox);
    return sandbox.window.ILAP.StatsLogic;
}

test.describe('StatsLogic history labels (unit)', () => {

    test('miSourceLabel maps an MI reason to its Last-Ignored label', () => {
        const S = loadStats();
        // Reason 2 is the Played Elsewhere swipe, everything else the default.
        expect(S.miSourceLabel(2)).toBe('Played Elsewhere');
        expect(S.miSourceLabel('2')).toBe('Played Elsewhere');   // meta survives a JSON round-trip
        expect(S.miSourceLabel(0)).toBe('Default Ignore');
        expect(S.miSourceLabel(undefined)).toBe('Default Ignore');
    });

    test('the stored labels keep their exact spelling', () => {
        // They sit in users' history already: a rename would split it in two.
        expect({ ...loadStats().SOURCE }).toEqual({
            EQ: 'Explore Auto-Queue',
            DQ: 'Queue',
            MI_DEFAULT: 'Default Ignore',
            MI_PLAYED: 'Played Elsewhere',
        });
    });
});
