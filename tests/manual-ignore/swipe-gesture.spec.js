const { test, expect } = require('@playwright/test');
const {
    AUTH_FILE,
    SEL,
    stubIgnoreApi,
    getApiCalls,
    installContextMenuSpy,
    readContextMenuSpy,
    rightClickSwipe,
    pickFirstAppLink,
    waitForContentScript,
} = require('./_helpers');
const { clearExtensionStorage, setExtensionStorage } = require('../_extension.js');

test.use({ storageState: AUTH_FILE });

// Search results give us a stable .tab_item list — easiest surface to land
// a swipe on without fighting React layouts.
const SEARCH_URL = '/search/?term=action';
const LIST_ITEM = '.tab_item';

async function gotoSearch(page) {
    await page.goto(SEARCH_URL);
    await waitForContentScript(page);
    await stubIgnoreApi(page);
    await installContextMenuSpy(page);
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — swipe gesture', () => {

    test('Right-click + swipe RIGHT triggers default ignore (reason=0)', async ({ page }) => {
        await gotoSearch(page);

        const { link, appid } = await pickFirstAppLink(page, LIST_ITEM);
        await rightClickSwipe(page, link, 60);

        const calls = await getApiCalls(page);
        expect(calls).toHaveLength(1);
        expect(calls[0].appid).toBe(appid);
        expect(calls[0].reason).toBe(0);

        const item = page.locator(LIST_ITEM).filter({ has: page.locator(`a[href*="/app/${appid}"]`) }).first();
        await expect(item.locator(SEL.overlay)).toBeVisible({ timeout: 5000 });
    });

    test('Right-click + swipe LEFT triggers Already Played ignore (reason=2)', async ({ page }) => {
        await gotoSearch(page);

        const { link, appid } = await pickFirstAppLink(page, LIST_ITEM);
        await rightClickSwipe(page, link, -60);

        const calls = await getApiCalls(page);
        expect(calls).toHaveLength(1);
        expect(calls[0].appid).toBe(appid);
        expect(calls[0].reason).toBe(2);

        // reason=2 paints the badge background blue (#3ca8fc).
        const item = page.locator(LIST_ITEM).filter({ has: page.locator(`a[href*="/app/${appid}"]`) }).first();
        const badge = item.locator(SEL.overlay);
        await expect(badge).toBeVisible({ timeout: 5000 });
        const bg = await badge.evaluate(el => el.style.backgroundColor);
        // RGB form: rgb(60, 168, 252)
        expect(bg.replace(/\s/g, '')).toBe('rgb(60,168,252)');
    });

    test('Short swipe (< threshold) does NOT trigger ignore', async ({ page }) => {
        await gotoSearch(page);

        const { link } = await pickFirstAppLink(page, LIST_ITEM);
        // 20px is well below the 40px threshold in SwipeGestureDetector.
        await rightClickSwipe(page, link, 20);
        // Give the click handler a beat in case it would fire.
        await page.waitForTimeout(400);

        expect(await getApiCalls(page)).toHaveLength(0);
        await expect(page.locator(SEL.overlay)).toHaveCount(0);
    });

    test('Master toggle OFF: swipe is fully inert', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_master_enabled: false });
        await gotoSearch(page);
        // ConfigService.listen() debounces via chrome.storage.onChanged on init —
        // give it a moment to ingest the pre-set value.
        await page.waitForTimeout(300);

        const { link } = await pickFirstAppLink(page, LIST_ITEM);
        await rightClickSwipe(page, link, 60);
        await page.waitForTimeout(400);

        expect(await getApiCalls(page)).toHaveLength(0);
        await expect(page.locator(SEL.overlay)).toHaveCount(0);
    });

    test('Default and platform swipes are isolated: when platform=off, left swipe is no-op', async ({ page, context }) => {
        // Default stays at swipeRight, platform explicitly disabled.
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'swipeRight',
            ilap_platform_key: 'off',
        });
        await gotoSearch(page);
        await page.waitForTimeout(300);

        const { link, appid } = await pickFirstAppLink(page, LIST_ITEM);

        // Left swipe matches neither default nor platform — must do nothing.
        await rightClickSwipe(page, link, -60);
        await page.waitForTimeout(400);
        expect(await getApiCalls(page)).toHaveLength(0);

        // Right swipe still works as the default action.
        await rightClickSwipe(page, link, 60);
        const calls = await getApiCalls(page);
        expect(calls).toHaveLength(1);
        expect(calls[0].appid).toBe(appid);
        expect(calls[0].reason).toBe(0);
    });

    test('Default-only mapping: when default=off, right swipe is no-op but platform left still works', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'off',
            ilap_platform_key: 'swipeLeft',
        });
        await gotoSearch(page);
        await page.waitForTimeout(300);

        const { link, appid } = await pickFirstAppLink(page, LIST_ITEM);

        await rightClickSwipe(page, link, 60);
        await page.waitForTimeout(400);
        expect(await getApiCalls(page)).toHaveLength(0);

        await rightClickSwipe(page, link, -60);
        const calls = await getApiCalls(page);
        expect(calls).toHaveLength(1);
        expect(calls[0].appid).toBe(appid);
        expect(calls[0].reason).toBe(2);
    });

    test('Successful gesture suppresses the native context menu', async ({ page }) => {
        await gotoSearch(page);

        const { link } = await pickFirstAppLink(page, LIST_ITEM);
        await rightClickSwipe(page, link, 60);
        await page.waitForTimeout(200);

        const spy = await readContextMenuSpy(page);
        // The detector listens in capture phase and calls preventDefault, so
        // any contextmenu that did fire must show up as prevented.
        if (spy.fired > 0) expect(spy.prevented).toBe(spy.fired);
    });

    test('Dedup: second swipe on the same capsule does not fire another API call', async ({ page }) => {
        await gotoSearch(page);

        const { link, appid } = await pickFirstAppLink(page, LIST_ITEM);
        await rightClickSwipe(page, link, 60);
        await page.waitForTimeout(300);
        await rightClickSwipe(page, link, 60);
        await page.waitForTimeout(300);

        const calls = await getApiCalls(page);
        expect(calls).toHaveLength(1);
        expect(calls[0].appid).toBe(appid);
    });
});
