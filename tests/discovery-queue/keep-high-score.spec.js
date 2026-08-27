// SPDX-License-Identifier: GPL-3.0-or-later
//
// Keep High Score, end to end against live Steam. The gap this closes: the only
// test that touched the checkbox asserted it ticks and unticks. What it DOES —
// spare the well-reviewed, ignore the rest — had no coverage at all, which is
// how a shipped release spent a version silently ignoring nothing when Steam
// repainted the Mixed shade the classifier matches on.
//
// Three assertions, and the palette drift fails the first one:
//   * with the box ticked the run still ignores something (it ignored nothing);
//   * nothing it ignored was well-reviewed (the fail-safe direction);
//   * at least one well-reviewed game was seen and left alone (the feature).
//
// This ignores REAL games on the test account — a handful, not the fourteen
// ui.spec.js spends. globalSetup/globalTeardown remove exactly the diff
// afterwards (tests/_cleanup.js).

const { test, expect } = require('../_fixtures.js');
const { SEL, openQueueModal, readCard } = require('./_modal.js');
const { bandOf } = require('../_palette.js');

// Both spellings of the ignore endpoint: ours posts to
// /recommended/ignorerecommendation/ urlencoded, Steam's own page JS — the
// sender on every DQ ignore — posts to the same path WITHOUT the trailing slash
// as multipart. A watcher that knows only one of them sees half the run.
const field = (body, name) => {
    const m = body.match(new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n]*)`));
    return m ? m[1] : new URLSearchParams(body).get(name);
};

test.describe('Discovery Queue — Keep High Score (live)', () => {

    test('with the box ticked: mixed/negative still get ignored, the well-reviewed are spared', async ({ page }) => {
        test.setTimeout(360_000);

        const ignored = [];               // appids the run actually ignored
        const bandByAppid = new Map();    // appid -> rating band, sampled off the cards
        page.on('request', (req) => {
            if (req.method() !== 'POST' || !req.url().includes('ignorerecommendation')) return;
            const body = req.postData() || '';
            const appid = field(body, 'appid');
            if (appid && field(body, 'remove') !== '1') ignored.push(String(appid));
        });

        await openQueueModal(page);

        const btn = page.locator(SEL.button);
        await expect(btn).toBeVisible({ timeout: 10000 });

        // Tick it through the label, the way a user does.
        await page.locator(SEL.label).click();
        await expect(page.locator(SEL.checkbox)).toBeChecked();

        await page.locator(`${SEL.modal} a[href*="/app/"]`).first()
            .waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});

        await btn.click();
        await expect(btn).toHaveClass(/running/, { timeout: 5000 });

        // Sample the card the automator is on. Slides last well over a second,
        // so this catches nearly all of them — and the map is only ever read for
        // appids it did capture.
        const sample = async () => {
            const card = await readCard(page).catch(() => null);
            if (card && card.kind === 'card' && card.appid && card.band) {
                bandByAppid.set(String(card.appid), card.band);
            }
        };

        // Run until there is enough to judge: an ignore whose card we actually
        // sampled — "it ignored something" alone would pass even if we never saw
        // WHAT it ignored, and then the check below has nothing to check — plus
        // enough cards seen that "it spared something" means anything. A queue
        // holds twelve and roughly one card in eight is rated Mixed, so this
        // normally lands inside a queue or two; the budget covers a run that has
        // to cross a Continue interstitial to find one.
        await expect.poll(async () => {
            await sample();
            return ignored.some((id) => bandByAppid.has(id)) && bandByAppid.size >= 5;
        }, {
            timeout: 240_000,
            intervals: [400],
            message: 'the run never ignored a game with Keep High Score on. If Steam has repainted a review '
                + 'band, every slide reads as well-reviewed and the feature spares the whole queue — check '
                + 'tests/discovery-queue/palette.spec.js and src/steam-palette.js',
        }).toBe(true);

        await btn.click();
        await expect(btn).not.toHaveClass(/running/, { timeout: 10000 });

        // 1. It ignored something at all — the regression that shipped.
        expect(ignored.length, 'Keep High Score ignored nothing across the whole run').toBeGreaterThan(0);

        // 2. What it ignored was genuinely not well-reviewed. Only appids whose
        //    card was sampled can be judged, so require at least one of those —
        //    otherwise this assertion is vacuous and the spec proves nothing
        //    about the classification, which is the whole point of it.
        const judged = ignored.map((id) => ({ id, band: bandByAppid.get(id) })).filter((x) => x.band);
        expect(judged.length,
            `${ignored.length} ignore(s) fired but no card behind them was sampled — nothing to judge`)
            .toBeGreaterThan(0);
        const wrongly = judged.filter((x) => bandOf(x.band) === 'BLUE');
        expect(wrongly,
            `Keep High Score ignored well-reviewed games: ${JSON.stringify(wrongly)}`).toEqual([]);

        // 3. And it did spare — at least one well-reviewed card went past
        //    untouched. Without this the test would still pass if the checkbox
        //    did nothing and everything got ignored.
        const sparedPositives = [...bandByAppid.entries()]
            .filter(([id, band]) => bandOf(band) === 'BLUE' && !ignored.includes(id));
        expect(sparedPositives.length,
            `no well-reviewed game was left alone — seen ${JSON.stringify([...bandByAppid])}, `
            + `ignored ${JSON.stringify(ignored)}`).toBeGreaterThan(0);
    });
});
