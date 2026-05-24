const { test, expect } = require('@playwright/test');
const { AUTH_FILE, openExploreQueue } = require('./_helpers');

test.use({ storageState: AUTH_FILE });

// DecisionEngine is a pure static class exposed on window.ILAP.Explore. We can
// drive its strategy map directly from the page context without hunting for a
// Mostly Positive game in Steam's live queue — the analyzer's classification
// path (Blue vs non-Blue text color) is exercised elsewhere in
// bad-mode-ignore.spec.js. Here we lock the contract between reviewState and
// mode.
//
// reviewState comes from ReviewAnalyzer.classify:
//   - 'IGNORE'     → at least one Mixed/Negative (non-Blue) status row
//   - 'SPARE'      → only Mostly Positive / Very Positive (all-Blue) rows
//   - 'NO_REVIEWS' → no usable rows
test.describe('Explore Queue — DecisionEngine decision matrix', () => {

    test('Mostly Positive (SPARE) is spared in bad mode, ignored in all mode', async ({ page }) => {
        // EQ scripts load on a queue page, not on /explore/ alone.
        await openExploreQueue(page);
        await page.waitForFunction(
            () => window.ILAP && window.ILAP.Explore && window.ILAP.Explore.DecisionEngine,
            null,
            { timeout: 15000 }
        );

        const decisions = await page.evaluate(() => {
            const DE = window.ILAP.Explore.DecisionEngine;
            return {
                spareBad:     DE.decide('SPARE', 'bad'),
                spareAll:     DE.decide('SPARE', 'all'),
                ignoreBad:    DE.decide('IGNORE', 'bad'),
                ignoreAll:    DE.decide('IGNORE', 'all'),
                noReviewsBad: DE.decide('NO_REVIEWS', 'bad'),
                noReviewsAll: DE.decide('NO_REVIEWS', 'all'),
            };
        });

        // Bad mode: only Mixed/Negative gets ignored.
        expect(decisions.spareBad).toBe('SHOULD_SPARE');
        expect(decisions.ignoreBad).toBe('SHOULD_IGNORE');
        expect(decisions.noReviewsBad).toBe('SHOULD_SPARE');

        // All mode: everything gets ignored regardless of review state.
        expect(decisions.spareAll).toBe('SHOULD_IGNORE');
        expect(decisions.ignoreAll).toBe('SHOULD_IGNORE');
        expect(decisions.noReviewsAll).toBe('SHOULD_IGNORE');
    });

    test('Unknown mode falls back to bad mode strategy', async ({ page }) => {
        await openExploreQueue(page);
        await page.waitForFunction(
            () => window.ILAP && window.ILAP.Explore && window.ILAP.Explore.DecisionEngine,
            null,
            { timeout: 15000 }
        );

        const decisions = await page.evaluate(() => {
            const DE = window.ILAP.Explore.DecisionEngine;
            return {
                spareUnknown:  DE.decide('SPARE', 'gibberish'),
                ignoreUnknown: DE.decide('IGNORE', 'gibberish'),
            };
        });

        // If a future bug ships a stale mode string, the safe default is
        // bad-mode (don't mass-ignore everything).
        expect(decisions.spareUnknown).toBe('SHOULD_SPARE');
        expect(decisions.ignoreUnknown).toBe('SHOULD_IGNORE');
    });
});
