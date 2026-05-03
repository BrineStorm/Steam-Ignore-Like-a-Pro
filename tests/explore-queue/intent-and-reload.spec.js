const { test, expect } = require('@playwright/test');
const { AUTH_FILE, SEL, APP_A, APP_B, openExploreQueue, readSession } = require('./_helpers');

test.use({ storageState: AUTH_FILE });

test.describe('Explore Queue — intent persistence and navigation', () => {

    test('Run sets ACTIVE intent and ACTIVE_APPID in sessionStorage', async ({ page }) => {
        await openExploreQueue(page, APP_A);

        await page.locator(SEL.runBtn).click();
        await page.waitForTimeout(300);

        const session = await readSession(page);
        expect(session.ACTIVE).toBe('true');
        expect(session.ACTIVE_APPID).toBe(String(APP_A));
    });

    test('Reload of same queue page in ACTIVE state does NOT show start prompt (regression: EQ reload bug)', async ({ page }) => {
        await openExploreQueue(page, APP_A);

        await page.locator(SEL.runBtn).click();
        await page.waitForTimeout(300);

        // Without the fix, reload would clear the intent and re-show the prompt.
        await page.reload();
        await page.waitForTimeout(2000);

        // Start prompt's Run button must not reappear. Either no toast (decided
        // immediately and applied visuals) or a running toast with STOP — never
        // the start prompt with #ilap-run-btn.
        await expect(page.locator(SEL.runBtn)).toHaveCount(0);

        const session = await readSession(page);
        expect(session.ACTIVE).toBe('true');
        expect(session.ACTIVE_APPID).toBe(String(APP_A));
    });

    test('Sideways navigation to a different appid without nav token re-shows the start prompt', async ({ page }) => {
        await openExploreQueue(page, APP_A);

        await page.locator(SEL.runBtn).click();
        await page.waitForTimeout(300);

        // Direct URL change to a different game (no _scheduleNextClick token issued).
        await openExploreQueue(page, APP_B);

        await expect(page.locator(SEL.runBtn)).toBeVisible({ timeout: 15000 });

        const session = await readSession(page);
        expect(session.ACTIVE).toBeNull();
        expect(session.ACTIVE_APPID).toBeNull();
    });

    test('Manual click on Steam Next button while ACTIVE issues a nav token', async ({ page }) => {
        await openExploreQueue(page, APP_A);

        const nextBtn = page.locator(SEL.nextBtn);
        if ((await nextBtn.count()) === 0) {
            test.skip(true, 'Steam did not render #nextInDiscoveryQueue on this page.');
            return;
        }

        await page.locator(SEL.runBtn).click();
        await page.waitForTimeout(300);

        // Synchronously dispatch click + read token in the same JS turn so we
        // observe the listener's effect before any navigation kicks in.
        const token = await page.evaluate(() => {
            const btn = document.querySelector('#nextInDiscoveryQueue .btn_next_in_queue_trigger');
            if (!btn) return null;
            const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
            btn.dispatchEvent(ev);
            return sessionStorage.getItem('ilap_queue_nav_token');
        });

        expect(token).not.toBeNull();
    });
});
