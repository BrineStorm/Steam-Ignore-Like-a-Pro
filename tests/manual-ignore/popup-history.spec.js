const { test, expect } = require('../_fixtures.js');
const {
    SEL,
    DRAIN_TIMEOUT,
    rightClickSwipe,
    pickFirstRow,
    searchRow,
    gotoWithStubs,
} = require('./_helpers');
const {
    getExtensionId,
    clearExtensionStorage,
    setExtensionStorage,
    getExtensionStorage,
    popupUrl,
} = require('../_extension.js');
const { searchUrl } = require('../_search.js');

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    // popup.html defaults to the widget-surface SIGNPOST STUB (the surface-switch
    // feature); the full stats/history UI these tests read (#count-link, history
    // dropdown) only renders in popup mode. Seed it so the popup hosts the real UI
    // — same fix the tests under tests/popup/ got; this spec lives elsewhere and
    // was missed.
    await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — stats reach the popup history', () => {

    test('After ignore: popup shows the game in Last Ignored, with no dropdown for a single entry', async ({ page, context }) => {
        // 1) Drive a real ignore from the search page. The ignore POST and the
        //    userdata read are intercepted, but saveStats / getGameName are NOT
        //    — they hit chrome.storage.local and the real DOM-based name
        //    extractor. Note the stats are written by the DRAINER when the
        //    deferred POST lands (name captured at swipe time), not by the
        //    swipe itself — that's what the polls below wait for.
        const calls = await gotoWithStubs(page, context, searchUrl());

        const { link, appid } = await pickFirstRow(page);

        // Capture the rendered name so we can assert it ends up in the popup.
        // ConfigService default is swipeRight → reason=0. The same name
        // extraction path feeds the badge and the stats, so the popup should
        // show this exact string.
        const expectedName = (await searchRow(page, appid).locator('.title').first()
            .textContent().catch(() => null) || '').trim();

        await rightClickSwipe(page, link, 60);
        await expect(searchRow(page, appid).locator(SEL.overlay)).toBeVisible({ timeout: DRAIN_TIMEOUT });
        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);

        // 2) Wait until storage actually lands. The save is async (chained
        //    chrome.storage.local.get → set), so poll instead of sleeping.
        await expect.poll(
            async () => (await getExtensionStorage(context, 'ilap_ignored_count')).ilap_ignored_count,
            { timeout: DRAIN_TIMEOUT }
        ).toBe(1);

        const stored = await getExtensionStorage(context, ['ilap_last_ignored_name', 'ilap_ignored_history']);
        expect(stored.ilap_last_ignored_name).toBeTruthy();
        expect(Array.isArray(stored.ilap_ignored_history)).toBe(true);
        expect(stored.ilap_ignored_history.length).toBe(1);
        const recordedName = stored.ilap_ignored_history[0].name;
        expect(recordedName).toBeTruthy();
        // Source is "Default Ignore" for reason=0.
        expect(stored.ilap_ignored_history[0].source).toBe('Default Ignore');
        // Sanity: if we managed to scrape a name from the row, it should be the
        // same one the Steam-side extractor used.
        if (expectedName) expect(recordedName).toBe(expectedName);

        // 3) Open the popup and verify the UI surfaces the same data.
        const extId = await getExtensionId(context);
        const popup = await context.newPage();
        await popup.goto(popupUrl(extId));

        // The headline is the extension's own counter: this one ignore.
        await expect(popup.locator('#count-link')).toHaveText('1');
        await expect(popup.locator(SEL.lastGame)).toHaveText(recordedName);

        // The box shows the newest entry and the list goes on from the next one,
        // so with a single ignore there is no list to drop down.
        const trigger = popup.locator(SEL.historyTrigger);
        await expect(trigger).toHaveClass(/no-more/);
        await trigger.hover();
        await expect(popup.locator(SEL.historyList)).toBeHidden();

        await popup.close();
    });

    test('After Shift+Click (Already Played): history source is "Played Elsewhere"', async ({ page, context }) => {
        // Map Shift+Click to platform (reason=2). Default stays as right swipe.
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'swipeRight',
            ilap_platform_key: 'shiftKey',
        });

        const calls = await gotoWithStubs(page, context, searchUrl());
        await page.waitForTimeout(400);

        const { link, appid } = await pickFirstRow(page);
        await link.scrollIntoViewIfNeeded();
        await link.click({ modifiers: ['Shift'], force: true });

        await expect(searchRow(page, appid).locator(SEL.overlay)).toBeVisible({ timeout: DRAIN_TIMEOUT });
        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);

        await expect.poll(
            async () => (await getExtensionStorage(context, 'ilap_ignored_count')).ilap_ignored_count,
            { timeout: DRAIN_TIMEOUT }
        ).toBe(1);

        const stored = await getExtensionStorage(context, 'ilap_ignored_history');
        expect(stored.ilap_ignored_history[0].source).toBe('Played Elsewhere');

        // Popup confirms the same record.
        const extId = await getExtensionId(context);
        const popup = await context.newPage();
        await popup.goto(popupUrl(extId));
        await expect(popup.locator(SEL.lastGame))
            .toHaveText(stored.ilap_ignored_history[0].name);
        await popup.close();
    });
});
