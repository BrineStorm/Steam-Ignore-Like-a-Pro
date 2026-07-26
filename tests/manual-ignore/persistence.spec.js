const { test, expect } = require('../_fixtures.js');
const {
    SEL,
    DRAIN_TIMEOUT,
    interceptIgnoreApi,
    routeUserdata,
    rightClickSwipe,
    pickFirstRow,
    searchRow,
    waitForContentScript,
    miJob,
} = require('./_helpers');
const { clearExtensionStorage } = require('../_extension.js');
const { searchUrl } = require('../_search.js');

const SESSION_KEY = 'ilap_session_map_v2';

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — session persistence across reload', () => {

    test('Ignore → reload → badge re-renders from ilap_session_map_v2 with no new API call', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        // Nothing pre-ignored, so the drainer's dedupe can't skip the swipe.
        // (This spec keeps its own goto: sessionStorage has to be wiped between
        // the navigation and the content script's boot read.)
        await routeUserdata(context, []);

        // 1. Ignore a game so the session map records [appid → reason].
        await page.goto(searchUrl());
        // Start with a clean sessionStorage so a stray entry from another test
        // can't fake a passing reload-render.
        await page.evaluate(() => sessionStorage.clear());
        await waitForContentScript(page);

        const { link, appid } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);

        await expect(searchRow(page, appid).locator(SEL.overlay)).toBeVisible({ timeout: DRAIN_TIMEOUT });
        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);

        // 2. Sanity: the session map actually holds this appid.
        const sessionDump = await page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY);
        expect(sessionDump).toBeTruthy();
        const entries = JSON.parse(sessionDump);
        expect(entries.some(([id]) => String(id) === appid)).toBe(true);

        // 3. Let the deferral job finish FIRST. The drainer advances the cursor
        //    just after the POST resolves; reloading inside that window would
        //    make the fresh page re-drain the same appid, and step 5's "no new
        //    API call" would fail on a harness race rather than a real bug.
        await expect.poll(() => miJob(context), { timeout: DRAIN_TIMEOUT }).toBeNull();

        // Reload — sessionStorage survives in the same tab, chrome.storage too.
        await page.reload();
        await waitForContentScript(page);

        // 4. If Steam re-rendered the same appid in the results (search top
        //    entries are stable for these terms), the badge should appear
        //    purely from refreshAll() — no swipe, no API call.
        const linkAfter = page.locator(`a[href*="/app/${appid}/"]`).first();
        const linkAttached = await linkAfter
            .waitFor({ state: 'attached', timeout: 5000 })
            .then(() => true)
            .catch(() => false);

        test.skip(!linkAttached, `appid ${appid} was not in the reloaded results; cannot assert badge restoration here.`);

        const restoredBadge = page.locator(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`).first();
        await expect(restoredBadge).toBeVisible({ timeout: 8000 });

        // 5. The restoration must NOT have called the ignore API again — the
        //    cumulative call count is unchanged from the single swipe above.
        await page.waitForTimeout(500);
        expect(calls).toHaveLength(1);

        // 6. Session map is still intact after the reload (not wiped by the
        //    content script's init sequence).
        const sessionDumpAfter = await page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY);
        const entriesAfter = JSON.parse(sessionDumpAfter);
        expect(entriesAfter.some(([id]) => String(id) === appid)).toBe(true);
    });
});
