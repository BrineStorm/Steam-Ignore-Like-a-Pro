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
        await expect(btn).toHaveAttribute('title', /queue/i);

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
});
