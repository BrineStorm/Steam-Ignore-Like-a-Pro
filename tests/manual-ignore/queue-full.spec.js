const { test, expect } = require('../_fixtures.js');
const {
    SEL,
    interceptIgnoreApi,
    pickFirstRow,
    searchRow,
    waitForContentScript,
} = require('./_helpers');
const { clearExtensionStorage, setExtensionStorage, getExtensionStorage } = require('../_extension.js');
const { searchUrl } = require('../_search.js');

// MI defers every swipe into the shared queue as a type:'mi' job. At MI_MAX
// (200 pending entries) Store.enqueueMi refuses and MI paints nothing — which
// is only reachable when the queue is NOT draining (no store tab + a halted SW
// route, a gate stop, a dead session), i.e. the queue is stuck. Without
// feedback that reads as a broken extension, so the swipe now raises the shared
// bottom-right push card (src/toast.js), throttled to one per burst.
//
// The cap is seeded directly into storage: 200 real swipes would take minutes
// and the point under test is the refusal branch, not the counting.

const MI_MAX = 200;
const TOAST = '.ilap-toast';

// A full MI job in the shape Store.enqueueMi maintains. The appids are dummies
// (nothing drains them here — no drainer runs against a fabricated job that is
// already at its cap, and the ignore endpoint is intercepted anyway).
function fullMiJob() {
    const appids = Array.from({ length: MI_MAX }, (_, i) => String(900000 + i));
    const meta = {};
    for (const a of appids) meta[a] = { name: 'Seeded ' + a, reason: 0 };
    return {
        id: 'job_mi', type: 'mi', curatorId: 'mi', curatorName: '',
        appids, meta, total: appids.length, status: 'paused', addedAt: Date.now(),
    };
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — queue full at MI_MAX', () => {

    test('A swipe past the cap pushes the "queue is stuck" card and badges nothing', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'ctrlKey',
            ilap_platform_key: 'off',
            ilap_curator_queue: [fullMiJob()],
        });

        const calls = await interceptIgnoreApi(context);
        await page.goto(searchUrl());
        await waitForContentScript(page);
        await page.waitForTimeout(400);   // ConfigService.listen() settle

        const { link, appid } = await pickFirstRow(page);
        await link.scrollIntoViewIfNeeded();
        await link.click({ modifiers: ['Control'], force: true });

        await expect(page.locator(TOAST)).toBeVisible({ timeout: 5000 });
        await expect(page.locator(TOAST)).toContainText(/stuck/i);

        // The optimistic badge is deliberately withheld — nothing was queued, so
        // the game is not going to be ignored and must not look ignored.
        await expect(searchRow(page, appid).locator(SEL.overlay)).toHaveCount(0);
        expect(calls.length).toBe(0);

        // The refused appid was not appended to the job either.
        const stored = await getExtensionStorage(context, 'ilap_curator_queue');
        expect(stored.ilap_curator_queue[0].appids).toHaveLength(MI_MAX);
        expect(stored.ilap_curator_queue[0].appids).not.toContain(appid);
    });

    test('Repeat swipes in one burst raise a single card (throttled)', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'ctrlKey',
            ilap_platform_key: 'off',
            ilap_curator_queue: [fullMiJob()],
        });

        await interceptIgnoreApi(context);
        await page.goto(searchUrl());
        await waitForContentScript(page);
        await page.waitForTimeout(400);

        const rows = page.locator('a.search_result_row[href*="/app/"]');
        await rows.first().waitFor({ state: 'attached', timeout: 15000 });
        const count = Math.min(3, await rows.count());
        for (let i = 0; i < count; i++) {
            const row = rows.nth(i);
            await row.scrollIntoViewIfNeeded();
            await row.click({ modifiers: ['Control'], force: true });
            await page.waitForTimeout(150);
        }

        await expect(page.locator(TOAST)).toHaveCount(1, { timeout: 5000 });
    });
});
