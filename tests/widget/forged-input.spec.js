// SPDX-License-Identifier: GPL-3.0-or-later
//
// The widget hosts the popup UI in an OPEN shadow root, which is a deliberate
// trade (see the attachShadow comment in src/widget/main.js): the page can
// read the panel and call .click() on anything in it, and what keeps that
// harmless is that every control refuses a synthetic event. That claim covers
// the widget's own furniture too — the chevron and the launcher own
// `ilap_widget_expanded_ts`, the pin owns `ilap_widget_pinned` — and these
// specs pin all three.
//
// Playwright's own clicks are trusted, so no other spec in this suite can see
// the difference: these drive the clicks from page script instead, which is
// exactly what a hostile page has.
//
// Login-agnostic, like the rest of the widget suite: nothing here talks to Steam.

const { test, expect } = require('../_fixtures.js');
const { setExtensionStorage, getExtensionStorage } = require('../_extension.js');
const { searchUrl } = require('../_search.js');

const STATE_KEY = 'ilap_widget_expanded_ts';
const PIN_KEY = 'ilap_widget_pinned';

// Click from the page's main world, through the open shadow root — a real page
// script's reach, and untrusted by construction.
async function pageClick(page, selector) {
    return page.evaluate((sel) => {
        const host = document.querySelector('.ilap-widget-host, #ilap-widget-host')
            || [...document.querySelectorAll('*')].find((el) => el.shadowRoot
                && el.shadowRoot.querySelector('.ilap-launcher'));
        const root = host && host.shadowRoot;
        const el = root && root.querySelector(sel);
        if (!el) return 'not found';
        el.click();
        return 'clicked';
    }, selector);
}

test.describe.configure({ retries: 2 });

test.describe('on-page widget — forged clicks from the page', () => {

    test('a page script cannot expand the widget, pin it, or open the panel', async ({ context, page }) => {
        await page.goto(searchUrl());
        // Collapsed and unpinned to start with, and both keys known.
        await setExtensionStorage(context, { [STATE_KEY]: 0, [PIN_KEY]: false });
        await page.reload();
        await expect(page.locator('.ilap-chevron')).toHaveClass(/shown/, { timeout: 10000 });

        // The chevron is what a real user clicks to bring the launcher out.
        expect(await pageClick(page, '.ilap-chevron')).toBe('clicked');
        // The pin and the launcher are reachable from script whatever their
        // opacity is — that is the point of an open shadow root.
        await pageClick(page, '.ilap-pin');
        await pageClick(page, '.ilap-launcher');

        await page.waitForTimeout(1000);

        // Nothing moved: not the shared state, not the pin, not the panel.
        const stored = await getExtensionStorage(context, [STATE_KEY, PIN_KEY]);
        expect(stored[STATE_KEY], 'a forged chevron/launcher click must not expand the widget').toBe(0);
        expect(stored[PIN_KEY], 'a forged click must not pin the widget').toBe(false);
        await expect(page.locator('.ilap-panel')).not.toHaveClass(/open/);
    });

    test('the same clicks, made for real, do all three things', async ({ context, page }) => {
        // The counterpart that keeps the guard honest: a test that only proves
        // "nothing happened" passes just as well on a widget that is broken.
        await page.goto(searchUrl());
        await setExtensionStorage(context, { [STATE_KEY]: 0, [PIN_KEY]: false });
        await page.reload();
        await expect(page.locator('.ilap-chevron')).toHaveClass(/shown/, { timeout: 10000 });

        await page.locator('.ilap-chevron').click();
        await expect.poll(async () =>
            (await getExtensionStorage(context, [STATE_KEY]))[STATE_KEY], { timeout: 8000 }
        ).toBeGreaterThan(0);

        await page.locator('.ilap-pin').click();
        await expect(page.locator('.ilap-pin')).toHaveClass(/pinned/);
        await expect.poll(async () =>
            (await getExtensionStorage(context, [PIN_KEY]))[PIN_KEY], { timeout: 8000 }
        ).toBe(true);

        await page.locator('.ilap-launcher').click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);
    });
});

// The styled droplists drive their <select> with a synthetic `change`, which the
// handlers accept as the droplist's own. A page script can hear that dispatch
// from a capture listener on the open shadow root and act inside it: fire its
// own `change` at another select, or rewrite the picked select's value before
// the handler reads it. The pick itself is a real Playwright click, so each
// test also proves the real pick still lands.
test.describe('on-page widget — forged selects inside a real pick', () => {

    const SETTINGS = {
        [STATE_KEY]: 0, [PIN_KEY]: false,
        ilap_settings_open: true, ilap_mi_open: true, ilap_dq_open: false,
        ilap_shortcut_key: 'swipeRight', ilap_platform_key: 'swipeLeft',
        ilap_unignore_key: 'zigzag', ilap_lang: 'en',
    };

    async function openPanel(context, page) {
        await page.goto(searchUrl());
        await setExtensionStorage(context, Object.assign({}, SETTINGS, { [STATE_KEY]: Date.now() }));
        await page.reload();
        await page.locator('.ilap-launcher').click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);
        await expect(page.locator('#default-key-display')).toBeVisible();
    }

    // Installs the page's capture listener on the shadow root; it forges once,
    // on the first `change` it hears. No eval: the store page's CSP decides that.
    //   other  — set another select and fire `change` at it
    //   value  — rewrite the picked select's value
    //   nested — set the picked select and fire a second `change` at it
    async function onFirstChange(page, mode, id, value) {
        await page.evaluate(([mode, id, value]) => {
            const root = document.getElementById('ilap-widget-host').shadowRoot;
            window.__ilapForged = 0;
            root.addEventListener('change', (e) => {
                if (window.__ilapForged) return;
                window.__ilapForged = 1;
                const el = mode === 'other' ? root.getElementById(id) : e.target;
                el.value = value;
                if (mode !== 'value') el.dispatchEvent(new Event('change', { bubbles: true }));
            }, true);
        }, [mode, id, value]);
    }

    test('a change forged at ANOTHER select during the pick is refused', async ({ context, page }) => {
        await openPanel(context, page);
        await onFirstChange(page, 'other', 'unignore-key', 'altKey');

        await page.locator('#default-key-display').click();
        await page.locator('.select-shell', { has: page.locator('#default-key') })
            .locator('.select-opt[data-value="ctrlKey"]').click();

        await expect.poll(async () =>
            (await getExtensionStorage(context, ['ilap_shortcut_key'])).ilap_shortcut_key,
        { timeout: 8000 }).toBe('ctrlKey');                       // the real pick landed
        expect(await page.evaluate(() => window.__ilapForged)).toBe(1);   // the forgery ran
        const stored = await getExtensionStorage(context, ['ilap_unignore_key']);
        expect(stored.ilap_unignore_key, 'a forged change must not rebind un-ignore').toBe('zigzag');
    });

    test('a value rewritten under the pick is refused, not stored', async ({ context, page }) => {
        await openPanel(context, page);
        await onFirstChange(page, 'value', null, 'altKey');

        await page.locator('#default-key-display').click();
        await page.locator('.select-shell', { has: page.locator('#default-key') })
            .locator('.select-opt[data-value="ctrlKey"]').click();

        await page.waitForTimeout(1000);
        expect(await page.evaluate(() => window.__ilapForged)).toBe(1);
        const stored = await getExtensionStorage(context, ['ilap_shortcut_key']);
        expect(stored.ilap_shortcut_key, 'neither the pick nor the rewrite may be stored')
            .toBe('swipeRight');
    });

    test('the language chip refuses a nested forged change', async ({ context, page }) => {
        await openPanel(context, page);
        await onFirstChange(page, 'nested', null, 'fr');

        await page.locator('.lang-chip').click();
        await page.locator('.lang-chip .select-opt[data-value="de"]').click();

        await page.waitForTimeout(1000);
        expect(await page.evaluate(() => window.__ilapForged)).toBe(1);
        const stored = await getExtensionStorage(context, ['ilap_lang']);
        expect(stored.ilap_lang, 'the page must not choose the language').not.toBe('fr');
    });
});
