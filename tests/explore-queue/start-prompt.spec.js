const { test, expect } = require('@playwright/test');
const { AUTH_FILE, SEL, openExploreQueue } = require('./_helpers');

test.use({ storageState: AUTH_FILE });

test.describe('Explore Queue — start prompt', () => {

    test('Toast appears on first visit with Run / Fast Forward / Disable buttons', async ({ page }) => {
        await openExploreQueue(page);

        const toast = page.locator(SEL.toast);
        await expect(toast).toBeVisible({ timeout: 15000 });
        await expect(toast).toContainText(/queue helper/i);

        await expect(page.locator(SEL.runBtn)).toBeVisible();
        await expect(page.locator(SEL.ffBtn)).toBeVisible();
        await expect(page.locator(SEL.disableBtn)).toBeVisible();
    });

    test('Mode badge defaults to Bad Reviews', async ({ page }) => {
        await openExploreQueue(page);

        const badge = page.locator(SEL.modeBadge);
        await expect(badge).toBeVisible({ timeout: 15000 });
        await expect(badge).toContainText(/bad reviews/i);
    });

    test('Close (✕) hides toast without setting any intent', async ({ page }) => {
        await openExploreQueue(page);

        await expect(page.locator(SEL.toast)).toBeVisible({ timeout: 15000 });
        await page.locator(SEL.closeX).click();
        await expect(page.locator(SEL.toast)).toHaveCount(0);

        const session = await page.evaluate(() => ({
            active: sessionStorage.getItem('ilap_queue_active'),
            ff: sessionStorage.getItem('ilap_queue_ff'),
        }));
        expect(session.active).toBeNull();
        expect(session.ff).toBeNull();
    });
});
