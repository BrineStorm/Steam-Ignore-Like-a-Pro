const { test, expect } = require('@playwright/test');
const {
    getExtensionId,
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

// Stable reference strings pulled from src/i18n.js DICT.
const RU_TOTAL = 'Всего скрыто:';
const DE_TOTAL = 'Insgesamt ignoriert:';
const EN_TOTAL = 'Total Ignored:';
const RU_DQ_TITLE = 'Очередь рекомендаций';

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Popup — language switch', () => {

    test('Selecting a language writes ilap_lang, updates the chip code, and relabels the UI', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        // Defaults to English.
        await expect(page.locator('#lang-quick-code')).toHaveText('EN');
        await expect(page.locator('[data-i18n="total_ignored"]')).toHaveText(EN_TOTAL);

        await page.locator('#lang-quick').selectOption('ru');
        await page.waitForTimeout(400);

        const stored = await getExtensionStorage(context, 'ilap_lang');
        expect(stored.ilap_lang).toBe('ru');
        await expect(page.locator('#lang-quick-code')).toHaveText('RU');
        await expect(page.locator('[data-i18n="total_ignored"]')).toHaveText(RU_TOTAL);
    });

    test('Stored ilap_lang is applied on open: chip + labels render localized', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_lang: 'de' });

        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#lang-quick')).toHaveValue('de');
        await expect(page.locator('#lang-quick-code')).toHaveText('DE');
        await expect(page.locator('[data-i18n="total_ignored"]')).toHaveText(DE_TOTAL);
    });

    test('Language change from another context re-renders the popup live', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('[data-i18n="total_ignored"]')).toHaveText(EN_TOTAL);

        // Mutate ilap_lang from outside; popup_main.js subscribes to onChanged.
        await setExtensionStorage(context, { ilap_lang: 'ru' });
        await page.waitForTimeout(400);

        await expect(page.locator('#lang-quick-code')).toHaveText('RU');
        await expect(page.locator('[data-i18n="total_ignored"]')).toHaveText(RU_TOTAL);
    });

    test('Switching language with settings open relabels the settings panel', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await page.locator('#settings-accordion summary').click();
        await page.locator('#default-key').waitFor({ timeout: 5000 });
        await expect(page.locator('[data-i18n="your_discovery_queue"]')).toHaveText('Your Discovery Queue');

        await page.locator('#lang-quick').selectOption('ru');
        await page.waitForTimeout(400);

        await expect(page.locator('[data-i18n="your_discovery_queue"]')).toHaveText(RU_DQ_TITLE);
    });
});
