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
const { clearExtensionStorage, setExtensionStorage } = require('../_extension.js');

test.use({ storageState: AUTH_FILE });

const SEARCH_URL = '/search/?term=action';
const LIST_ITEM = '.tab_item';

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — alternative shortcut (Ctrl+Click)', () => {

    test('After switching default to ctrlKey: Ctrl+Click triggers ignore (reason=0)', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'ctrlKey',
            ilap_platform_key: 'off',
        });

        await page.goto(SEARCH_URL);
        await waitForContentScript(page);
        await stubIgnoreApi(page);
        // ConfigService.listen() picks up storage changes asynchronously.
        await page.waitForTimeout(400);

        const { link, appid } = await pickFirstAppLink(page, LIST_ITEM);
        await link.scrollIntoViewIfNeeded();
        // Use force:true so Steam's nav overlays don't intercept; the click
        // event still fires through document.body capture-phase listener.
        await link.click({ modifiers: ['Control'], force: true });
        await page.waitForTimeout(400);

        const calls = await getApiCalls(page);
        expect(calls).toHaveLength(1);
        expect(calls[0].appid).toBe(appid);
        expect(calls[0].reason).toBe(0);

        const item = page.locator(LIST_ITEM)
            .filter({ has: page.locator(`a[href*="/app/${appid}"]`) })
            .first();
        await expect(item.locator(SEL.overlay)).toBeVisible({ timeout: 5000 });
    });

    test('After switching default to ctrlKey: swipeRight no longer triggers ignore', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'ctrlKey',
            ilap_platform_key: 'off',
        });

        await page.goto(SEARCH_URL);
        await waitForContentScript(page);
        await stubIgnoreApi(page);
        await page.waitForTimeout(400);

        const { link } = await pickFirstAppLink(page, LIST_ITEM);
        await rightClickSwipe(page, link, 60);
        await page.waitForTimeout(500);

        expect(await getApiCalls(page)).toHaveLength(0);
        await expect(page.locator(SEL.overlay)).toHaveCount(0);
    });

    test('Two click-based shortcuts coexist: Ctrl=default(0), Shift=played(2)', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'ctrlKey',
            ilap_platform_key: 'shiftKey',
        });

        await page.goto(SEARCH_URL);
        await waitForContentScript(page);
        await stubIgnoreApi(page);
        await page.waitForTimeout(400);

        const items = page.locator(LIST_ITEM);
        await items.first().waitFor({ state: 'attached', timeout: 10000 });

        // Two distinct list items so dedup doesn't suppress the second call.
        const firstLink = items.nth(0).locator('a[href*="/app/"]').first();
        const secondLink = items.nth(1).locator('a[href*="/app/"]').first();

        const firstHref = await firstLink.getAttribute('href');
        const secondHref = await secondLink.getAttribute('href');
        const firstId = firstHref.match(/\/app\/(\d+)/)[1];
        const secondId = secondHref.match(/\/app\/(\d+)/)[1];
        expect(firstId).not.toBe(secondId);

        await firstLink.scrollIntoViewIfNeeded();
        await firstLink.click({ modifiers: ['Control'], force: true });
        await page.waitForTimeout(300);

        await secondLink.scrollIntoViewIfNeeded();
        await secondLink.click({ modifiers: ['Shift'], force: true });
        await page.waitForTimeout(300);

        const calls = await getApiCalls(page);
        expect(calls).toHaveLength(2);
        const byId = Object.fromEntries(calls.map(c => [c.appid, c.reason]));
        expect(byId[firstId]).toBe(0);
        expect(byId[secondId]).toBe(2);
    });
});
