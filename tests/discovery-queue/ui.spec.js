const { test, expect } = require('@playwright/test');

const AUTH_FILE = 'playwright/.auth/user.json';

test.use({ storageState: AUTH_FILE });

const SEL = {
    modal: '.FullModalOverlay div[role="dialog"]',
    panel: '#ilap-queue-controls',
    button: '#queue-auto-ignore-btn',
    checkbox: '#ilap-queue-controls .ilap-checkbox',
    closeBtn: '.FullModalOverlay div[aria-label="Close"]',
};

// Steam's /explore/ either lands inside an open queue modal or shows a
// "Start a new queue" CTA. This helper covers both.
async function openQueueModal(page) {
    await page.goto('/explore/');

    const modal = page.locator(SEL.modal).first();
    try {
        await modal.waitFor({ state: 'visible', timeout: 5000 });
        return modal;
    } catch (_) { /* fall through to CTA */ }

    const startCta = page.locator('a[href*="/explore/"], button, div[role="button"]')
        .filter({ hasText: /start.*queue|start exploring|next.*queue/i })
        .first();

    if (await startCta.isVisible().catch(() => false)) {
        await startCta.click().catch(() => {});
    }

    await modal.waitFor({ state: 'visible', timeout: 15000 });
    return modal;
}

test.describe('Discovery Queue UI', () => {

    test('Panel injects inside the queue modal with button + checkbox', async ({ page }) => {
        const modal = await openQueueModal(page);

        const panel = modal.locator(SEL.panel);
        await expect(panel).toBeVisible({ timeout: 10000 });

        await expect(panel.locator(SEL.button)).toBeVisible();
        await expect(panel.locator('.ilap-checkbox')).toBeAttached();
        await expect(panel.locator('.ilap-checkbox-label')).toContainText(/keep high score/i);
    });

    test('Button initial state: idle (no running class, "Start Auto Ignore")', async ({ page }) => {
        await openQueueModal(page);

        const btn = page.locator(SEL.button);
        await expect(btn).toBeVisible({ timeout: 10000 });
        await expect(btn).not.toHaveClass(/running/);
        await expect(btn).toContainText(/start auto ignore/i);
    });

    test('Keep High Score checkbox is interactive and toggles state', async ({ page }) => {
        await openQueueModal(page);

        const checkbox = page.locator(SEL.checkbox);
        await expect(checkbox).toBeAttached({ timeout: 10000 });
        await expect(checkbox).not.toBeChecked();

        // Click via label so we cover both label text and the input itself
        await page.locator('#ilap-queue-controls .ilap-checkbox-label').click();
        await expect(checkbox).toBeChecked();

        await page.locator('#ilap-queue-controls .ilap-checkbox-label').click();
        await expect(checkbox).not.toBeChecked();
    });

    // DQ automator clicks Steam's in-page Ignore button — no API calls,
    // no rate limit. Safe to run for real.
    test('Start activates the loop (running class + Stop label), Stop returns to idle', async ({ page }) => {
        test.setTimeout(60_000);
        await openQueueModal(page);

        const btn = page.locator(SEL.button);
        await expect(btn).toBeVisible({ timeout: 10000 });
        await expect(btn).not.toHaveClass(/running/);

        await btn.click();

        await expect(btn).toHaveClass(/running/, { timeout: 5000 });
        await expect(btn).toContainText(/stop/i);

        // Let the automator process a couple of slides for real before stopping.
        await page.waitForTimeout(4000);

        await btn.click();

        await expect(btn).not.toHaveClass(/running/, { timeout: 5000 });
        await expect(btn).toContainText(/start auto ignore/i);
    });

    test('Panel unmounts when the queue modal closes', async ({ page }) => {
        await openQueueModal(page);

        const panel = page.locator(SEL.panel);
        await expect(panel).toBeVisible({ timeout: 10000 });

        // Prefer Steam's own close button; fall back to Escape.
        const close = page.locator(SEL.closeBtn).first();
        if (await close.isVisible().catch(() => false)) {
            await close.click({ force: true });
        } else {
            await page.keyboard.press('Escape');
        }

        await expect(panel).toBeHidden({ timeout: 10000 });
    });
});
