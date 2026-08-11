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

const MI_MAX = 200;          // MIUNDO_MAX is the same number, on its own job
const TOAST = '.ilap-toast';
const SESSION_KEY = 'ilap_session_map_v2';

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

// Its mirror at MIUNDO_MAX. No per-appid meta beyond the gesture stamp the
// rollback entries carry, and appids that overlap nothing the page shows.
function fullMiUndoJob() {
    const appids = Array.from({ length: MI_MAX }, (_, i) => String(800000 + i));
    const meta = {};
    for (const a of appids) meta[a] = { ts: Date.now() };
    return {
        id: 'job_mi_undo', type: 'miundo', curatorId: 'miundo', curatorName: '',
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

    test('At MIUNDO_MAX a rollback raises the UN-IGNORE card, not the ignore one', async ({ page, context }) => {
        // The two caps are separate jobs with separate cards, and the reason is
        // the copy: each tells the user to "remove the job", and the MI one names
        // the IGNORE job — pointing at the wrong row is worse than saying nothing.
        // Seed BOTH queues full, so the only thing choosing between the cards is
        // which job actually refused.
        await setExtensionStorage(context, {
            ilap_curator_queue: [fullMiJob(), fullMiUndoJob()],
        });

        const calls = await interceptIgnoreApi(context);
        await page.goto(searchUrl());
        await waitForContentScript(page);
        const { appid } = await pickFirstRow(page);

        // Give this tab a badge to gesture at without spending a drain on it:
        // the session map IS the badge model, and restoring it from sessionStorage
        // is the same path a reload takes (see persistence.spec). It also leaves
        // the in-memory `ignoredAt` empty, so the anti-fiddling cooldown — which
        // only counts swipes THIS tab made — is not in the way.
        await page.evaluate(([key, id]) => sessionStorage.setItem(key, JSON.stringify([[id, 0]])),
            [SESSION_KEY, appid]);
        await page.reload();
        await waitForContentScript(page);

        const badge = page.locator(`${SEL.overlay}[data-ilap-appid="${appid}"]`).first();
        await expect(badge).not.toHaveCount(0, { timeout: 5000 });

        // The hard-wired floor: a click on the badge always asks for the
        // rollback, whatever the gesture binding says. Used here in place of the
        // zigzag because the branch under test is the queue's refusal, not the
        // gesture recognition (which zigzag.unit + solo-unignore already own).
        await badge.click({ force: true });

        await expect(page.locator(TOAST)).toBeVisible({ timeout: 5000 });
        await expect(page.locator(TOAST)).toContainText(/Un-ignore queue is stuck/i);

        // Nothing was queued and nothing was sent — and the badge stays, because
        // the game really is still ignored.
        const stored = await getExtensionStorage(context, 'ilap_curator_queue');
        const undo = stored.ilap_curator_queue.find(j => j.type === 'miundo');
        expect(undo.appids).toHaveLength(MI_MAX);
        expect(undo.appids).not.toContain(appid);
        expect(calls.length).toBe(0);
        await expect(badge).toHaveClass(/ilap-ignored-overlay/);
        await expect(badge).not.toHaveClass(/ilap-undo-pending/);
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

        // `:visible`, because this is the one place in the suite that SCROLLS a
        // row into view (three swipes in a burst is the whole point) and
        // scrollIntoViewIfNeeded waits for visibility, not just attachment.
        // Steam's search page serves off-screen duplicate rows and occasionally
        // a zero-size one; when it landed in the first three, the loop spun
        // until the test timeout — twice on a full run, green in isolation.
        const rows = page.locator('a.search_result_row[href*="/app/"]:visible');
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
