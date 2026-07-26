const { test, expect } = require('../_fixtures.js');
const {
    SEL,
    DRAIN_TIMEOUT,
    installContextMenuSpy,
    readContextMenuSpy,
    rightClickSwipe,
    pickFirstRow,
    searchRow,
    gotoWithStubs,
    miJob,
} = require('./_helpers');
const { clearExtensionStorage, setExtensionStorage } = require('../_extension.js');
const { searchUrl } = require('../_search.js');

// Search results give us a stable list of rows — easiest surface to land a swipe
// on without fighting React layouts. Each row is itself the /app/ link. The term
// is randomized per navigation (see _search.js) — any of them returns game rows.

// Sets up the Steam route stubs, navigates, and returns the live calls array.
async function gotoSearch(page, context) {
    const calls = await gotoWithStubs(page, context, searchUrl());
    await installContextMenuSpy(page);
    return calls;
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — swipe gesture', () => {

    test('Right-click + swipe RIGHT triggers default ignore (reason=0)', async ({ page, context }) => {
        const calls = await gotoSearch(page, context);

        const { link, appid } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);

        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);
        expect(calls[0].appid).toBe(appid);
        expect(calls[0].reason).toBe(0);

        await expect(searchRow(page, appid).locator(SEL.overlay)).toBeVisible({ timeout: DRAIN_TIMEOUT });
    });

    test('Right-click + swipe LEFT triggers Already Played ignore (reason=2)', async ({ page, context }) => {
        const calls = await gotoSearch(page, context);

        const { link, appid } = await pickFirstRow(page);
        await rightClickSwipe(page, link, -60);

        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);
        expect(calls[0].appid).toBe(appid);
        expect(calls[0].reason).toBe(2);

        // reason=2 paints the badge background blue (#4072CB — see BadgeFactory).
        const badge = searchRow(page, appid).locator(SEL.overlay);
        await expect(badge).toBeVisible({ timeout: DRAIN_TIMEOUT });
        const bg = await badge.evaluate(el => el.style.backgroundColor);
        expect(bg.replace(/\s/g, '')).toBe('rgb(64,114,203)');
    });

    test('Short swipe (< threshold) does NOT trigger ignore', async ({ page, context }) => {
        const calls = await gotoSearch(page, context);

        const { link } = await pickFirstRow(page);
        // 20px is well below the 40px threshold in SwipeGestureDetector.
        await rightClickSwipe(page, link, 20);
        // Give the enqueue a beat in case it would fire.
        await page.waitForTimeout(400);

        // The queue is the real evidence: the POST is seconds behind the
        // gesture now, so "no call yet" would also be true for a swipe that
        // wrongly enqueued and is merely still waiting for its gate slot.
        expect(await miJob(context)).toBeNull();
        expect(calls).toHaveLength(0);
        await expect(page.locator(SEL.overlay)).toHaveCount(0);
    });

    test('Master toggle OFF: swipe is fully inert', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_master_enabled: false });
        const calls = await gotoSearch(page, context);
        // ConfigService.listen() debounces via chrome.storage.onChanged on init —
        // give it a moment to ingest the pre-set value.
        await page.waitForTimeout(300);

        const { link } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);
        await page.waitForTimeout(400);

        expect(await miJob(context)).toBeNull();
        expect(calls).toHaveLength(0);
        await expect(page.locator(SEL.overlay)).toHaveCount(0);
    });

    test('Default and platform swipes are isolated: when platform=off, left swipe is no-op', async ({ page, context }) => {
        // Default stays at swipeRight, platform explicitly disabled.
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'swipeRight',
            ilap_platform_key: 'off',
        });
        const calls = await gotoSearch(page, context);
        await page.waitForTimeout(300);

        const { link, appid } = await pickFirstRow(page);

        // Left swipe matches neither default nor platform — must do nothing.
        await rightClickSwipe(page, link, -60);
        await page.waitForTimeout(400);
        expect(await miJob(context)).toBeNull();
        expect(calls).toHaveLength(0);

        // Right swipe still works as the default action.
        await rightClickSwipe(page, link, 60);
        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);
        expect(calls[0].appid).toBe(appid);
        expect(calls[0].reason).toBe(0);
    });

    test('Default-only mapping: when default=off, right swipe is no-op but platform left still works', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'off',
            ilap_platform_key: 'swipeLeft',
        });
        const calls = await gotoSearch(page, context);
        await page.waitForTimeout(300);

        const { link, appid } = await pickFirstRow(page);

        await rightClickSwipe(page, link, 60);
        await page.waitForTimeout(400);
        expect(await miJob(context)).toBeNull();
        expect(calls).toHaveLength(0);

        await rightClickSwipe(page, link, -60);
        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);
        expect(calls[0].appid).toBe(appid);
        expect(calls[0].reason).toBe(2);
    });

    test('Successful gesture suppresses the native context menu', async ({ page, context, browserName }) => {
        // Chromium-only. Under Playwright's synthetic mouse, Firefox emits the
        // contextmenu event at mouse-DOWN — before the swipe is recognised on
        // mouse-up — so the detector's blockNextMenu latch isn't set yet and the
        // main-world spy reads defaultPrevented=false. No real OS menu opens
        // (verified in the failure screenshot: the game is ignored, no menu), so
        // this is a synthetic-event timing artifact, not a suppression gap.
        test.skip(browserName === 'firefox',
            'Firefox synthetic contextmenu fires at mousedown, before swipe recognition');
        await gotoSearch(page, context);

        const { link } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);
        await page.waitForTimeout(200);

        const spy = await readContextMenuSpy(page);
        // The detector listens in capture phase and calls preventDefault, so
        // any contextmenu that did fire must show up as prevented.
        if (spy.fired > 0) expect(spy.prevented).toBe(spy.fired);
    });

    test('Dedup: second swipe on the same capsule does not fire another API call', async ({ page, context }) => {
        const calls = await gotoSearch(page, context);

        const { link, appid } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);
        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);
        await rightClickSwipe(page, link, 60);
        await page.waitForTimeout(300);

        expect(calls).toHaveLength(1);
        expect(calls[0].appid).toBe(appid);
    });
});
