// Surface switching on the widget side (ilap_surface_mode). In popup mode the
// widget is parked: launcher and pin stashed, only a ghost chevron beacon
// remains (hover reveals it; its tooltip points at the popup settings and the
// escape hotkey), and clicking it does nothing. The mode flips live via
// storage.onChanged, and Ctrl+Alt+Shift+I on any store page is the escape hatch
// back to the widget.
//
// Login-agnostic: the panel is never opened and no ignore API is reachable.

const { test, expect, AUTH_FILE } = require('../_fixtures.js');
const { setExtensionStorage, getExtensionStorage } = require('../_extension.js');
const fs = require('fs');

const { searchUrl } = require('../_search.js'); // random search term per navigation
const MODE_KEY = 'ilap_surface_mode';
const STATE_KEY = 'ilap_widget_expanded_ts';

test.describe('on-page widget — surface mode', () => {

    test('popup mode: mounts parked — ghost chevron with the escape-hatch tooltip, inert click', async ({ context, page }) => {
        await setExtensionStorage(context, { [MODE_KEY]: 'popup' });
        await page.goto(searchUrl());

        const chevron = page.locator('.ilap-chevron');
        await expect(chevron).toHaveClass(/ghost/);
        await expect(chevron).toHaveClass(/shown/);
        await expect(page.locator('.ilap-launcher')).toHaveClass(/stashed/);
        // Our own tooltip box (not a native browser title) names the hotkey
        // (English on the default locale) and reveals on hover.
        const tip = page.locator('.ilap-chevron-tip');
        await expect(tip).toContainText('Ctrl+Alt+Shift+I');
        await chevron.hover();
        await expect(tip).toHaveClass(/shown/);

        // The beacon is informational only: no slide-out, no state write.
        await chevron.click();
        await page.waitForTimeout(300);
        await expect(page.locator('.ilap-launcher')).toHaveClass(/stashed/);
        const data = await getExtensionStorage(context, [STATE_KEY]);
        expect(data[STATE_KEY] || 0).toBe(0);
    });

    test('live switch: widget parks to the ghost, and always comes back collapsed to the chevron', async ({ context, page }) => {
        await page.goto(searchUrl());

        // Expand first — coming back must STILL land on the chevron, not restore this.
        await page.locator('.ilap-chevron').click();
        await expect(page.locator('.ilap-launcher')).not.toHaveClass(/stashed/);

        await setExtensionStorage(context, { [MODE_KEY]: 'popup' });
        await expect(page.locator('.ilap-launcher')).toHaveClass(/stashed/);
        await expect(page.locator('.ilap-chevron')).toHaveClass(/ghost/);

        await setExtensionStorage(context, { [MODE_KEY]: 'widget' });
        await expect(page.locator('.ilap-chevron')).not.toHaveClass(/ghost/);
        // Regardless of the pre-park expanded state, we return to the chevron.
        await expect(page.locator('.ilap-chevron')).toHaveClass(/shown/);
        await expect(page.locator('.ilap-launcher')).toHaveClass(/stashed/);
    });

    test('live switch back to widget collapses to the chevron even when the launcher is pinned', async ({ context, page }) => {
        await page.goto(searchUrl());

        // Pin the launcher out — normally the pin keeps it expanded.
        await page.locator('.ilap-chevron').click();
        await page.locator('.ilap-pin').click();
        await expect(page.locator('.ilap-pin')).toHaveClass(/pinned/);
        await expect(page.locator('.ilap-launcher')).not.toHaveClass(/stashed/);

        // Park to popup, then return: the switch overrides the pin and shows the chevron.
        await setExtensionStorage(context, { [MODE_KEY]: 'popup' });
        await expect(page.locator('.ilap-chevron')).toHaveClass(/ghost/);
        await setExtensionStorage(context, { [MODE_KEY]: 'widget' });

        await expect(page.locator('.ilap-chevron')).not.toHaveClass(/ghost/);
        await expect(page.locator('.ilap-chevron')).toHaveClass(/shown/);
        await expect(page.locator('.ilap-launcher')).toHaveClass(/stashed/);
    });

    test('switching popup→widget flags the collapsed chevron with a temporary highlight', async ({ context, page }) => {
        // No stored timestamp → the widget comes back collapsed to the chevron.
        await setExtensionStorage(context, { [MODE_KEY]: 'popup' });
        await page.goto(searchUrl());
        const chevron = page.locator('.ilap-chevron');
        await expect(chevron).toHaveClass(/ghost/);

        await setExtensionStorage(context, { [MODE_KEY]: 'widget' });
        await expect(chevron).not.toHaveClass(/ghost/);
        await expect(chevron).toHaveClass(/shown/);    // collapsed → chevron visible
        await expect(chevron).toHaveClass(/restored/); // welcome-back outline
        // …which drops after ~10 s, leaving the passive outline-free chevron.
        await expect(chevron).not.toHaveClass(/restored/, { timeout: 12000 });
    });

    test('switching popup→widget while logged out shows a 10 s sign-in push', async ({ context, page }) => {
        await context.clearCookies(); // logged out → the on-page widget is login-gated
        await setExtensionStorage(context, { [MODE_KEY]: 'popup' });
        await page.goto(searchUrl());
        await expect(page.locator('.ilap-chevron')).toHaveClass(/ghost/);

        const push = page.locator('.ilap-push');
        await expect(push).not.toHaveClass(/shown/); // nothing before the flip

        await setExtensionStorage(context, { [MODE_KEY]: 'widget' });
        // Push appears without needing a hover, same copy as the login tooltip.
        await expect(push).toHaveClass(/shown/);
        await expect(push).toContainText(/Steam/);
        // …and lives ~10 s, then fades out on its own.
        await expect(push).not.toHaveClass(/shown/, { timeout: 12000 });
    });

    test('escape hotkey Ctrl+Alt+Shift+I flips the surface back to the widget', async ({ context, page }) => {
        await setExtensionStorage(context, { [MODE_KEY]: 'popup' });
        await page.goto(searchUrl());
        await expect(page.locator('.ilap-chevron')).toHaveClass(/ghost/);

        await page.keyboard.press('Control+Alt+Shift+I');

        await expect.poll(async () => {
            const data = await getExtensionStorage(context, [MODE_KEY]);
            return data[MODE_KEY];
        }).toBe('widget');
        await expect(page.locator('.ilap-chevron')).not.toHaveClass(/ghost/);
    });

    test('escape hotkey still un-parks while the extension is disabled', async ({ context, page }) => {
        // The escape hatch is gated only by the parked (ghost) state, never by the
        // master toggle — so a user who disabled the extension in popup mode can
        // still hotkey the surface back to the widget and re-enable it there.
        await setExtensionStorage(context, { [MODE_KEY]: 'popup', ilap_master_enabled: false });
        await page.goto(searchUrl());
        await expect(page.locator('.ilap-chevron')).toHaveClass(/ghost/);

        await page.keyboard.press('Control+Alt+Shift+I');

        await expect.poll(async () => {
            const data = await getExtensionStorage(context, [MODE_KEY]);
            return data[MODE_KEY];
        }).toBe('widget');
        await expect(page.locator('.ilap-chevron')).not.toHaveClass(/ghost/);
    });

    test('settings toggle in the widget panel: switches to popup mode even while curator jobs exist', async ({ context, page }) => {
        test.skip(!fs.existsSync(AUTH_FILE), 'no saved Steam session'); // panel is login-gated

        // A busy queue no longer blocks popup mode: since the SW drain landed,
        // jobs progress with no Steam tab, and the popup hosts the same applet.
        await setExtensionStorage(context, {
            ilap_curator_queue: [{
                id: 'job_111_1', curatorId: '111', curatorName: 'Curator 111',
                curatorUrl: 'https://store.steampowered.com/curator/111/',
                filter: 'not_recommended', appids: [], total: 0,
                status: 'paused', addedAt: Date.now(),
            }],
        });
        await page.goto(searchUrl());
        await page.locator('.ilap-chevron').click();
        await page.locator('.ilap-launcher').click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);

        await page.locator('#settings-accordion > summary').click();
        const surface = page.locator('#surface-toggle');
        // The checkbox is a visually-collapsed segmented toggle; wait on its
        // visible .wide-track surface, then assert against the input itself.
        await page.locator('#surface-toggle ~ .wide-track').waitFor({ timeout: 5000 });

        // Free switch: clicking the segmented track writes 'popup' and the
        // widget parks to the ghost beacon in place.
        await expect(surface).toBeEnabled();
        await page.locator('#surface-toggle ~ .wide-track').click();
        await expect.poll(async () => {
            const data = await getExtensionStorage(context, [MODE_KEY]);
            return data[MODE_KEY];
        }).toBe('popup');
        await expect(page.locator('.ilap-chevron')).toHaveClass(/ghost/);
        await expect(page.locator('.ilap-launcher')).toHaveClass(/stashed/);

        // The job rode along untouched — nothing empties or blocks the queue.
        const q = await getExtensionStorage(context, ['ilap_curator_queue']);
        expect(q.ilap_curator_queue).toHaveLength(1);
    });
});
