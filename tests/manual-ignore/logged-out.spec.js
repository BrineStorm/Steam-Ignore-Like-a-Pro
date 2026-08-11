// Manual Ignore while signed OUT — the regression this suite exists for.
//
// The old gate asked `getSessionID()`, i.e. "is there a sessionid cookie?".
// Steam hands that cookie to ANONYMOUS visitors as well (it is a CSRF token,
// not a credential), so on a signed-out store page the answer was yes: the
// swipe painted an optimistic IGNORED badge and queued a type:'mi' job whose
// POST could only be refused. Worse, nothing corrected it — the drainer's
// dead-session branch parks the pass with the cursor untouched instead of
// dropping the entry, so the badge never came off and no card was ever shown.
//
// Both halves are covered here: the gesture must refuse (nothing badged,
// nothing queued), and the GATE must refuse a job that is already in the queue
// (no POST at all, job untouched). The third test is the other direction — the
// gate is deliberately not a permanent "no": a page opened before the user
// signed in elsewhere must start working again without a reload.
//
// The ignore endpoint is intercepted throughout: the two signed-out tests use it
// as a tripwire (they assert ZERO calls), the third asserts the one call the
// recovered session is supposed to produce. Either way interception guarantees
// nothing here can reach the real Steam account.

const { test, expect } = require('../_fixtures.js');
const {
    SEL,
    DRAIN_TIMEOUT,
    interceptIgnoreApi,
    routeUserdata,
    routeLoginProbe,
    miJob,
    rightClickSwipe,
    pickFirstRow,
    waitForContentScript,
} = require('./_helpers');
const {
    clearExtensionStorage, setExtensionStorage, getExtensionStorage, resetBridgePage,
} = require('../_extension.js');
const { searchUrl } = require('../_search.js');

// A signed-out swipe costs one live /account/ probe (the store header settles
// only the signed-IN case), so the "nothing happened" assertions need more
// settle than a same-tick refusal would.
const REFUSAL_SETTLE_MS = 5000;

// Mirrors LOGIN_NEG_TTL_MS in src/steam-net.js (probeLoginCached): how long a
// signed-OUT verdict is reused before a gesture pays for another probe. Short
// on purpose — this is the constant the third test below waits out. The
// confirmed-signed-in verdict is cached far longer; it is not exercised here.
const PROBE_COOLDOWN_MS = 10000;

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — signed out', () => {

    test('a swipe badges nothing and queues nothing', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        await routeUserdata(context, []);
        await context.clearCookies();   // anonymous — Steam still sets a sessionid

        await page.goto(searchUrl());
        await waitForContentScript(page);

        const { link, appid } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);
        await page.waitForTimeout(REFUSAL_SETTLE_MS);

        await expect(page.locator(`${SEL.overlay}[data-ilap-appid="${appid}"]`)).toHaveCount(0);
        expect(await miJob(context)).toBeNull();
        expect(calls).toHaveLength(0);
    });

    test('the gate refuses to drain a job that is already queued', async ({ page, context }) => {
        // The gesture is out of the picture here: the job is planted directly, so
        // the only thing that can hold the POST back is IgnoreGate.stopVerdict.
        const calls = await interceptIgnoreApi(context);
        await routeUserdata(context, []);
        await context.clearCookies();
        // …including the tab the storage helpers use on Firefox, which the
        // fixture opened logged-in and whose drainer would otherwise happily
        // send the very POST this test asserts can't happen (see
        // resetBridgePage). No-op on Chromium.
        await resetBridgePage(context);

        await page.goto(searchUrl());
        await waitForContentScript(page);

        // The shape src/curator/store.js enqueueMi writes.
        await setExtensionStorage(context, {
            ilap_curator_queue: [{
                id: 'job_mi', type: 'mi', curatorId: 'mi', curatorName: '',
                appids: ['440'], meta: { 440: { name: 'Team Fortress 2', reason: 0 } },
                total: 1, status: 'pending', addedAt: Date.now(),
            }],
        });
        await page.waitForTimeout(REFUSAL_SETTLE_MS);

        expect(calls).toHaveLength(0);
        const { ilap_curator_queue: queue } = await getExtensionStorage(context, 'ilap_curator_queue');
        expect(queue).toHaveLength(1);          // not drained, not dropped
        expect(queue[0].appids).toEqual(['440']);
    });

    test('a page opened before sign-in starts working once the session appears', async ({ page, context }) => {
        // The probe cooldown is waited out in full below, so this one is long.
        test.setTimeout(90000);

        const calls = await interceptIgnoreApi(context);
        await routeUserdata(context, []);
        // The one thing the page cannot be made to do for real: the session must
        // appear while the page stays open and un-reloaded. Re-adding the saved
        // cookies does not do it any more (see routeLoginProbe), so the probe
        // itself is stubbed — everything else about this page is genuinely
        // signed out, header included, which is what the gesture path reads
        // first.
        const setSignedIn = await routeLoginProbe(context, false);
        await context.clearCookies();

        await page.goto(searchUrl());
        await waitForContentScript(page);

        const { link, appid } = await pickFirstRow(page);
        const badge = page.locator(`${SEL.overlay}[data-ilap-appid="${appid}"]`);
        await rightClickSwipe(page, link, 60);
        await page.waitForTimeout(REFUSAL_SETTLE_MS);
        await expect(badge).toHaveCount(0);     // refused, and the verdict is now cached

        // "The user signs in in another tab": the live session appears while THIS
        // page — whose header still reads signed-out — stays open. The next
        // gesture past the cooldown re-probes and finds it.
        setSignedIn(true);
        await page.waitForTimeout(PROBE_COOLDOWN_MS + 1000);

        await rightClickSwipe(page, link, 60);
        await expect(badge).not.toHaveCount(0, { timeout: 10000 });
        // Not "a job is in the queue": with the probe answering instantly the
        // drainer can empty and delete the job before this line runs. Assert the
        // thing the queue exists to produce — the deferred ignore really went
        // out, exactly once, for this appid and no other. It is the intercepted
        // endpoint throughout, so no real ignore can escape either.
        await expect.poll(() => calls.map(c => c.appid), { timeout: DRAIN_TIMEOUT })
            .toEqual([appid]);
    });
});
