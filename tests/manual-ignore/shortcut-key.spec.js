const { test, expect } = require('../_fixtures.js');
const {
    SEL,
    DRAIN_TIMEOUT,
    rightClickSwipe,
    pickFirstRow,
    searchRow,
    SEARCH_ROW,
    gotoWithStubs,
    miJob,
} = require('./_helpers');
const { clearExtensionStorage, setExtensionStorage } = require('../_extension.js');
const { searchUrl } = require('../_search.js');

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

        const calls = await gotoWithStubs(page, context, searchUrl());
        // ConfigService.listen() picks up storage changes asynchronously.
        await page.waitForTimeout(400);

        const { link, appid } = await pickFirstRow(page);
        await link.scrollIntoViewIfNeeded();
        // Use force:true so Steam's nav overlays don't intercept; the click
        // event still fires through document.body capture-phase listener.
        await link.click({ modifiers: ['Control'], force: true });

        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);
        expect(calls[0].appid).toBe(appid);
        expect(calls[0].reason).toBe(0);

        await expect(searchRow(page, appid).locator(SEL.overlay)).toBeVisible({ timeout: DRAIN_TIMEOUT });
    });

    test('After switching default to ctrlKey: swipeRight no longer triggers ignore', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'ctrlKey',
            ilap_platform_key: 'off',
        });

        const calls = await gotoWithStubs(page, context, searchUrl());
        await page.waitForTimeout(400);

        const { link } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);
        await page.waitForTimeout(500);

        // Nothing may reach the deferral queue either — a POST that hasn't
        // fired yet is no longer evidence that the gesture was ignored.
        expect(await miJob(context)).toBeNull();
        expect(calls).toHaveLength(0);
        await expect(page.locator(SEL.overlay)).toHaveCount(0);
    });

    test('Two click-based shortcuts coexist: Ctrl=default(0), Shift=played(2)', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'ctrlKey',
            ilap_platform_key: 'shiftKey',
        });

        const calls = await gotoWithStubs(page, context, searchUrl());
        await page.waitForTimeout(400);

        // Each search row IS an /app/ link; take two distinct rows so dedup
        // doesn't suppress the second call.
        const rows = page.locator(SEARCH_ROW);
        await rows.first().waitFor({ state: 'attached', timeout: 10000 });
        const firstLink = rows.nth(0);
        const secondLink = rows.nth(1);

        const firstId = (await firstLink.getAttribute('href')).match(/\/app\/(\d+)/)[1];
        const secondId = (await secondLink.getAttribute('href')).match(/\/app\/(\d+)/)[1];
        expect(firstId).not.toBe(secondId);

        await firstLink.scrollIntoViewIfNeeded();
        await firstLink.click({ modifiers: ['Control'], force: true });
        await secondLink.scrollIntoViewIfNeeded();
        await secondLink.click({ modifiers: ['Shift'], force: true });

        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(2);
        const byId = Object.fromEntries(calls.map(c => [c.appid, c.reason]));
        expect(byId[firstId]).toBe(0);
        expect(byId[secondId]).toBe(2);
    });
});
