const { test, expect } = require('../_fixtures.js');
const { AUTH_FILE, SEL, openExploreQueue } = require('./_helpers');
const { setExtensionStorage, getExtensionStorage } = require('../_extension.js');

test.use({ storageState: AUTH_FILE });

test.describe('Explore Queue — Disable button', () => {

    // Roll back the master flag after each run so subsequent EQ tests still see it ON.
    test.afterEach(async ({ context }) => {
        await setExtensionStorage(context, { ilap_q_master: true });
    });

    test('Disable removes the toast, writes ilap_q_master=false, and prevents prompt on reload', async ({ page, context }) => {
        await openExploreQueue(page);

        await expect(page.locator(SEL.toast)).toBeVisible({ timeout: 15000 });
        await page.locator(SEL.disableBtn).click();
        await expect(page.locator(SEL.toast)).toHaveCount(0);

        const stored = await getExtensionStorage(context, 'ilap_q_master');
        expect(stored.ilap_q_master).toBe(false);

        // Master flag off → script bails out before _showStartPrompt on reload.
        await page.reload();
        await page.waitForTimeout(2000);
        await expect(page.locator(SEL.toast)).toHaveCount(0);
    });

    test('Turning ilap_q_master off elsewhere (widget/popup) removes the live toast without reload', async ({ page, context }) => {
        await openExploreQueue(page);
        await expect(page.locator(SEL.toast)).toBeVisible({ timeout: 15000 });

        // The on-page widget (or popup) flips the queue master from another context;
        // the EQ automator must tear the toast down live, not only on next load.
        await setExtensionStorage(context, { ilap_q_master: false });

        await expect(page.locator(SEL.toast)).toHaveCount(0);
    });
});
