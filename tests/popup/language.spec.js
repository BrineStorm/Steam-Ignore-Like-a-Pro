const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

// The language tab in the tab line (ui/popup_tabs.js, ui/popup_settings.js
// langGrid): a droplist look with the language's code, left of the settings
// gear, whose pane is the grid of every language by its own name.

// Stable reference strings pulled from src/i18n.js DICT.
const RU_TOTAL = 'Всего скрыто:';
const DE_TOTAL = 'Insgesamt ignoriert:';
const EN_TOTAL = 'Total Ignored:';
const NL_TOTAL = 'Totaal genegeerd:';
const RU_DQ_TITLE = 'Классический список рекомендаций';

async function openPopup(page, context) {
    const extId = await getExtensionId(context);
    await page.goto(popupUrl(extId));
    await page.locator('#popup-root').waitFor({ timeout: 5000 });
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    // popup.html renders the full UI only in popup surface mode (widget mode
    // shows the signpost stub — covered by surface-stub.spec.js).
    await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Popup — language switch', () => {

    test('A pick in the grid writes ilap_lang, folds the tab, shows the new code and relabels the UI', async ({ page, context }) => {
        await openPopup(page, context);

        // Defaults to English.
        await expect(page.locator('#lang-code')).toHaveText('EN');
        await expect(page.locator('[data-i18n="total_ignored"]')).toHaveText(EN_TOTAL);

        await page.locator('#tab-lang').click();
        await expect(page.locator('#lang-pane')).toBeVisible();
        await expect(page.locator('.lang-opt.selected')).toHaveText('English');
        await page.locator('.lang-opt[data-lang="ru"]').click();

        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_lang')).ilap_lang).toBe('ru');
        await expect(page.locator('#tab-lang')).toHaveAttribute('aria-selected', 'false');
        await expect(page.locator('#lang-pane')).toBeHidden();
        await expect(page.locator('#lang-code')).toHaveText('RU');
        await expect(page.locator('[data-i18n="total_ignored"]')).toHaveText(RU_TOTAL);
    });

    test('Every language shows by its own name, two to a row with no empty cell, Dutch among them', async ({ page, context }) => {
        await openPopup(page, context);
        await page.locator('#tab-lang').click();
        const opts = page.locator('.lang-opt');
        const count = await opts.count();
        expect(count).toBe(24);
        expect(count % 2, 'the two columns come out even').toBe(0);
        await expect(page.locator('.lang-opt[data-lang="nl"]')).toHaveText('Nederlands');
        const xs = await opts.evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().left)));
        expect(new Set(xs).size, 'two columns').toBe(2);

        await page.locator('.lang-opt[data-lang="nl"]').click();
        await expect(page.locator('#lang-code')).toHaveText('NL');
        await expect(page.locator('[data-i18n="total_ignored"]')).toHaveText(NL_TOTAL);
    });

    test('Stored ilap_lang is applied on open: code, grid and labels render localized', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_lang: 'de' });
        await openPopup(page, context);

        await expect(page.locator('#lang-code')).toHaveText('DE');
        await expect(page.locator('[data-i18n="total_ignored"]')).toHaveText(DE_TOTAL);
        await page.locator('#tab-lang').click();
        await expect(page.locator('.lang-opt.selected')).toHaveAttribute('data-lang', 'de');
    });

    test('Language change from another context re-renders the popup live', async ({ page, context }) => {
        await openPopup(page, context);
        await expect(page.locator('[data-i18n="total_ignored"]')).toHaveText(EN_TOTAL);

        // Mutate ilap_lang from outside; popup_main.js subscribes to onChanged.
        await setExtensionStorage(context, { ilap_lang: 'ru' });

        await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
        await expect(page.locator('[data-i18n="total_ignored"]')).toHaveText(RU_TOTAL);
        await expect(page.locator('#lang-code')).toHaveText('RU');
    });

    // The language changes elsewhere (the widget, another popup) while the
    // settings tab is open here.
    test('Switching language with settings open relabels the settings panel', async ({ page, context }) => {
        await openPopup(page, context);
        await page.locator('#tab-settings').click();
        await page.locator('#dq-section summary').waitFor({ timeout: 5000 });
        await expect(page.locator('[data-i18n="your_discovery_queue"]')).toHaveText('Classic Discovery Queue');

        await setExtensionStorage(context, { ilap_lang: 'ru' });

        await expect(page.locator('[data-i18n="your_discovery_queue"]')).toHaveText(RU_DQ_TITLE);
        await expect(page.locator('[data-i18n="surface_mode"]')).toHaveText('Интерфейс:');
    });

    // The grid was open when the language changed elsewhere: it stays open on
    // the new language, so the panel does not jump shut.
    test('An open language grid stays open through a language change from elsewhere', async ({ page, context }) => {
        await openPopup(page, context);
        await page.locator('#tab-lang').click();
        await expect(page.locator('#lang-pane')).toBeVisible();

        await setExtensionStorage(context, { ilap_lang: 'fr' });
        await expect(page.locator('.lang-opt.selected')).toHaveAttribute('data-lang', 'fr');
        await expect(page.locator('#tab-lang')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#lang-pane')).toBeVisible();
    });
});
