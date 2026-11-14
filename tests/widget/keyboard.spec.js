// The widget's own buttons from the keyboard (Section 508): only what is on
// screen takes the focus (the stashed launcher and pin, or the hidden chevron,
// are out of the Tab order), each has a name in the interface language and a
// ring on focus, the pin shows while it has the focus, and the launcher says
// whether the panel is open.

const fs = require('fs');
const { test, expect, AUTH_FILE } = require('../_fixtures.js');
const { searchUrl } = require('../_search.js');

test.describe.configure({ retries: 2 });

const ring = (loc) => loc.evaluate(el => getComputedStyle(el).outlineStyle !== 'none' && parseFloat(getComputedStyle(el).outlineWidth) > 0);
const tabIndex = (loc) => loc.evaluate(el => el.tabIndex);

test.describe('on-page widget — keyboard', () => {

    test('collapsed then expanded: the focus goes only to what shows, with a name and a ring', async ({ page }) => {
        test.skip(!fs.existsSync(AUTH_FILE), 'no saved Steam session — run: npm run test:auth');
        await page.setViewportSize({ width: 1366, height: 768 });
        await page.goto(searchUrl());
        const chevron = page.locator('.ilap-chevron');
        const launcher = page.locator('.ilap-launcher');
        const pin = page.locator('.ilap-pin');
        await expect(chevron).toHaveClass(/shown/);

        // Collapsed: the chevron is the stop, named by its tip.
        expect(await tabIndex(chevron)).toBe(0);
        expect(await tabIndex(launcher)).toBe(-1);
        expect(await tabIndex(pin)).toBe(-1);
        await expect(chevron).toHaveAccessibleName('Expand the icon');
        await chevron.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(chevron).toBeFocused();
        expect(await ring(chevron)).toBe(true);

        // Expanded from the keyboard: the launcher and the pin take over.
        await page.keyboard.press('Enter');
        await expect(launcher).not.toHaveClass(/stashed/);
        expect(await tabIndex(launcher)).toBe(0);
        expect(await tabIndex(pin)).toBe(0);
        expect(await tabIndex(chevron)).toBe(-1);
        await expect(pin).toHaveAccessibleName('Pin the icon on screen');
        await pin.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(pin).toBeFocused();
        expect(await ring(pin)).toBe(true);
        await expect.poll(() => pin.evaluate(el => +getComputedStyle(el).opacity)).toBe(1);

        await launcher.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(launcher).toBeFocused();
        expect(await ring(launcher)).toBe(true);
        await expect(launcher).toHaveAttribute('aria-expanded', 'false');
        await page.keyboard.press('Enter');
        await expect(page.locator('.ilap-panel.open')).toHaveCount(1);
        await expect(launcher).toHaveAttribute('aria-expanded', 'true');
    });
});
