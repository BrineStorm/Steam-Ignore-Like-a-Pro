const { test, expect } = require('@playwright/test');
const { AUTH_FILE, SEL, openExploreQueue, readSession } = require('./_helpers');
const { setExtensionStorage, clearExtensionStorage } = require('../_extension.js');

test.use({ storageState: AUTH_FILE });

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
// which Steam navigates to the next queue page — assertions happen before
// that timer, so we never have to chase the page across navigations.
test.describe('Explore Queue — Fast Forward', () => {

    test('Click Fast Forward → FF=true in sessionStorage, no ignore API call', async ({ page }) => {
        await openExploreQueue(page);

        // Stub apiIgnoreGame BEFORE the FF click. The EQ adapter resolves
        // window.ILAP.apiIgnoreGame at call time (see src/explore-queue/main.js),
        // so swapping the global now is honored.
        await page.waitForFunction(
            () => window.ILAP && typeof window.ILAP.apiIgnoreGame === 'function',
            null,
            { timeout: 15000 }
        );
        await page.evaluate(() => {
            window.__ilapApiCalls = [];
            window.ILAP.apiIgnoreGame = (appid, reason) => {
                window.__ilapApiCalls.push({ appid: String(appid), reason });
                return Promise.resolve(true);
            };
        });

        // Click FF. The onFastForward handler runs synchronously: setIntent →
        // clearStartPrompt → showRunningToast → schedule next click in 800ms.
        await page.locator(SEL.ffBtn).click();

        // The intent must be visible immediately — we don't rely on any async
        // hop. Reading sessionStorage right after the click captures the state
        // the handler just wrote.
        const session = await readSession(page);
        expect(session.FF).toBe('true');
        expect(session.ACTIVE).toBeNull();

        // Start prompt is gone; running toast (with #ilap-stop-btn) is up.
        await expect(page.locator(SEL.runBtn)).toHaveCount(0);
        await expect(page.locator(SEL.runningStopBtn)).toBeVisible({ timeout: 3000 });

        // Fast forward must not ignore. Wait past the 800ms next-click timer
        // to make sure no late ignore fires from within this page's logic.
        await page.waitForTimeout(900);
        const calls = await page.evaluate(() => window.__ilapApiCalls || []);
        expect(calls).toHaveLength(0);
    });
});
