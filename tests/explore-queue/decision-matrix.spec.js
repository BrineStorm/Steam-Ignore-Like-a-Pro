const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// DecisionEngine (src/explore-queue/utils.js) is a PURE static class. The old
// version drove it from page context via window.ILAP.Explore — but content
// scripts run in the isolated world, invisible to page.evaluate. Since the logic
// has zero DOM/browser dependency, load it directly in Node (vm + a window stub)
// and assert the contract. No browser, no Steam login, fast.
function loadDecisionEngine() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'explore-queue', 'utils.js'),
        'utf8'
    );
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.Explore.DecisionEngine;
}

// reviewState comes from ReviewAnalyzer.classify:
//   - 'IGNORE'     → at least one Mixed/Negative (non-Blue) status row
//   - 'SPARE'      → only Mostly/Very Positive (all-Blue) rows
//   - 'NO_REVIEWS' → no usable rows
test.describe('Explore Queue — DecisionEngine decision matrix (unit)', () => {
    const DE = loadDecisionEngine();

    test('bad mode: only IGNORE is ignored; SPARE / NO_REVIEWS are spared', () => {
        expect(DE.decide('SPARE', 'bad')).toBe('SHOULD_SPARE');
        expect(DE.decide('IGNORE', 'bad')).toBe('SHOULD_IGNORE');
        expect(DE.decide('NO_REVIEWS', 'bad')).toBe('SHOULD_SPARE');
    });

    test('all mode: everything is ignored regardless of review state', () => {
        expect(DE.decide('SPARE', 'all')).toBe('SHOULD_IGNORE');
        expect(DE.decide('IGNORE', 'all')).toBe('SHOULD_IGNORE');
        expect(DE.decide('NO_REVIEWS', 'all')).toBe('SHOULD_IGNORE');
    });

    test('unknown mode falls back to the bad-mode strategy (never mass-ignore)', () => {
        expect(DE.decide('SPARE', 'gibberish')).toBe('SHOULD_SPARE');
        expect(DE.decide('IGNORE', 'gibberish')).toBe('SHOULD_IGNORE');
    });
});
