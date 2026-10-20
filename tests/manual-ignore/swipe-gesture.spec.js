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
    greyOut,
    pickSteamGreyedRow,
    interceptIgnoreApi,
    routeUserdata,
} = require('./_helpers');
const { clearExtensionStorage, setExtensionStorage, getExtensionStorage } = require('../_extension.js');
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

    test('Successful gesture suppresses the native context menu', async ({ page, context }) => {
        // Both orderings end cancelled. Chromium fires the menu after mouse-up,
        // where the recognised gesture's latch swallows it; Playwright's Firefox
        // fires it at mouse-DOWN, the way Linux and macOS do, where the detector
        // cancels a menu that arrives on a capsule with the button still held.
        await gotoSearch(page, context);

        const { link } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);
        await page.waitForTimeout(200);

        const spy = await readContextMenuSpy(page);
        expect(spy.fired).toBeGreaterThan(0);
        expect(spy.prevented).toBe(spy.fired);
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

// A right swipe on a greyed row whose reason Steam already has (0). The gesture
// reads userdata before it decides, so that read is the sign it has decided.
async function swipeWithSteamsReason(page, link) {
    const read = page.waitForRequest(/\/dynamicstore\/userdata\//, { timeout: 5000 });
    await rightClickSwipe(page, link, 60);
    await read;
    await page.waitForTimeout(400);
}

test.describe('Manual Ignore — a capsule Steam already greys out', () => {
    // The game is on the account's list: the extension's userdata read says so
    // too, with reason 0 (Default). A gesture with another reason changes it
    // and tints Steam's own IGNORED flag in its colour instead of painting a
    // badge; one with the reason Steam has changes nothing and shows nothing.
    async function greyedRow(page, context) {
        const calls = await gotoSearch(page, context);
        const { link, appid } = await pickFirstRow(page);
        await greyOut(link);
        await routeUserdata(context, [appid], 0);
        const flag = link.locator('.ds_ignored_flag');
        expect((await flag.boundingBox()).width).toBeGreaterThan(0);
        return { calls, link, appid, flag };
    }

    test('swipe RIGHT with the reason Steam has: nothing queued, sent or shown', async ({ page, context }) => {
        const { calls, link, appid } = await greyedRow(page, context);

        await swipeWithSteamsReason(page, link);
        expect(await miJob(context)).toBeNull();
        expect(calls).toHaveLength(0);
        await expect(link).not.toHaveClass(/ilap-steam-tint/);
        await expect(searchRow(page, appid).locator(SEL.overlay)).toHaveCount(0);
    });

    test('swipe LEFT changes the reason: one POST with reason 2, flag blue, not counted', async ({ page, context }) => {
        const { calls, link, appid, flag } = await greyedRow(page, context);

        await rightClickSwipe(page, link, -60);
        await expect(link).toHaveClass(/ilap-steam-tint-played/, { timeout: 5000 });
        // Polled: Steam's flag transitions its background.
        await expect.poll(() => flag.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(64, 114, 203)');
        await expect(searchRow(page, appid).locator(SEL.overlay)).toHaveCount(0);

        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);
        expect(calls[0]).toMatchObject({ appid, reason: 2, remove: false });
        // In Last Ignored, but out of the total and out of Undo.
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_last_ignored_name'))
            .ilap_last_ignored_name, { timeout: 5000 }).toBeTruthy();
        const after = await getExtensionStorage(context, ['ilap_ignored_count', 'ilap_ignore_log_c0']);
        expect(after.ilap_ignored_count).toBeUndefined();
        expect(after.ilap_ignore_log_c0).toBeUndefined();
    });
});

test.describe('Manual Ignore — a capsule greyed by Steam itself', () => {
    // Same two cases on Steam's own markup: a game the account really ignores,
    // shown greyed with "Hide ignored items" off. The extension's userdata read
    // is stubbed to the reason Steam has, and the POST never leaves the browser.
    async function steamGreyedRow(page, context) {
        const calls = await interceptIgnoreApi(context);
        const row = await pickSteamGreyedRow(page, context);
        await routeUserdata(context, [row.appid], 0);
        await expect(row.link).toHaveClass(/\bds_ignored\b/);
        expect((await row.flag.boundingBox()).width).toBeGreaterThan(0);
        return { calls, ...row };
    }

    test('swipe RIGHT with the reason Steam has: nothing queued, sent or shown', async ({ page, context }) => {
        const { calls, link, appid, flag } = await steamGreyedRow(page, context);

        await swipeWithSteamsReason(page, link);
        expect(await miJob(context)).toBeNull();
        expect(calls).toHaveLength(0);
        await expect(link).not.toHaveClass(/ilap-steam-tint/);
        await expect(searchRow(page, appid).locator(SEL.overlay)).toHaveCount(0);
        // Nothing to explain: the flag stays Steam's, greyed, with no tooltip.
        await flag.hover();
        await page.waitForTimeout(2000);   // past the tooltip's 1.5 s dwell
        await expect(link).toHaveCSS('opacity', '0.3');
        await expect(page.locator('.ilap-tooltip-floating.show')).toHaveCount(0);
    });

    test('swipe LEFT changes the reason: one POST with reason 2, flag blue', async ({ page, context }) => {
        const { calls, link, appid, flag } = await steamGreyedRow(page, context);

        await rightClickSwipe(page, link, -60);
        await expect(link).toHaveClass(/ilap-steam-tint-played/, { timeout: 5000 });
        await expect.poll(() => flag.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(64, 114, 203)');
        await expect(searchRow(page, appid).locator(SEL.overlay)).toHaveCount(0);

        // Hovered, the flag surfaces from Steam's grey and explains itself.
        await flag.hover();
        await expect(link).toHaveCSS('opacity', '1');
        const tip = page.locator('.ilap-tooltip-floating.show');
        await expect(tip).toBeVisible({ timeout: 5000 });
        await expect(tip).toContainText('Already Played');
        await page.mouse.move(0, 0);
        await expect(tip).toHaveCount(0);

        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);
        expect(calls[0]).toMatchObject({ appid, reason: 2, remove: false });

        // Blue again on the flag this tab made blue: nothing queued or sent.
        await expect.poll(() => miJob(context), { timeout: DRAIN_TIMEOUT }).toBeNull();
        await rightClickSwipe(page, link, -60);
        await page.waitForTimeout(400);
        expect(await miJob(context)).toBeNull();
        expect(calls).toHaveLength(1);
        await expect(link).toHaveClass(/ilap-steam-tint-played/);
    });
});
