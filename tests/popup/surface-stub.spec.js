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
// message, a button that moves the interface into the popup (free — since the
// SW drain a busy queue no longer blocks popup mode), and an aggregate drain
// progress line (the one surface that can report progress with no Steam tab
// open). In popup mode it hosts the full UI. A live flip of ilap_surface_mode
// reloads the window into the other view. Popup window only — no Steam login.

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

    test('stub button works with a non-empty queue (a busy queue no longer blocks popup mode)', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [makeJob('111')] });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        const btn = page.locator('#ilap-stub-switch');
        await expect(btn).toBeEnabled();
        await btn.click();
        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_surface_mode')).ilap_surface_mode
        ).toBe('popup');
        await page.locator('#popup-root').waitFor({ timeout: 5000 });
        // The queue rode along untouched — it keeps draining in popup mode.
        const q = (await getExtensionStorage(context, 'ilap_curator_queue')).ilap_curator_queue;
        expect(q).toHaveLength(1);
    });

    test('stub aggregate progress: hidden when idle, sums done/total over ALL jobs, live updates', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));
        await expect(page.locator('#ilap-stub-progress')).toBeHidden();

        // A curator job (3 appids, cursor 1) + an undo job (5 appids, pending):
        // one combined "done / total" line — pendings included, ignore and undo
        // alike, no per-job breakdown.
        const cur = { ...makeJob('111'), appids: ['1', '2', '3'], total: 3, status: 'pending' };
        const undo = {
            id: 'job_undo', curatorId: 'undo', type: 'undo',
            appids: ['4', '5', '6', '7', '8'], total: 5, snapshotTs: Date.now(),
            status: 'pending', addedAt: Date.now(),
        };
        await setExtensionStorage(context, {
            ilap_curator_queue: [cur, undo],
            ['ilap_curator_cursor_' + cur.id]: 1,
        });
        await expect(page.locator('#ilap-stub-progress')).toBeVisible();
        await expect(page.locator('#ilap-stub-progress-text')).toContainText('1 / 8');

        // A drainer cursor advance re-renders live.
        await setExtensionStorage(context, { ['ilap_curator_cursor_' + cur.id]: 3 });
        await expect(page.locator('#ilap-stub-progress-text')).toContainText('3 / 8');

        // Queue emptied → the line hides again.
        await setExtensionStorage(context, { ilap_curator_queue: [] });
        await expect(page.locator('#ilap-stub-progress')).toBeHidden();
    });

    test('stub halt hint: visible while ilap_sw_halt is set with a busy queue, clears live', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_curator_queue: [{ ...makeJob('111'), appids: ['1'], total: 1, status: 'pending' }],
            ilap_sw_halt: true,
        });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#ilap-stub-halt')).toBeVisible();
        await expect(page.locator('#ilap-stub-halt')).toContainText(/steam store page/i);

        // The content-script boot clears the flag on the next store-page visit —
        // model just the storage effect.
        await setExtensionStorage(context, { ilap_sw_halt: false });
        await expect(page.locator('#ilap-stub-halt')).toBeHidden();
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
