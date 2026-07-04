// Master toggle vs the on-page widget. Disabling the extension
// (ilap_master_enabled = false) must NOT lock the widget shell the way a
// logged-out session does: the chevron still expands and the panel still opens,
// so its master toggle can flip the extension back on. The pin, however, is a
// preference for an ACTIVE widget — while disabled it goes inert (greyed +
// non-interactive) so it can't be toggled with everything off.
//
// Playwright CSS selectors pierce the open shadow root, so .ilap-* and the
// panel's #master-toggle resolve straight through #ilap-widget-host.

const { test, expect, AUTH_FILE } = require('../_fixtures.js');
const { setExtensionStorage, getExtensionStorage } = require('../_extension.js');
const fs = require('fs');

const PAGE = '/search/?term=portal&ndl=1';
const MASTER_KEY = 'ilap_master_enabled';
const PIN_KEY = 'ilap_widget_pinned';

test.describe('on-page widget — master gate', () => {

    test('disabled: chevron still expands; the pin is inert and re-enabling revives it', async ({ context, page }) => {
        // Login-agnostic: the chevron is never login-gated, and the pin is a
        // visibility preference (not a Steam action), so this holds logged out too.
        await setExtensionStorage(context, { [MASTER_KEY]: false });
        await page.goto(PAGE);

        // The master toggle does not gate the chevron/launcher slide-out.
        await page.locator('.ilap-chevron').click();
        await expect(page.locator('.ilap-launcher')).not.toHaveClass(/stashed/);

        // The pin is inert: marked disabled, and a click dispatched straight at it
        // (bypassing pointer-events:none) hits the guard and toggles nothing.
        const pin = page.locator('.ilap-pin');
        await expect(pin).toHaveClass(/disabled/);
        await pin.dispatchEvent('click');
        await page.waitForTimeout(200);
        await expect(pin).not.toHaveClass(/pinned/);
        expect((await getExtensionStorage(context, [PIN_KEY]))[PIN_KEY] || false).toBe(false);

        // Re-enabling live drops the inert state, and the pin toggles again.
        await setExtensionStorage(context, { [MASTER_KEY]: true });
        await expect(pin).not.toHaveClass(/disabled/);
        await pin.click();
        await expect(pin).toHaveClass(/pinned/);
        await expect.poll(async () =>
            (await getExtensionStorage(context, [PIN_KEY]))[PIN_KEY]
        ).toBe(true);
    });

    test('disabled: launcher not locked, panel opens, and its master toggle re-enables the extension', async ({ context, page }) => {
        test.skip(!fs.existsSync(AUTH_FILE), 'no saved Steam session'); // panel is login-gated

        await setExtensionStorage(context, { [MASTER_KEY]: false });
        await page.goto(PAGE);

        await page.locator('.ilap-chevron').click();
        const launcher = page.locator('.ilap-launcher');
        // Master off must not lock the launcher — that grey state is the login
        // gate's alone (a live session is present here).
        await expect(launcher).not.toHaveClass(/locked/);

        await launcher.click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);

        // The master toggle lives in the header, OUTSIDE the dimmed #ui-wrapper, so
        // it stays clickable — flipping it writes the extension back on.
        await page.locator('#master-toggle + .slider').click();
        await expect.poll(async () =>
            (await getExtensionStorage(context, [MASTER_KEY]))[MASTER_KEY]
        ).toBe(true);
        // …and the pin comes back to life once enabled.
        await expect(page.locator('.ilap-pin')).not.toHaveClass(/disabled/);
    });
});
