const { test, expect } = require('../_fixtures.js');
const {
    SEL,
    interceptIgnoreApi,
    rightClickSwipe,
    pickFirstRow,
    searchRow,
    waitForContentScript,
} = require('./_helpers');
const {
    getExtensionId,
    clearExtensionStorage,
    setExtensionStorage,
    getExtensionStorage,
    popupUrl,
} = require('../_extension.js');

const SEARCH_URL = '/search/?term=action';

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

    test('After ignore: popup shows Last Ignored and history dropdown lists the game name', async ({ page, context }) => {
        // 1) Drive a real ignore from the search page. The ignore POST is
        //    intercepted, but saveStats / getGameName are NOT — they hit
        //    chrome.storage.local and the real DOM-based name extractor.
        const calls = await interceptIgnoreApi(context);
        await page.goto(SEARCH_URL);
        await waitForContentScript(page);

        const { link, appid } = await pickFirstRow(page);

        // Capture the rendered name so we can assert it ends up in the popup.
        // ConfigService default is swipeRight → reason=0. The same name
        // extraction path feeds the badge and the stats, so the popup should
        // show this exact string.
        const expectedName = (await searchRow(page, appid).locator('.title').first()
            .textContent().catch(() => null) || '').trim();

        await rightClickSwipe(page, link, 60);
        await expect(searchRow(page, appid).locator(SEL.overlay)).toBeVisible({ timeout: 5000 });
        await expect.poll(() => calls.length, { timeout: 5000 }).toBe(1);

        // 2) Wait until storage actually lands. The save is async (chained
        //    chrome.storage.local.get → set), so poll instead of sleeping.
        await expect.poll(
            async () => (await getExtensionStorage(context, 'ilap_ignored_count')).ilap_ignored_count,
            { timeout: 5000 }
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

        await expect(popup.locator('#count-link')).toHaveText('1');
        await expect(popup.locator(SEL.lastGame)).toHaveText(recordedName);

        // Hover trigger reveals .history-tooltip via CSS :hover. Playwright's
        // .hover() dispatches a real mousemove which trips the rule.
        const trigger = popup.locator(SEL.historyTrigger);
        await trigger.hover();
        const list = popup.locator(SEL.historyList);
        await expect(list).toBeVisible({ timeout: 2000 });
        await expect(list).toContainText(recordedName);

        // The single ignored game should be the only history entry.
        await expect(list.locator('.history-entry')).toHaveCount(1);

        await popup.close();
    });

    test('After Shift+Click (Already Played): history source is "Played Elsewhere"', async ({ page, context }) => {
        // Map Shift+Click to platform (reason=2). Default stays as right swipe.
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'swipeRight',
            ilap_platform_key: 'shiftKey',
        });

        const calls = await interceptIgnoreApi(context);
        await page.goto(SEARCH_URL);
        await waitForContentScript(page);
        await page.waitForTimeout(400);

        const { link, appid } = await pickFirstRow(page);
        await link.scrollIntoViewIfNeeded();
        await link.click({ modifiers: ['Shift'], force: true });

        await expect(searchRow(page, appid).locator(SEL.overlay)).toBeVisible({ timeout: 5000 });
        await expect.poll(() => calls.length, { timeout: 5000 }).toBe(1);

        await expect.poll(
            async () => (await getExtensionStorage(context, 'ilap_ignored_count')).ilap_ignored_count,
            { timeout: 5000 }
        ).toBe(1);

        const stored = await getExtensionStorage(context, 'ilap_ignored_history');
        expect(stored.ilap_ignored_history[0].source).toBe('Played Elsewhere');

        // Popup confirms the same record.
        const extId = await getExtensionId(context);
        const popup = await context.newPage();
        await popup.goto(popupUrl(extId));
        await popup.locator(SEL.historyTrigger).hover();
        await expect(popup.locator(SEL.historyList))
            .toContainText(stored.ilap_ignored_history[0].name);
        await popup.close();
    });
});
