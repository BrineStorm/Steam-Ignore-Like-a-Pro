const { test, expect } = require('@playwright/test');
const {
    getServiceWorker,
    getExtensionStorage,
    clearExtensionStorage,
} = require('../_extension.js');

const AUTH_FILE = 'playwright/.auth/user.json';

test.use({ storageState: AUTH_FILE });

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

// MV3 service workers can be evicted at any time. When the extension is
// reloaded (or the SW restarts), any existing content script's `chrome`
// context invalidates. StatsManager.save guards against this with a
// chrome.runtime.id probe; this test verifies the guard holds and that a
// page reload restores full functionality without leaking the dreaded
// "Extension context invalidated" error.
test.describe('Cross-cutting — extension survives a service-worker restart', () => {

    test('Reload extension mid-session → page reload → second ignore still saves stats', async ({ page, context }) => {
        test.setTimeout(60_000);

        const consoleErrors = [];
        const pageErrors = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });
        page.on('pageerror', (err) => pageErrors.push(String(err)));

        // 1. First ignore via the saveStats facade — same code path that a
        //    real swipe would exercise, minus the DOM-dependent gesture.
        await page.goto('/');
        await page.waitForFunction(
            () => window.ILAP && typeof window.ILAP.saveStats === 'function',
            null,
            { timeout: 15000 }
        );
        await page.evaluate(() => window.ILAP.saveStats('Pre-restart Game', 'Manual'));

        await expect.poll(
            async () => (await getExtensionStorage(context, 'ilap_ignored_count')).ilap_ignored_count,
            { timeout: 5000 }
        ).toBe(1);

        // 2. Reload the extension from the service worker. This kills the
        //    current SW, invalidates the active content script's chrome
        //    context, and triggers a fresh SW to come up.
        const sw = await getServiceWorker(context);
        await sw.evaluate(() => chrome.runtime.reload()).catch(() => {
            // The evaluate context can die mid-call as the SW shuts down.
            // That's expected — the new SW is what we wait for next.
        });

        await context.waitForEvent('serviceworker', { timeout: 10_000 });

        // 3. Reload the tab so a fresh content script attaches under the new
        //    extension instance. Storage persists across reload, so the count
        //    we captured pre-restart should still be there.
        await page.reload();
        await page.waitForFunction(
            () => window.ILAP && typeof window.ILAP.saveStats === 'function',
            null,
            { timeout: 15000 }
        );

        const midCount = (await getExtensionStorage(context, 'ilap_ignored_count')).ilap_ignored_count;
        expect(midCount).toBe(1);

        // 4. Second ignore from the freshly-injected content script. If the
        //    chrome.runtime context wired up correctly after restart, stats
        //    should land normally and the counter should advance to 2.
        await page.evaluate(() => window.ILAP.saveStats('Post-restart Game', 'Manual'));

        await expect.poll(
            async () => (await getExtensionStorage(context, 'ilap_ignored_count')).ilap_ignored_count,
            { timeout: 5000 }
        ).toBe(2);

        // 5. The smoking gun for an invalidated-context bug is the literal
        //    message Chrome emits. Either console error stream or pageerror
        //    would carry it if anything tried to touch chrome.* after the
        //    context died.
        const haystack = [...consoleErrors, ...pageErrors].join('\n');
        expect(haystack).not.toMatch(/Extension context invalidated/i);
    });
});
