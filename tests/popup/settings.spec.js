const { test, expect } = require('@playwright/test');
const {
    getExtensionId,
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

async function openPopupAndExpandSettings(page, context) {
    const extId = await getExtensionId(context);
    await page.goto(popupUrl(extId));
    await page.locator('#settings-accordion summary').click();
    // Settings render lazily on accordion toggle; give it a tick.
    await page.locator('#default-key').waitFor({ timeout: 5000 });
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Popup — settings accordion', () => {

    test('Queue master toggle: defaults ON, click writes ilap_q_master=false', async ({ page, context }) => {
        await openPopupAndExpandSettings(page, context);

        const qMaster = page.locator('#q-master');
        await expect(qMaster).toBeChecked();

        await qMaster.click();
        await page.waitForTimeout(300);

        const stored = await getExtensionStorage(context, 'ilap_q_master');
        expect(stored.ilap_q_master).toBe(false);
        await expect(page.locator('#q-sub-settings')).toHaveClass(/dimmed/);
    });

    test('Click-Next-after-ignore toggle persists ilap_q_next', async ({ page, context }) => {
        await openPopupAndExpandSettings(page, context);

        const qNext = page.locator('#q-next');
        await expect(qNext).not.toBeChecked();

        await qNext.click();
        await page.waitForTimeout(300);

        const stored = await getExtensionStorage(context, 'ilap_q_next');
        expect(stored.ilap_q_next).toBe(true);
    });

    test('Ignore mode toggle bad ↔ all persists ilap_q_mode', async ({ page, context }) => {
        await openPopupAndExpandSettings(page, context);

        const qMode = page.locator('#q-mode-toggle');
        await expect(qMode).not.toBeChecked(); // default: bad

        await qMode.click();
        await page.waitForTimeout(300);
        let stored = await getExtensionStorage(context, 'ilap_q_mode');
        expect(stored.ilap_q_mode).toBe('all');

        await qMode.click();
        await page.waitForTimeout(300);
        stored = await getExtensionStorage(context, 'ilap_q_mode');
        expect(stored.ilap_q_mode).toBe('bad');
    });

    test('Default shortcut select: changing value writes ilap_shortcut_key and updates the dynamic hint', async ({ page, context }) => {
        await openPopupAndExpandSettings(page, context);

        const select = page.locator('#default-key');
        await expect(select).toHaveValue('swipeRightRight');

        await select.selectOption('ctrlKey');
        await page.waitForTimeout(400);

        const stored = await getExtensionStorage(context, 'ilap_shortcut_key');
        expect(stored.ilap_shortcut_key).toBe('ctrlKey');
        await expect(page.locator('#dynamic-hint')).toContainText(/ctrl/i);
    });

    test('Already-Played shortcut: setting to "off" hides the second hint line', async ({ page, context }) => {
        // Start with a non-off value so the second hint line is present.
        await setExtensionStorage(context, { ilap_platform_key: 'shiftKey' });
        await openPopupAndExpandSettings(page, context);

        await expect(page.locator('#dynamic-hint')).toContainText(/already played/i);

        await page.locator('#platform-key').selectOption('off');
        await page.waitForTimeout(400);

        const stored = await getExtensionStorage(context, 'ilap_platform_key');
        expect(stored.ilap_platform_key).toBe('off');
        await expect(page.locator('#dynamic-hint')).not.toContainText(/already played/i);
    });

    test('Default and Already-Played selectors mutually exclude their chosen values', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'ctrlKey',
            ilap_platform_key: 'shiftKey',
        });
        await openPopupAndExpandSettings(page, context);

        const platOptions = page.locator('#platform-key option');
        const ctrlOpt = platOptions.locator('[value="ctrlKey"]');
        await expect(ctrlOpt).toBeDisabled();

        const defOptions = page.locator('#default-key option');
        const shiftOpt = defOptions.locator('[value="shiftKey"]');
        await expect(shiftOpt).toBeDisabled();
    });
});
