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
});
