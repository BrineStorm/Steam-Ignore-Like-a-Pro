const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

// Language chip (ui/popup_main.js setupLangChip): the native <select> is an
// inert value store; clicking the chip opens our own styled .select-menu (the
// OS-rendered dropdown — white flash, unstylable — never shows). The chip sits
// inside the SETTINGS <summary>, so every interaction with it must leave the
// accordion alone (the regression class the old focus-trap bug lived in), and
// a click elsewhere on the bar must toggle Settings AND close the menu.
// Popup window only — no Steam login.

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

test.describe('Popup — language chip styled menu', () => {

    test('chip click opens the styled menu without toggling Settings; second click closes it', async ({ page, context }) => {
        await openPopup(page, context);

        const settings = page.locator('#settings-accordion');
        const chip = page.locator('.lang-chip');
        const menu = page.locator('.lang-chip .select-menu');

        await expect(settings).toHaveJSProperty('open', false);
        await expect(menu).not.toHaveClass(/open/);

        await chip.click();
        await expect(menu).toHaveClass(/open/);
        // The full native names render as our own options, current one marked.
        await expect(menu.locator('.select-opt.selected')).toHaveText('English');
        await expect(settings).toHaveJSProperty('open', false);

        await chip.click();
        await expect(menu).not.toHaveClass(/open/);
        await expect(settings).toHaveJSProperty('open', false);
    });

    test('picking a language closes the menu, updates the chip code and persists ilap_lang', async ({ page, context }) => {
        await openPopup(page, context);

        const settings = page.locator('#settings-accordion');
        const menu = page.locator('.lang-chip .select-menu');

        await page.locator('.lang-chip').click();
        await menu.locator('.select-opt[data-value="de"]').click();

        await expect(menu).not.toHaveClass(/open/);
        await expect(page.locator('#lang-quick-code')).toHaveText('DE');
        await expect(page.locator('#lang-quick')).toHaveValue('de');
        await expect(settings).toHaveJSProperty('open', false);

        const stored = await getExtensionStorage(context, ['ilap_lang']);
        expect(stored.ilap_lang).toBe('de');
    });

    test('clicking the SETTINGS bar with the menu open toggles Settings and closes the menu', async ({ page, context }) => {
        await openPopup(page, context);

        const settings = page.locator('#settings-accordion');
        const menu = page.locator('.lang-chip .select-menu');

        await page.locator('.lang-chip').click();
        await expect(menu).toHaveClass(/open/);

        // A genuine bar click (left of the chip) must behave exactly as if the
        // chip weren't there: Settings expands, the language menu goes away.
        const box = await page.locator('.lang-chip').boundingBox();
        await page.mouse.click(box.x - 40, box.y + box.height / 2);
        await expect(settings).toHaveJSProperty('open', true);
        await expect(menu).not.toHaveClass(/open/);
    });
});
