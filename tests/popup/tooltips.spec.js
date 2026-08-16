const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

// The popup's OWN tooltips (the ones we draw, not the browser's `title` bubble),
// checked against the panel's edges in every locale we ship.
//
// The popup window is a fixed 320px box with `body { overflow: hidden }`, so
// anything an absolutely-positioned tooltip pushes past that edge is silently cut
// — which is how the undo hint used to render as "Nothing to u". All three tips
// anchor to a full-width row instead of to their small trigger; the language tip is
// additionally clamped to that row and the Auto-advance one wraps inside it
// (ui/popup.css). The undo tip is not clamped, so this spec is its only guard
// rail — it walks the whole language
// list on purpose: English is one of the SHORTEST strings we ship, so a
// single-locale check proves almost nothing.

const logEntry = (appid) => ({ appid: String(appid), ts: Date.now(), source: 'mi' });

async function openPopup(page, context) {
    const extId = await getExtensionId(context);
    await page.goto(popupUrl(extId));
    await page.locator('#popup-root').waitFor({ timeout: 5000 });
}

// Every locale the chip can actually switch to, read from the extension itself so
// this list can never drift from src/i18n.js.
function shippedLocales(page) {
    return page.evaluate(() =>
        window.ILAP.i18n.getLanguages().filter(l => l.translated).map(l => l.code));
}

// Switch the popup's language and wait until the re-render has landed.
async function useLocale(page, context, code) {
    await setExtensionStorage(context, { ilap_lang: code });
    await expect(page.locator('#lang-quick')).toHaveValue(code);
}

// Park the cursor in a corner that belongs to no tooltip trigger.
const unhover = (page) => page.mouse.move(2, 2);

// Hover a trigger until ITS tooltip is actually up. The retry is not "wait a bit
// longer": every step here writes storage and the popup re-renders on onChanged,
// and a re-render that swaps the node out from under a STATIONARY cursor leaves
// CSS :hover unset until the mouse moves again — so each attempt moves the mouse
// away and back rather than extending the timeout.
async function hoverForTip(page, triggerSel, tipSel, locale) {
    const tip = page.locator(tipSel);
    for (let attempt = 0; attempt < 3; attempt++) {
        await unhover(page);
        await page.locator(triggerSel).hover();
        try {
            await expect(tip).toBeVisible({ timeout: 2000 });
            return;
        } catch (e) { /* the re-render ate the hover — move the mouse again */ }
    }
    await expect(tip, `${tipSel} must appear on hover (${locale})`).toBeVisible();
}

// A tooltip passes when it sits fully inside the panel AND its text fits its own
// box — a clamped box with overflowing text still reads as cut off.
async function expectFits(page, selector, locale) {
    const tip = page.locator(selector);
    await expect(tip, `${selector} must appear on hover (${locale})`).toBeVisible();

    const box = await tip.boundingBox();
    const root = await page.locator('#popup-root').boundingBox();
    const where = `${selector} @ ${locale}`;

    expect(box.width, `${where}: renders empty`).toBeGreaterThan(0);
    expect(box.x, `${where}: cut off on the left`).toBeGreaterThanOrEqual(root.x - 0.5);
    expect(box.x + box.width, `${where}: cut off on the right`)
        .toBeLessThanOrEqual(root.x + root.width + 0.5);
    expect(box.y, `${where}: cut off at the top`).toBeGreaterThanOrEqual(root.y - 0.5);
    expect(box.y + box.height, `${where}: cut off at the bottom`)
        .toBeLessThanOrEqual(root.y + root.height + 0.5);

    const overflow = await tip.evaluate(el => el.scrollWidth - el.clientWidth);
    expect(overflow, `${where}: text overflows its own box`).toBeLessThanOrEqual(1);
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Popup — our own tooltips fit the panel', () => {

    test('the undo tooltip fits in every locale, enabled and disabled alike', async ({ page, context }) => {
        test.setTimeout(3 * 60 * 1000);
        await openPopup(page, context);

        const locales = await shippedLocales(page);
        expect(locales.length, 'the locale list should not have collapsed').toBeGreaterThan(15);

        for (const code of locales) {
            await useLocale(page, context, code);

            // Empty log → the disabled button and the LONG string ("Nothing to
            // undo yet"), the exact state that used to clip. Hover lands on the
            // wrapper, which catches it even though the button is disabled.
            await setExtensionStorage(context, { ilap_ignore_log: [] });
            await expect(page.locator('#undo-btn')).toBeDisabled();
            await hoverForTip(page, '.undo-btn-wrap', '#undo-tip', code);
            await expectFits(page, '#undo-tip', code);
            await unhover(page);

            // Undoable entries → the enabled button and its own caption.
            await setExtensionStorage(context, { ilap_ignore_log: [logEntry(10)] });
            await expect(page.locator('#undo-btn')).toBeEnabled();
            await hoverForTip(page, '.undo-btn-wrap', '#undo-tip', code);
            await expectFits(page, '#undo-tip', code);
            await unhover(page);
        }
    });

    test('the language tooltip is ours, not the browser title, and fits in every locale', async ({ page, context }) => {
        test.setTimeout(3 * 60 * 1000);
        await openPopup(page, context);

        // The native bubble is gone: nothing on the chip carries a `title`.
        await expect(page.locator('.lang-chip')).not.toHaveAttribute('title', /./);

        const locales = await shippedLocales(page);

        for (const code of locales) {
            await useLocale(page, context, code);

            // Our element carries the localized string, not a stale English one.
            const expected = await page.evaluate(() => window.ILAP.t('language'));
            await expect(page.locator('#lang-tip')).toHaveText(expected);

            await hoverForTip(page, '.lang-chip', '#lang-tip', code);
            await expectFits(page, '#lang-tip', code);
            await unhover(page);
        }
    });

    test('the Auto-advance tooltip is ours, not the browser title, and fits in every locale', async ({ page, context }) => {
        test.setTimeout(3 * 60 * 1000);
        await openPopup(page, context);

        // Settings render lazily; the row lives in the Discovery Queue subcategory.
        await page.locator('#settings-accordion > summary').click();
        await page.locator('#dq-section summary .section-title').click();
        await expect(page.locator('#dq-section')).toHaveJSProperty('open', true);

        // The native bubble is gone: nothing on the row carries a `title`.
        await expect(page.locator('.dq-next-row')).not.toHaveAttribute('title', /./);

        const locales = await shippedLocales(page);

        for (const code of locales) {
            await useLocale(page, context, code);

            const expected = await page.evaluate(() => window.ILAP.t('tooltip_dq_next'));
            await expect(page.locator('.dq-next-tip')).toHaveText(expected);

            // Unlike the other two this tip WRAPS inside the row it is stretched
            // across, so what is measured here is the wrapped box, not a nowrap one.
            await hoverForTip(page, '.dq-next-row', '.dq-next-tip', code);
            await expectFits(page, '.dq-next-tip', code);
            await unhover(page);
        }
    });

    test('opening the language list hides the tooltip instead of stacking it', async ({ page, context }) => {
        await openPopup(page, context);

        await hoverForTip(page, '.lang-chip', '#lang-tip', 'default');

        await page.locator('.lang-chip').click();
        await expect(page.locator('.lang-chip .select-menu')).toHaveClass(/open/);
        // Still hovered (the click leaves the cursor on the chip) — the tip must
        // yield to the list rather than overlap it.
        await expect(page.locator('#lang-tip')).toBeHidden();
    });
});
