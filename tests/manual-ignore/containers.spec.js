const { test, expect } = require('../_fixtures.js');
const {
    SEL,
    DRAIN_TIMEOUT,
    rightClickSwipe,
    pickFirstRow,
    searchRow,
    gotoWithStubs,
} = require('./_helpers');
const { clearExtensionStorage } = require('../_extension.js');
const { searchUrl } = require('../_search.js');

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

// Homepage capsule surfaces. Steam's storefront markup shifts with sales and
// redesigns; these are the long-lived widgets. Each `anchor` selects the /app/
// link DIRECTLY (on the homepage the capsule usually IS the anchor), and each
// exercises a distinct ContainerStrategyProvider branch:
//   - Wrapper      → a.store_main_capsule        (Featured carousel, hero badge)
//   - Direct Image → .home_area_spotlight (.spotlight_img parent, hero badge)
//   - Fallback     → a.tab_row_item              (New & Trending tabs, grid badge)
//   - Fallback     → a.sale_capsule              (sale/discount capsules, grid badge)
const SURFACES = [
    {
        name: 'featured carousel capsule — Wrapper strategy (hero)',
        anchor: 'a.store_main_capsule[href*="/app/"]:visible',
        expectVariant: SEL.heroBadge,
    },
    {
        name: 'spotlight capsule — Direct Image strategy (hero)',
        anchor: '.home_area_spotlight a[href*="/app/"]:visible',
        expectVariant: SEL.heroBadge,
        skipNote: 'No spotlight with an /app/ link on /; spotlights sometimes point at sales/news only.',
    },
    {
        name: 'New & Trending tab row — Fallback strategy (grid)',
        anchor: 'a.tab_row_item[href*="/app/"]:visible',
        expectVariant: SEL.gridBadge,
    },
    {
        name: 'sale capsule — Fallback strategy (grid)',
        anchor: 'a.sale_capsule[href*="/app/"]:visible',
        expectVariant: SEL.gridBadge,
    },
];

test.describe('Manual Ignore — container strategies across Steam surfaces', () => {

    test('Swipe lands a badge on: search results — Fallback strategy (grid)', async ({ page, context }) => {
        const calls = await gotoWithStubs(page, context, searchUrl());

        // Search rows ARE the /app/ link; the extension resolves them via the
        // Fallback strategy → 'grid' badge appended onto the row.
        const { link, appid } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);

        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);
        expect(calls[0].appid).toBe(appid);
        expect(calls[0].reason).toBe(0);

        await expect(searchRow(page, appid).locator(SEL.gridBadge)).toBeVisible({ timeout: DRAIN_TIMEOUT });
    });

    for (const surface of SURFACES) {
        test(`Swipe lands a badge on: ${surface.name}`, async ({ page, context }) => {
            const calls = await gotoWithStubs(page, context, '/');

            // Storefront hydrates widgets asynchronously — give the anchor time
            // to materialize, otherwise skip with a clear message rather than a
            // generic timeout.
            try {
                await page.locator(surface.anchor).first().waitFor({ state: 'visible', timeout: 15000 });
            } catch {
                test.skip(true, surface.skipNote || `${surface.anchor} did not render on /; Steam surface changed.`);
                return;
            }

            const { link, appid } = await pickFirstRow(page, surface.anchor);
            await rightClickSwipe(page, link, 60);

            await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);
            expect(calls[0].appid).toBe(appid);
            expect(calls[0].reason).toBe(0);

            // The badge must carry the variant class of the strategy this
            // surface resolves through AND be tied to the swiped appid.
            const badge = page.locator(`${surface.expectVariant}[data-ilap-appid="${appid}"]`).first();
            await expect(badge).toBeVisible({ timeout: DRAIN_TIMEOUT });
        });
    }

    // Tag browse doesn't share a stable wrapper selector with the surfaces
    // above — it needs its own probe. The contract is the same though: swipe →
    // ContainerStrategyProvider must resolve, badge must end up tied to the
    // swiped appid via data-ilap-appid.

    test('Swipe lands a badge on: tag browse (/tag/browse/?tags=19)', async ({ page, context }) => {
        // Action tag — populated reliably.
        const calls = await gotoWithStubs(page, context, '/tag/browse/?tags=19');

        // Tag browse hydrates capsules asynchronously. Pick the first /app/ link
        // and wait for its image container to attach before swiping.
        const link = page.locator('a[href*="/app/"]').first();
        try {
            await link.waitFor({ state: 'attached', timeout: 15000 });
        } catch {
            test.skip(true, 'Tag browse rendered no /app/ links; Steam surface changed.');
            return;
        }
        const href = await link.getAttribute('href');
        const m = href && href.match(/\/app\/(\d+)/);
        if (!m) {
            test.skip(true, `Unexpected href on tag browse: ${href}`);
            return;
        }
        const appid = m[1];

        await rightClickSwipe(page, link, 60);

        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);
        expect(calls[0].appid).toBe(appid);

        // The variant doesn't matter for this surface — what matters is that
        // ContainerStrategyProvider resolved (not fallback-fired into oblivion)
        // and the badge is correctly tagged with this appid.
        const badge = page.locator(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`).first();
        await expect(badge).toBeVisible({ timeout: DRAIN_TIMEOUT });
    });
});
