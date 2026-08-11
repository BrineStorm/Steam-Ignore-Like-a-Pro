const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

// The toolbar popup's HEIGHT BUDGET.
//
// A browser-action popup is not free to grow: Chrome and Firefox both cap the
// window at 600px and scroll the document inside it once it is taller. Nothing in
// the page can raise that ceiling — `body { overflow: hidden }` only hides the
// scrollbar, it doesn't buy room — so the panel's tallest reachable state is what
// has to fit, and this spec measures the real thing against the number instead of
// trusting a CSS read.
//
// The tallest state is SETTINGS open on ONE feature subcategory: Discovery Queue
// and Manual Ignore are mutually exclusive (popup_settings.js), so the budget is
// "base + the taller of the two", never both. Manual Ignore is the taller one, and
// its third gesture select (solo un-ignore) is what first pushed the panel past
// 600 — the vertical trim that bought it back (no "Interface:" caption, no
// subcategory margins doubling the flex gap, no .stat-row margin inside the flex
// column) is what this spec pins down.
//
// Every shipped locale is walked, not just English: the panel is 320px wide, so a
// longer label wraps and costs height. English measures ~570px, Japanese ~589px.
//
// The on-page widget is deliberately NOT covered here — it caps itself to the
// viewport and scrolls its own panel (src/widget/main.js); the 600px ceiling is
// the toolbar window's alone.
const POPUP_MAX_H = 600;

// Worst case the history tooltip can hold: it renders the last 3 games
// (popup_main.js), so a long wrapped name in each is as tall as it ever gets.
const LONG_NAME = 'Some Very Long Game Name: The Definitive Remastered Edition (Deluxe)';
const fatHistory = () => [1, 2, 3].map(i => ({ name: `${LONG_NAME} ${i}`, ts: Date.now() }));

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    // popup.html renders the full UI only in popup surface mode.
    await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

async function openPopup(page, context) {
    const extId = await getExtensionId(context);
    await page.goto(popupUrl(extId));
    await page.locator('#popup-root').waitFor({ timeout: 5000 });
}

// body carries no margin and #popup-root is its only child, so this is exactly
// the height the popup window would have to show.
const panelHeight = (page) => page.evaluate(() => document.body.scrollHeight);

async function openSettings(page) {
    await page.locator('#settings-accordion > summary').click();
    await page.locator('#dq-section summary').waitFor({ timeout: 5000 });
}

// A locale switch re-renders the settings body from scratch, so the subcategory
// comes back collapsed — re-expand it before measuring.
async function expandSubcat(page, which) {
    const section = page.locator(`#${which}-section`);
    if (!(await section.evaluate(el => el.open))) {
        // Click the title, not the DQ master switch (which stops propagation).
        await page.locator(`#${which}-section summary .section-title`).click();
        await expect(section).toHaveJSProperty('open', true);
    }
    // The subcategory animates open (block-size .26s); measure after it lands.
    await page.waitForTimeout(400);
}

function shippedLocales(page) {
    return page.evaluate(() =>
        window.ILAP.i18n.getLanguages().filter(l => l.translated).map(l => l.code));
}

test.describe('Popup — toolbar window height budget', () => {

    test('tallest state (SETTINGS + Manual Ignore) fits the 600px window in every locale', async ({ page, context }) => {
        await openPopup(page, context);
        const locales = await shippedLocales(page);
        expect(locales.length).toBeGreaterThan(1);

        await openSettings(page);

        const tall = [];
        for (const code of locales) {
            await setExtensionStorage(context, { ilap_lang: code });
            await expect(page.locator('#lang-quick')).toHaveValue(code);
            await expandSubcat(page, 'mi');

            const h = await panelHeight(page);
            tall.push(`${code}=${h}`);
            expect(h, `SETTINGS + Manual Ignore must fit the ${POPUP_MAX_H}px popup window (${code})`)
                .toBeLessThanOrEqual(POPUP_MAX_H);
        }
        console.log('[height] SETTINGS + MI per locale: ' + tall.join(' '));
    });

    test('the two subcategories are mutually exclusive, so the budget is base + the taller one', async ({ page, context }) => {
        await openPopup(page, context);
        const base = await panelHeight(page);

        await openSettings(page);
        await expandSubcat(page, 'dq');
        const withDq = await panelHeight(page);

        // Opening Manual Ignore must CLOSE Discovery Queue — the whole reason the
        // budget is one subcategory deep and not two.
        await expandSubcat(page, 'mi');
        await expect(page.locator('#dq-section')).toHaveJSProperty('open', false);
        const withMi = await panelHeight(page);

        expect(withDq).toBeGreaterThan(base);
        expect(withMi).toBeGreaterThan(withDq);
        expect(withMi).toBeLessThanOrEqual(POPUP_MAX_H);

        // The panel with both subcategories expanded is the state the mutual
        // exclusion makes unreachable — and it would not have fitted.
        const bothOpen = withMi + (withDq - base);
        expect(bothOpen).toBeGreaterThan(POPUP_MAX_H);
    });

    test('history tooltip is capped to the window it hangs in, in both panel states', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ignored_history: fatHistory() });
        await openPopup(page, context);

        const tip = () => page.evaluate(() => {
            const el = document.getElementById('history-list');
            const r = el.getBoundingClientRect();
            return {
                bottom: Math.round(r.bottom),
                cap: getComputedStyle(el).maxHeight,
                scrolls: el.scrollHeight > el.clientHeight,
                panel: document.body.scrollHeight,
            };
        });

        // Collapsed panel: the tooltip has to fit the SHORT window it hangs in —
        // and the cap must still be big enough that the worst case (3 long names)
        // reads whole instead of scrolling inside a 120px slot.
        const closed = await tip();
        expect(closed.cap).not.toBe('none');
        expect(closed.bottom).toBeLessThanOrEqual(closed.panel);
        expect(closed.scrolls, 'the worst-case history must fit the collapsed cap').toBe(false);

        // Settings open: a taller panel gives the tooltip more room, but the cap
        // stays a NUMBER — an uncapped tooltip in a panel that already runs to
        // ~590px would clear the window edge only by luck.
        await openSettings(page);
        await expandSubcat(page, 'mi');
        const open = await tip();
        expect(open.cap).not.toBe('none');
        expect(parseInt(open.cap, 10)).toBeGreaterThan(parseInt(closed.cap, 10));
        expect(open.bottom).toBeLessThanOrEqual(POPUP_MAX_H);
        expect(open.scrolls).toBe(false);
    });
});
