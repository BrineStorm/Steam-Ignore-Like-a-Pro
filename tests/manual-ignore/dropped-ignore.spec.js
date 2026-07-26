const { test, expect } = require('../_fixtures.js');
const {
    SEL,
    DRAIN_TIMEOUT,
    routeUserdata,
    rightClickSwipe,
    pickFirstRow,
    waitForContentScript,
} = require('./_helpers');
const { clearExtensionStorage } = require('../_extension.js');
const { searchUrl } = require('../_search.js');

// A swipe badges optimistically and defers the POST. When that POST is refused
// for good — here the region-lock case: HTTP 400 on the ignore endpoint AND
// appdetails success:false, the pair the drainer treats as "this appid has no
// store object in your region" — the game was never actually ignored. The
// drainer drops the optimistic badge (ilap_unignored pulse, reason 'failed')
// and the swiping tab raises the shared push card, so the badge does not just
// silently evaporate minutes after the gesture.

const TOAST = '.ilap-toast';

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — a refused deferred ignore', () => {

    test('drops the optimistic badge and tells the user', async ({ page, context }) => {
        // Steam refuses every ignore POST…
        await context.route('**/recommended/ignorerecommendation/**', (route) => route.fulfill({
            status: 400, contentType: 'application/json', body: JSON.stringify({ success: false }),
        }));
        // …and appdetails confirms the refusal is the permanent per-appid kind,
        // keyed by whatever appid the classifier asks about.
        await context.route('**/api/appdetails**', (route) => {
            const id = new URL(route.request().url()).searchParams.get('appids');
            return route.fulfill({
                status: 200, contentType: 'application/json',
                body: JSON.stringify({ [id]: { success: false } }),
            });
        });
        await routeUserdata(context, []);

        await page.goto(searchUrl());
        await waitForContentScript(page);

        const { link, appid } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);

        // Optimistic badge first — the swipe was accepted into the queue.
        // Counted, not visibility-checked: Steam's search page also holds
        // off-screen duplicate rows, so "painted" is the contract here, and the
        // visible-badge rendering is asserted by containers.spec.
        const badge = page.locator(`${SEL.overlay}[data-ilap-appid="${appid}"]`);
        await expect(badge).not.toHaveCount(0, { timeout: 5000 });

        // …then the drain refuses it: badge dropped everywhere, card raised.
        await expect(badge).toHaveCount(0, { timeout: DRAIN_TIMEOUT });
        await expect(page.locator(TOAST)).toBeVisible({ timeout: 5000 });
    });
});
