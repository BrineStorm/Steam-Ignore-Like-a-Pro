const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ReviewAnalyzer.classify (src/explore-queue/utils.js) is the fail-safe gate that
// turns resolved review-summary colours into an IGNORE / SPARE / NO_REVIEWS state.
// classify() is now pure (takes an array of colour strings, no DOM), so load
// utils.js in Node (vm + window stub) and assert the contract directly.
function loadExplore() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'explore-queue', 'utils.js'),
        'utf8'
    );
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.Explore;
}

test.describe('Explore Queue — ReviewAnalyzer.classify fail-safe (unit)', () => {
    const Explore = loadExplore();
    const { Analyzer, COLORS } = Explore;

    test('no rows → NO_REVIEWS (never ignores on missing data)', () => {
        expect(Analyzer.classify([], COLORS)).toBe('NO_REVIEWS');
        expect(Analyzer.classify(null, COLORS)).toBe('NO_REVIEWS');
    });

    test('all-blue (positive) rows → SPARE', () => {
        expect(Analyzer.classify([COLORS.BLUE], COLORS)).toBe('SPARE');
        expect(Analyzer.classify([COLORS.BLUE, COLORS.BLUE], COLORS)).toBe('SPARE');
    });

    test('a known bad (Mixed/Negative) colour → IGNORE', () => {
        expect(Analyzer.classify([COLORS.MIXED], COLORS)).toBe('IGNORE');
        expect(Analyzer.classify([COLORS.NEGATIVE], COLORS)).toBe('IGNORE');
        expect(Analyzer.classify([COLORS.BLUE, COLORS.NEGATIVE], COLORS)).toBe('IGNORE');
    });

    test('FAIL-SAFE: an UNKNOWN colour (e.g. Steam theme change) → SPARE, not IGNORE', () => {
        // A shade that matches neither BLUE nor the known bad colours. The old
        // "not blue → IGNORE" logic would have mass-ignored these; the fail-safe
        // must spare them.
        expect(Analyzer.classify(['rgb(1, 2, 3)'], COLORS)).toBe('SPARE');
        expect(Analyzer.classify([COLORS.GRAY], COLORS)).toBe('SPARE');
        expect(Analyzer.classify(['rgb(1, 2, 3)', 'rgb(4, 5, 6)'], COLORS)).toBe('SPARE');
    });

    test('end-to-end with DecisionEngine: unknown colour is spared in bad mode', () => {
        const state = Analyzer.classify(['rgb(1, 2, 3)'], COLORS);
        expect(Explore.DecisionEngine.decide(state, 'bad')).toBe('SHOULD_SPARE');
    });
});
