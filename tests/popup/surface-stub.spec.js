const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

// popup.html surface routing (ui/popup_main.js bootstrapPopupWindow): in
// widget mode (the default) the toolbar popup is only a signpost stub —
// message + a button that moves the interface into the popup, guarded by the
// "popup mode ⇒ empty curator queue" invariant. In popup mode it hosts the
// full UI. A live flip of ilap_surface_mode reloads the window into the other
// view. Popup window only — no Steam login.

function makeJob(curatorId) {
    return {
        id: 'job_' + curatorId + '_1',
        curatorId: String(curatorId),
        curatorName: 'Curator ' + curatorId,
        curatorUrl: 'https://store.steampowered.com/curator/' + curatorId + '/',
        filter: 'not_recommended',
        appids: [],
        total: 0,
        status: 'paused',
        addedAt: Date.now(),
    };
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Popup — surface stub', () => {

    test('widget mode (default): the popup shows the signpost stub, not the full UI', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#ilap-popup-stub')).toBeVisible();
        await expect(page.locator('#popup-root')).toHaveCount(0);
        await expect(page.locator('#ilap-stub-switch')).toBeEnabled();
        // The message went through t() — English on the default locale.
        await expect(page.locator('#ilap-stub-msg')).toContainText(/on the Steam Store pages/i);
    });

    test('stub button moves the interface into the popup and the full UI reloads in', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await page.locator('#ilap-stub-switch').click();

        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_surface_mode')).ilap_surface_mode
        ).toBe('popup');
        // The window reloads itself into the full popup UI.
        await page.locator('#popup-root').waitFor({ timeout: 5000 });
        await expect(page.locator('#ilap-popup-stub')).toHaveCount(0);
    });

    test('stub button is locked while the curator queue is non-empty', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [makeJob('111')] });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        const btn = page.locator('#ilap-stub-switch');
        await expect(btn).toBeDisabled();
        // A disabled <button> fires no hover events, so its own title never shows;
        // renderPopupStub carries the "why locked" tooltip on the always-hoverable
        // wrapper instead. Assert it on the element that actually surfaces it.
        await expect(page.locator('#ilap-stub-btnwrap')).toHaveAttribute('title', /queue/i);

        // …and unlocks live once the queue empties.
        await setExtensionStorage(context, { ilap_curator_queue: [] });
        await expect(btn).toBeEnabled();
    });

    test('popup mode: full UI; flipping the key live reloads into the stub', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#popup-root')).toBeVisible();

        await setExtensionStorage(context, { ilap_surface_mode: 'widget' });
        await page.locator('#ilap-popup-stub').waitFor({ timeout: 5000 });
    });

    test('post-update glow: shown once at the first popup open, consumed, never replayed', async ({ page, context }) => {
        // The state the migration update writes: popup mode + the armed glow
        // (the --test build swaps migrate.js out, so seed it the same way).
        await setExtensionStorage(context, { ilap_surface_mode: 'popup', ilap_update_glow: true });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        // First open: the gold wash is on, and the flag is consumed right away —
        // so a close/reopen even within the 5 s window can't replay it.
        await expect(page.locator('#popup-root')).toHaveClass(/update-glow/);
        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_update_glow')).ilap_update_glow
        ).toBe(false);

        await page.reload();
        await expect(page.locator('#popup-root')).toBeVisible();
        await expect(page.locator('#popup-root')).not.toHaveClass(/update-glow/);
    });

    test('post-update glow: a stale flag in widget mode is retired silently by the stub', async ({ page, context }) => {
        // The user escaped to widget mode before ever opening the popup — they
        // have plainly found the extension, so the stub consumes the flag and a
        // later switch back to popup mode must NOT glow.
        await setExtensionStorage(context, { ilap_update_glow: true }); // widget mode (default)
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#ilap-popup-stub')).toBeVisible();
        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_update_glow')).ilap_update_glow
        ).toBe(false);

        await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
        await page.locator('#popup-root').waitFor({ timeout: 5000 }); // live flip reloads
        await expect(page.locator('#popup-root')).not.toHaveClass(/update-glow/);
    });
});
