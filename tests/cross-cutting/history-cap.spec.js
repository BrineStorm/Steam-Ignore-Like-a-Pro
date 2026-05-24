const { test, expect } = require('@playwright/test');
const {
    setExtensionStorage,
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

// StatsLogic.pushHistory caps at 20 (src/utils.js). Driving 25 ignores through
// the public window.ILAP.saveStats facade verifies the cap end-to-end without
// touching internals, and confirms ordering is newest-first (LIFO).
test.describe('Cross-cutting — ilap_ignored_history is capped at 20 entries', () => {

    test('Pushing 25 entries via saveStats leaves history with exactly 20, newest-first', async ({ page, context }) => {
        // Any Steam page works — we just need the content script booted so the
        // window.ILAP.saveStats facade is reachable.
        await page.goto('/');
        await page.waitForFunction(
            () => window.ILAP && typeof window.ILAP.saveStats === 'function',
            null,
            { timeout: 15000 }
        );

        // Run 25 saves sequentially. saveStats chains get→set on chrome.storage,
        // so concurrent calls would race; awaiting each storage.set keeps order
        // deterministic.
        await page.evaluate(async () => {
            const total = 25;
            for (let i = 1; i <= total; i++) {
                window.ILAP.saveStats(`Game ${i}`, 'Manual');
                // Wait until this entry actually lands before scheduling the next.
                await new Promise((resolve) => {
                    const tick = () => {
                        chrome.storage.local.get('ilap_ignored_count', (res) => {
                            if ((res.ilap_ignored_count || 0) >= i) resolve();
                            else setTimeout(tick, 20);
                        });
                    };
                    tick();
                });
            }
        });

        // Count tracks every call regardless of cap.
        await expect.poll(
            async () => (await getExtensionStorage(context, 'ilap_ignored_count')).ilap_ignored_count,
            { timeout: 10_000 }
        ).toBe(25);

        const stored = await getExtensionStorage(context, 'ilap_ignored_history');
        const history = stored.ilap_ignored_history;
        expect(Array.isArray(history)).toBe(true);
        expect(history.length).toBe(20);

        // pushHistory prepends, so index 0 is the newest (Game 25) and the cap
        // drops the oldest (Game 1..5).
        expect(history[0].name).toBe('Game 25');
        expect(history[19].name).toBe('Game 6');
        const names = history.map(h => h.name);
        expect(names).not.toContain('Game 5');
        expect(names).not.toContain('Game 1');
    });
});
