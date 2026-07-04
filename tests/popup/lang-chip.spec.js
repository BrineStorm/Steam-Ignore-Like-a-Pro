const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

// Regression for the language-chip focus-trap (ui/popup_main.js setupLangChip):
// the chip's <select> widens on :focus (anchored right, extending LEFT) so its
// native dropdown is readable, but the transparent overflow then covered the
// SETTINGS bar and swallowed clicks meant for the accordion — re-opening the
// language list instead of toggling Settings. Repro: focus the chip, then click
// just LEFT of it (onto the widened overflow). Expected: Settings toggles and
// the language field does NOT take over (the select is blurred, not focused).
// Popup window only — no Steam login.

async function openPopup(page, context) {
    const extId = await getExtensionId(context);
    await page.goto(popupUrl(extId));
    await page.locator('#popup-root').waitFor({ timeout: 5000 });
}

// A point one pixel to the LEFT of the visible chip, vertically centred — lands
// on the focus-widened (invisible) part of the <select> that overlaps the bar.
async function pointLeftOfChip(page) {
    const box = await page.locator('.lang-chip').boundingBox();
    return { x: box.x - 1, y: box.y + box.height / 2 };
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

test.describe('Popup — language chip focus-trap', () => {

    test('clicking just left of the focused chip toggles Settings, not the language list', async ({ page, context }) => {
        await openPopup(page, context);

        const settings = page.locator('#settings-accordion');
        const chip = page.locator('#lang-quick');

        // Starts collapsed.
        await expect(settings).toHaveJSProperty('open', false);

        // Focus the chip → its select widens over the SETTINGS bar (the bug's setup).
        await chip.focus();
        await expect(chip).toBeFocused();

        // Click on the widened overflow, just left of the chip.
        const p1 = await pointLeftOfChip(page);
        await page.mouse.click(p1.x, p1.y);

        // Settings EXPANDED, and the language field did NOT open (select blurred).
        await expect(settings).toHaveJSProperty('open', true);
        await expect(chip).not.toBeFocused();

        // And it toggles back (collapse) on a repeat of the same gesture.
        await chip.focus();
        const p2 = await pointLeftOfChip(page);
        await page.mouse.click(p2.x, p2.y);
        await expect(settings).toHaveJSProperty('open', false);
        await expect(chip).not.toBeFocused();
    });

    test('a genuine click on the chip still opens the language picker (focus kept)', async ({ page, context }) => {
        await openPopup(page, context);

        const settings = page.locator('#settings-accordion');
        const chip = page.locator('#lang-quick');

        await expect(settings).toHaveJSProperty('open', false);

        // Clicking the visible chip focuses it and must NOT toggle Settings.
        await chip.click();
        await expect(chip).toBeFocused();
        await expect(settings).toHaveJSProperty('open', false);
    });
});
