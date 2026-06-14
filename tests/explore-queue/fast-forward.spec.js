const { test, expect } = require('../_fixtures.js');
const { SEL, openExploreQueue, readSession, interceptIgnoreApi } = require('./_helpers');
const { setExtensionStorage, clearExtensionStorage } = require('../_extension.js');

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    await setExtensionStorage(context, { ilap_q_master: true });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

// Fast Forward must (a) flip FF intent in sessionStorage, (b) clear the start
// prompt to a running toast, and (c) NOT call the Steam ignore API for the
// current game. ExploreAutomator._scheduleNextClick fires after 800ms, after
// which Steam navigates to the next queue page — the ignore interception lives
// on the context and survives that navigation, so a late ignore would still be
// caught.
test.describe('Explore Queue — Fast Forward', () => {

    test('Click Fast Forward → FF=true in sessionStorage, no ignore API call', async ({ page, context }) => {
        // Network-layer interception is world-independent (the EQ automator
        // ignores via window.ILAP.apiIgnoreGame in the isolated world) and
        // guarantees no real ignore reaches the account.
        const calls = await interceptIgnoreApi(context);

        await openExploreQueue(page);

        // Click FF. The onFastForward handler runs synchronously: setIntent →
        // clearStartPrompt → showRunningToast → schedule next click in 800ms.
        await page.locator(SEL.ffBtn).click();

        // Intent is written synchronously by the handler.
        const session = await readSession(page);
        expect(session.FF).toBe('true');
        expect(session.ACTIVE).toBeNull();

        // Start prompt is gone; running toast (with #ilap-stop-btn) is up.
        await expect(page.locator(SEL.runBtn)).toHaveCount(0);
        await expect(page.locator(SEL.runningStopBtn)).toBeVisible({ timeout: 3000 });

        // Fast forward must not ignore. Wait past the 800ms next-click timer
        // to make sure no late ignore fires.
        await page.waitForTimeout(900);
        expect(calls).toHaveLength(0);
    });
});
