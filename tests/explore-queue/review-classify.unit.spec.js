const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ReviewAnalyzer.classify (src/explore-queue/utils.js) is the fail-safe gate that
// turns resolved review-summary colours into an IGNORE / SPARE / NO_REVIEWS state.
// classify() is now pure (takes an array of colour strings, no DOM), so load
// utils.js in Node (vm + window stub) and assert the contract directly.
function loadExplore() {
    const src = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', ...p), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    // The shades are no longer utils.js's own: they come from the table both
    // classifiers share, so it has to be in the sandbox first.
    vm.runInContext(src('steam-palette.js'), sandbox);
    vm.runInContext(src('explore-queue', 'utils.js'), sandbox);
    return { Explore: sandbox.window.ILAP.Explore, Palette: sandbox.window.ILAP.SteamPalette };
}

test.describe('Explore Queue — ReviewAnalyzer.classify fail-safe (unit)', () => {
    const { Explore, Palette } = loadExplore();
    const { Analyzer, COLORS } = Explore;
    // Steam's too-few-reviews grey: a real colour the classifier must not act on.
    const GREY = 'rgb(146, 147, 150)';

    test('no rows → NO_REVIEWS (never ignores on missing data)', () => {
        expect(Analyzer.classify([], COLORS)).toBe('NO_REVIEWS');
        expect(Analyzer.classify(null, COLORS)).toBe('NO_REVIEWS');
    });

    test('all-blue (positive) rows → SPARE', () => {
        expect(Analyzer.classify(COLORS.BLUE, COLORS)).toBe('SPARE');
        expect(Analyzer.classify([].concat(COLORS.BLUE, COLORS.BLUE), COLORS)).toBe('SPARE');
    });

    test('a known bad (Mixed/Negative) colour → IGNORE', () => {
        expect(Analyzer.classify(COLORS.MIXED, COLORS)).toBe('IGNORE');
        expect(Analyzer.classify(COLORS.NEGATIVE, COLORS)).toBe('IGNORE');
        expect(Analyzer.classify([].concat(COLORS.BLUE, COLORS.NEGATIVE), COLORS)).toBe('IGNORE');
    });

    // A band is a SET: the shade Steam paints now, plus the ones it painted
    // before. Every entry must condemn on its own, so a rollback or a stale
    // cached stylesheet does not silently turn ignoring off.
    test('EVERY shade in a bad band condemns, current and previous alike', () => {
        expect(Palette.MIXED.length).toBeGreaterThan(1);
        expect(Palette.NEGATIVE.length).toBeGreaterThan(1);
        for (const shade of [].concat(Palette.MIXED, Palette.NEGATIVE)) {
            expect(Analyzer.classify([shade], COLORS), `${shade} must be IGNORE`).toBe('IGNORE');
            expect(Palette.isBad(shade), `${shade} must read as bad`).toBe(true);
        }
        expect(Palette.isBad(Palette.current('BLUE'))).toBe(false);
        expect(Palette.isBad(GREY)).toBe(false);
    });

    // classify() is handed a config, not the table, and a caller (or an older
    // build) may still spell a band as one string.
    test('a config spelling a band as a plain string still works', () => {
        const flat = { BLUE: 'rgb(102, 192, 244)', MIXED: 'rgb(185, 160, 116)', NEGATIVE: 'rgb(200, 94, 45)' };
        expect(Analyzer.classify([flat.MIXED], flat)).toBe('IGNORE');
        expect(Analyzer.classify([flat.BLUE], flat)).toBe('SPARE');
    });

    test('FAIL-SAFE: an UNKNOWN colour (e.g. Steam theme change) → SPARE, not IGNORE', () => {
        // A shade that matches neither BLUE nor the known bad colours. The old
        // "not blue → IGNORE" logic would have mass-ignored these; the fail-safe
        // must spare them.
        expect(Analyzer.classify(['rgb(1, 2, 3)'], COLORS)).toBe('SPARE');
        expect(Analyzer.classify([GREY], COLORS)).toBe('SPARE');
        expect(Analyzer.classify(['rgb(1, 2, 3)', 'rgb(4, 5, 6)'], COLORS)).toBe('SPARE');
    });

    test('end-to-end with DecisionEngine: unknown colour is spared in bad mode', () => {
        const state = Analyzer.classify(['rgb(1, 2, 3)'], COLORS);
        expect(Explore.DecisionEngine.decide(state, 'bad')).toBe('SHOULD_SPARE');
    });
});
