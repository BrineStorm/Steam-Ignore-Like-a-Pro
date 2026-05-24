const { test, expect } = require('@playwright/test');
const {
    AUTH_FILE,
    SEL,
    stubIgnoreApi,
    getApiCalls,
    rightClickSwipe,
    pickFirstAppLink,
    waitForContentScript,
} = require('./_helpers');
const { clearExtensionStorage } = require('../_extension.js');

test.use({ storageState: AUTH_FILE });

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

// Each entry exercises a different branch of ContainerStrategyProvider:
//   - List Item     → .tab_item             (search results)
//   - Generic Wrap  → .dailydeal_cap        (storefront daily deals)
//   - Direct Image  → [class*="CapsuleImageCtn"]  (React storefront tiles)
const SURFACES = [
    {
        name: 'search results — List strategy',
        url: '/search/?term=action',
        container: '.tab_item',
        expectVariant: SEL.listBadge,
    },
    {
        name: 'storefront daily deal — Wrapper strategy',
        url: '/',
        container: '.dailydeal_cap',
        expectVariant: SEL.gridBadge, // wrapper resolves daily deals as 'grid'
    },
    {
        name: 'React storefront tile — Direct Image strategy',
        url: '/',
        container: '[class*="CapsuleImageCtn"]',
        expectVariant: SEL.gridBadge,
    },
];

test.describe('Manual Ignore — container strategies across Steam surfaces', () => {

    for (const surface of SURFACES) {
        test(`Swipe lands a badge on: ${surface.name}`, async ({ page }) => {
            await page.goto(surface.url);
            await waitForContentScript(page);
            await stubIgnoreApi(page);

            // Storefront takes a moment to hydrate React widgets — give the
            // requested container time to materialize, otherwise skip with a
            // clear message rather than a generic timeout.
            const probe = page.locator(surface.container).first();
            try {
                await probe.waitFor({ state: 'attached', timeout: 15000 });
            } catch {
                test.skip(true, `${surface.container} did not render on ${surface.url}; Steam surface changed.`);
            }

            const { link, appid } = await pickFirstAppLink(page, surface.container);
            await rightClickSwipe(page, link, 60);

            const calls = await getApiCalls(page);
            expect(calls).toHaveLength(1);
            expect(calls[0].appid).toBe(appid);
            expect(calls[0].reason).toBe(0);

            // Badge should land somewhere inside the container, with the
            // variant class that matches this strategy's resolved type.
            const container = page.locator(surface.container)
                .filter({ has: page.locator(`a[href*="/app/${appid}"]`) })
                .first();
            await expect(container.locator(surface.expectVariant)).toBeVisible({ timeout: 5000 });
        });
    }

    // Tag browse and app-detail pages don't share a stable wrapper selector
    // with the surfaces above — they need their own probe. The contract is
    // the same though: swipe → ContainerStrategyProvider must resolve, badge
    // must end up tied to the swiped appid via data-ilap-appid.

    test('Swipe lands a badge on: tag browse (/tag/browse/?tags=19)', async ({ page }) => {
        await page.goto('/tag/browse/?tags=19'); // Action tag — populated reliably.
        await waitForContentScript(page);
        await stubIgnoreApi(page);

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

        const calls = await getApiCalls(page);
        expect(calls).toHaveLength(1);
        expect(calls[0].appid).toBe(appid);

        // The variant doesn't matter for this surface — what matters is that
        // ContainerStrategyProvider resolved (not fallback-fired into oblivion)
        // and the badge is correctly tagged with this appid.
        const badge = page.locator(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`).first();
        await expect(badge).toBeVisible({ timeout: 5000 });
    });

    test('Swipe lands a badge on: app detail page (/app/730 — sidebar recs)', async ({ page }) => {
        const CURRENT_APP = '730'; // Counter-Strike 2 — reliably has recommendation tiles.
        await page.goto(`/app/${CURRENT_APP}/`);
        await waitForContentScript(page);
        await stubIgnoreApi(page);

        // Find the first /app/<other>/ link — recommendation tiles, "More like
        // this", franchise blocks. Excluding the current appid avoids matching
        // the page's own header/breadcrumb anchors.
        const link = page.locator(`a[href*="/app/"]:not([href*="/app/${CURRENT_APP}/"]):not([href$="/app/${CURRENT_APP}"])`).first();
        try {
            await link.waitFor({ state: 'attached', timeout: 15000 });
            await link.scrollIntoViewIfNeeded();
        } catch {
            test.skip(true, `App page rendered no sibling /app/ links; surface changed.`);
            return;
        }
        const href = await link.getAttribute('href');
        const m = href && href.match(/\/app\/(\d+)/);
        if (!m || m[1] === CURRENT_APP) {
            test.skip(true, `No sibling app link found on /app/${CURRENT_APP}/.`);
            return;
        }
        const appid = m[1];

        await rightClickSwipe(page, link, 60);

        const calls = await getApiCalls(page);
        expect(calls).toHaveLength(1);
        expect(calls[0].appid).toBe(appid);

        const badge = page.locator(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`).first();
        await expect(badge).toBeVisible({ timeout: 5000 });
    });
});
