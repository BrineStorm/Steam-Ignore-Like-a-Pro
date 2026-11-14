const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

// The popup's OWN tooltips (the ones we draw, not the browser's `title` bubble),
// checked against the panel's edges in every locale we ship.
//
// The popup window is a fixed 320px box with `body { overflow: hidden }`, so
// anything an absolutely-positioned tooltip pushes past that edge is silently cut
// — which is how the undo hint used to render as "Nothing to u". The tips
// anchor to a full-width row instead of to their small trigger; the tab line's tip
// is additionally clamped to that line and the Auto-advance one wraps inside it
// (ui/popup.css). The undo tip is not clamped, so this spec is its only guard
// rail — it walks the whole language
// list on purpose: English is one of the SHORTEST strings we ship, so a
// single-locale check proves almost nothing.

const logEntry = (appid) => ({ appid: String(appid), ts: Date.now(), source: 'mi' });

async function openPopup(page, context) {
    const extId = await getExtensionId(context);
    await page.goto(popupUrl(extId));
    await page.locator('#popup-root').waitFor({ timeout: 5000 });
    // Transitions stay off through the first render (.no-transition), and a tip
    // hovered under that guard skips its delay.
    await expect(page.locator('#popup-root')).not.toHaveClass(/no-transition/);
}

// Every locale the language droplist can actually switch to, read from the extension itself so
// this list can never drift from src/i18n.js.
function shippedLocales(page) {
    return page.evaluate(() =>
        window.ILAP.i18n.getLanguages().filter(l => l.translated).map(l => l.code));
}

// Switch the popup's language and wait until the re-render has landed.
async function useLocale(page, context, code) {
    await setExtensionStorage(context, { ilap_lang: code });
    await expect(page.locator('html')).toHaveAttribute('lang', code);
}

// Park the cursor in a corner that belongs to no tooltip trigger.
const unhover = (page) => page.mouse.move(2, 2);

// The settings tab and the subcategory open with a height motion: hover and
// measure only once the row has stopped moving, or it slides out from under the
// pointer and the panel stands shorter than it settles. A motion cut short (the
// gear's hover growth, once the pointer leaves the tab) rejects its `finished`,
// which is just as settled.
const panelSettled = (page) => page.locator('#tab-panel').evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))));

// The undo tip waits 2.5s before it appears, the Auto-advance tip 2s and the
// tab line's 0.4s (see the dedicated tests below). What THESE walks measure is geometry,
// not patience, so they drop the delay rather than paying it 19 times per locale list.
const dropTipDelay = (page) => page.addStyleTag({
    content: '#undo-tip, #tab-tip, .dq-next-tip, #count-tip { transition-delay: 0s !important; }',
});

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
        await dropTipDelay(page);

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

    test('the Total Ignored tip fits in every locale, read and not read yet alike', async ({ page, context }) => {
        test.setTimeout(3 * 60 * 1000);
        await openPopup(page, context);
        await dropTipDelay(page);

        const locales = await shippedLocales(page);
        for (const code of locales) {
            await useLocale(page, context, code);

            // Not read yet → the long sentence; it wraps across the row.
            await setExtensionStorage(context, { ilap_ignored_total: null });
            await hoverForTip(page, '#count-link', '#count-tip', code);
            await expect(page.locator('#count-tip b')).toHaveCount(0);
            await expectFits(page, '#count-tip', code);
            await unhover(page);

            // Read → Steam's number in bold, then the read time.
            await setExtensionStorage(context, { ilap_ignored_total: { total: 123456, tallyAt: 0, ts: Date.now() } });
            await hoverForTip(page, '#count-link', '#count-tip', code);
            await expect(page.locator('#count-tip b')).toHaveText('123456');
            await expectFits(page, '#count-tip', code);
            // Two short lines: the box hugs its text instead of spanning the row.
            const tipW = (await page.locator('#count-tip').boundingBox()).width;
            const rowW = (await page.locator('#total-row').boundingBox()).width;
            expect(tipW, `#count-tip @ ${code}: as wide as its text`).toBeLessThan(rowW - 10);
            await unhover(page);
        }
    });

    test('the Total Ignored tip waits 1.5s before it appears', async ({ page, context }) => {
        await openPopup(page, context);
        await unhover(page);
        await page.locator('#count-link').hover();
        await page.waitForTimeout(800);
        await expect(page.locator('#count-tip'), '#count-tip must still be down after 0.8s').toBeHidden();
        await expect(page.locator('#count-tip')).toBeVisible({ timeout: 3000 });
    });

    test('the tab line tooltips are ours, not the browser title, name their button and fit in every locale', async ({ page, context }) => {
        test.setTimeout(4 * 60 * 1000);
        await openPopup(page, context);
        await dropTipDelay(page);

        // The native bubble is gone: nothing on the line has a `title`.
        const buttons = ['#lists-btn', '#tab-ai', '#tab-lang', '#tab-settings'];
        for (const sel of buttons) await expect(page.locator(sel)).not.toHaveAttribute('title', /./);

        const locales = await shippedLocales(page);

        for (const code of locales) {
            await useLocale(page, context, code);
            for (const sel of buttons) {
                // The tip says what the button's aria-label says, in this language.
                const name = await page.locator(sel).getAttribute('aria-label');
                expect(name, `${sel} has a name (${code})`).toBeTruthy();
                await hoverForTip(page, sel, '#tab-tip', code);
                await expect(page.locator('#tab-tip')).toHaveText(name);
                await expectFits(page, '#tab-tip', `${code} ${sel}`);
                await unhover(page);
            }
        }
    });

    test('the DQ master tooltip is ours, not the browser title, and fits in every locale', async ({ page, context }) => {
        test.setTimeout(3 * 60 * 1000);
        await openPopup(page, context);

        // The subcategory summary is visible as soon as the settings tab is open — the
        // section itself can stay collapsed, which is where the tip has the least
        // room under it (it hangs over the Manual Ignore row).
        await page.locator('#tab-settings').click();
        await expect(page.locator('#dq-section')).toBeVisible();

        // The native bubble is gone: nothing on the switch has a `title`.
        await expect(page.locator('#dq-section > summary .switch')).not.toHaveAttribute('title', /./);

        const locales = await shippedLocales(page);

        for (const code of locales) {
            await useLocale(page, context, code);

            const expected = await page.evaluate(() => window.ILAP.t('tooltip_dq_master'));
            await expect(page.locator('.dq-master-tip')).toHaveText(expected);

            // Like the Auto-advance tip this one WRAPS inside the row it is
            // stretched across, so the measured box is the wrapped one.
            await hoverForTip(page, '#dq-section > summary .switch', '.dq-master-tip', code);
            await expectFits(page, '.dq-master-tip', code);
            await unhover(page);
        }
    });

    test('the Auto-advance tooltip is ours, not the browser title, and fits in every locale', async ({ page, context }) => {
        test.setTimeout(3 * 60 * 1000);
        await openPopup(page, context);
        await dropTipDelay(page);

        // Settings render lazily; the row lives in the Discovery Queue subcategory.
        await page.locator('#tab-settings').click();
        await page.locator('#dq-section summary .section-title').click();
        await expect(page.locator('#dq-section')).toHaveJSProperty('open', true);
        // A locale switch rebuilds the section from the stored open flag, which
        // the async `toggle` event writes. Switching before it lands rebuilt the
        // section collapsed for the rest of the walk.
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_dq_open')).ilap_dq_open).toBe(true);
        await panelSettled(page);

        // The native bubble is gone: nothing on the row has a `title`.
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

    test('the undo tip waits 2.5s before it appears', async ({ page, context }) => {
        // It sits on a control the cursor crosses on its way elsewhere, so it
        // holds back far longer than the 0.4s the rest of the panel uses.
        await setExtensionStorage(context, { ilap_ignore_log: [logEntry(10)] });
        await openPopup(page, context);

        await unhover(page);
        await page.locator('.undo-btn-wrap').hover();
        await page.waitForTimeout(1000);
        await expect(page.locator('#undo-tip'), '#undo-tip must still be down after 1s').toBeHidden();
        await expect(page.locator('#undo-tip')).toBeVisible({ timeout: 4000 });
    });

    test('a tab tip waits 0.4s before it appears, and a press puts it down', async ({ page, context }) => {
        // The tabs are glyphs, so their names are aimed at: the short dwell.
        await openPopup(page, context);
        await unhover(page);
        await page.locator('#tab-ai').hover();
        await page.waitForTimeout(150);
        await expect(page.locator('#tab-tip'), 'the tip must still be down after 0.15s').toBeHidden();
        await expect(page.locator('#tab-tip')).toBeVisible({ timeout: 2000 });

        // Still hovered after the click — the tip yields to the pane it opened.
        await page.locator('#tab-ai').click();
        await expect(page.locator('#tab-tip')).toBeHidden();
    });

    test('the lists button tip stays down while its drawer is out', async ({ page, context }) => {
        await openPopup(page, context);
        await unhover(page);
        await page.locator('#lists-btn').click();
        await expect(page.locator('#lists-btn')).toHaveAttribute('aria-expanded', 'true');
        await unhover(page);
        await page.locator('#lists-btn').hover();
        await page.waitForTimeout(800);
        await expect(page.locator('#tab-tip')).toBeHidden();
        await expect(page.locator('#lists-drawer .list-title', { hasText: 'Built-in ignore lists' })).toHaveCount(0);
    });

    test('the Auto-advance tip waits 2s before it appears', async ({ page, context }) => {
        // It hangs over the Ignore Mode block, where a cursor crossing the row
        // is usually headed.
        await openPopup(page, context);
        await page.locator('#tab-settings').click();
        await page.locator('#dq-section summary .section-title').click();
        await expect(page.locator('#dq-section')).toHaveJSProperty('open', true);
        await panelSettled(page);

        await unhover(page);
        await page.locator('.dq-next-row').hover();
        await page.waitForTimeout(1000);
        await expect(page.locator('.dq-next-tip'), 'the tip must still be down after 1s').toBeHidden();
        await expect(page.locator('.dq-next-tip')).toBeVisible({ timeout: 4000 });
    });
});
