const { test, expect } = require('../_fixtures.js');
const {
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
} = require('../_extension.js');
const { interceptIgnoreApi, routeUserdata } = require('./_helpers.js');

// Each test installs interceptIgnoreApi itself to capture its own calls array.

// Phase-2 drainer (src/curator/drainer.js) end-to-end, with NO real ignores:
// the ignore endpoint and dynamicstore/userdata are both network-stubbed. We
// seed a job with hand-picked appids, open a Steam store page so the
// content-script drainer boots, and assert it ignores the right games (skipping
// the one already in userdata) and drives the cursor to done.

const STORE_PAGE = '/app/730/'; // any store.steampowered.com page boots the drainer

function makeJob(over = {}) {
    return Object.assign({
        id: 'job_drain_1',
        curatorId: '99001',
        curatorName: 'Drain Me',
        curatorUrl: 'https://store.steampowered.com/curator/99001/',
        filter: 'not_recommended',
        appids: ['111', '222', '333'],
        total: 3,
        status: 'pending',
        addedAt: Date.now(),
    }, over);
}

async function readQueue(context) {
    const res = await getExtensionStorage(context, 'ilap_curator_queue');
    return Array.isArray(res.ilap_curator_queue) ? res.ilap_curator_queue : [];
}

test.beforeEach(async ({ context, page }) => {
    await clearExtensionStorage(context);
    // The ignore POST early-returns false without a sessionid (g_sessionID/cookie),
    // so guarantee one regardless of login state — the route stubs the response.
    await context.addCookies([{
        name: 'sessionid', value: 'pwtestsession',
        domain: 'store.steampowered.com', path: '/',
    }]);
    void page;
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Curator — queue drainer', () => {

    test('drains a pending job: ignores un-ignored appids, skips already-ignored, then removes the finished job', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        await routeUserdata(context, ['222']); // 222 already ignored → dedupe-skip

        await setExtensionStorage(context, { ilap_curator_queue: [makeJob()] });
        await page.goto(STORE_PAGE);

        // A finished job leaves NO record behind — it's removed, not marked "done".
        await expect.poll(async () => (await readQueue(context)).length, { timeout: 20000 }).toBe(0);

        // Exactly the two un-ignored appids were sent; 222 was deduped, never POSTed.
        const sent = calls.map(c => c.appid).sort();
        expect(sent).toEqual(['111', '333']);
        expect(calls.every(c => c.reason === 0)).toBe(true);

        // A completion pulse was emitted (drives the widget's one-shot blink).
        const res = await getExtensionStorage(context, 'ilap_curator_pulse');
        expect(typeof res.ilap_curator_pulse).toBe('number');

        // The per-job progress cursor key is cleaned up with the finished job.
        const leftover = await getExtensionStorage(context, 'ilap_curator_cursor_job_drain_1');
        expect(leftover.ilap_curator_cursor_job_drain_1).toBeUndefined();
    });

    test('the rate gate paces consecutive ignore POSTs (>= floor apart)', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        await routeUserdata(context, []); // nothing pre-ignored → every appid POSTs

        // Four un-ignored appids → three inter-POST gaps to measure.
        await setExtensionStorage(context, {
            ilap_curator_queue: [makeJob({ appids: ['411', '422', '433', '444'], total: 4 })],
        });
        await page.goto(STORE_PAGE);

        await expect.poll(async () => calls.length, { timeout: 20000 }).toBe(4);

        // Every consecutive pair is spaced by at least the gate's defensive floor
        // (the governor sleeps ~MIN_GAP+jitter before each POST; assert the floor
        // to stay robust against scheduler noise). This is the aggregate-rate
        // guarantee the whole governor exists to provide.
        const FLOOR = 350; // src/gate.js GAP_FLOOR
        const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
        for (const g of gaps) expect(g).toBeGreaterThanOrEqual(FLOOR - 40); // small tolerance
    });

    test('master toggle off stops the drainer without burning the cursor (audit #1)', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        await routeUserdata(context, []);

        // Extension globally disabled: the gate refuses every reservation, so the
        // drainer must emit NO ignores and leave the job intact for when it's
        // re-enabled — not silently drain it dry in the background.
        await setExtensionStorage(context, {
            ilap_master_enabled: false,
            ilap_curator_queue: [makeJob()],
        });
        await page.goto(STORE_PAGE);
        await page.waitForTimeout(4000); // ample time to (not) drain

        expect(calls).toHaveLength(0);
        const job = (await readQueue(context))[0];
        expect(job && job.status).toBe('pending'); // still queued, not removed
        // The cursor never advanced past the start.
        const cur = await getExtensionStorage(context, 'ilap_curator_cursor_job_drain_1');
        const c = cur.ilap_curator_cursor_job_drain_1;
        expect(c == null || c === 0).toBe(true);
    });

    test('a paused job is never drained', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        await routeUserdata(context, []);

        await setExtensionStorage(context, { ilap_curator_queue: [makeJob({ status: 'paused' })] });
        await page.goto(STORE_PAGE);

        // Give the drainer ample time to (not) act.
        await page.waitForTimeout(4000);

        expect(calls).toHaveLength(0);
        const job = (await readQueue(context))[0];
        expect(job.status).toBe('paused');
        // No drain happened → the drainer never created the job's cursor key.
        const cur = await getExtensionStorage(context, 'ilap_curator_cursor_job_drain_1');
        expect(cur.ilap_curator_cursor_job_drain_1).toBeUndefined();
    });
});
