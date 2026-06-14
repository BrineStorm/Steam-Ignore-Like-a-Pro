const { test, expect } = require('../_fixtures.js');
const { AUTH_FILE, SEL, openExploreQueue } = require('./_helpers');
const { setExtensionStorage, clearExtensionStorage } = require('../_extension.js');

test.use({ storageState: AUTH_FILE });

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    // EQ checks ilap_q_master at run() time. Default must be on for the start
    // prompt (which hosts the mode badge) to render.
    await setExtensionStorage(context, { ilap_q_master: true });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

// ExploreAutomator._setupListener subscribes to chrome.storage.onChanged.
// When ilap_q_mode flips, ui.updateRunButtonMode rewrites #ilap-mode-badge
// without reloading the page or re-running run(). This regression-guards that
// subscription: a popup-driven mode change must reach the live toast.
test.describe('Explore Queue — mode badge live-updates on storage change', () => {

    test('Flipping ilap_q_mode between bad and all rewrites the badge text live', async ({ page, context }) => {
        await openExploreQueue(page);

        const badge = page.locator(SEL.modeBadge);
        await expect(badge).toBeVisible({ timeout: 15000 });
        await expect(badge).toContainText(/bad reviews/i);

        // Storage change must reach the badge without any user interaction.
        await setExtensionStorage(context, { ilap_q_mode: 'all' });
        await expect(badge).toContainText(/every game/i, { timeout: 5000 });

        // And back — verifies the listener handles both directions, not just
        // a one-way transition.
        await setExtensionStorage(context, { ilap_q_mode: 'bad' });
        await expect(badge).toContainText(/bad reviews/i, { timeout: 5000 });
    });
});
