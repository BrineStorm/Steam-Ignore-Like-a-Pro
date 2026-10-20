// Manual Ignore after the user signs out in ANOTHER window.
//
// Two kinds of page are left behind, and they answer differently:
//  - a store page opened while signed in keeps its header (signed in) and
//    Steam's grey on the games the account ignores, until it is reloaded;
//  - a page opened after the sign-out is anonymous: no grey, header signed out.
//
// What each gesture must do there:
//  1. old page, a capsule Steam greys out: the stale header lets the gesture
//     through as in case 3 — Steam's flag is tinted and the entry queued — and
//     its POST is refused and held the same way, with nothing said;
//  2. new window, a game the account ignores: Steam does not grey it any more,
//     and the login gate refuses the swipe — nothing badged, queued or sent.
//     The Total Ignored poll on that page reads nothing either;
//  3. old page, a capsule Steam does not grey: the stale header lets the swipe
//     through (the gate trusts a signed-in header without a probe), so it is
//     badged and queued. Its POST is refused, the drainer's fresh probe blames
//     the session, and the entry is HELD: no 'failed' card, no stats, no count —
//     and it lands once, when the session is back;
//  4. old page, un-ignore on a badge: the rollback is queued and held the same
//     way — no remove=1 POST, and the signed-out empty userdata read does not
//     overwrite Steam's total with 0.
//
// The sign-out itself is real in every case: the login cookies are dropped
// (signOutElsewhere), which is what it does to every tab of the browser, so the
// drainer's fresh login probe asks live Steam and hears "signed out". The ignore
// endpoint is intercepted throughout; cases 3 and 4 refuse it the way Steam does
// signed out (400 {"success":false}, measured live), and case 3 stubs the probe
// for the sign-in that ends it.

const { test, expect } = require('../_fixtures.js');
const {
    SEL,
    DRAIN_TIMEOUT,
    interceptIgnoreApi,
    routeUserdata,
    routeLoginProbe,
    miJob,
    miUndoJob,
    rightClickSwipe,
    pickFirstRow,
    greyOut,
    searchRow,
    waitForContentScript,
} = require('./_helpers');
const { clearExtensionStorage, getExtensionStorage, setExtensionStorage } = require('../_extension.js');
const { signOutElsewhere } = require('../_steam-routes.js');
const { searchUrl } = require('../_search.js');

const STORE = 'https://store.steampowered.com';

// A refused gesture settles after one live /account/ probe at most.
const SETTLE_MS = 5000;
// DEAD_SESSION_PARK_MS in src/curator/drainer.js: how long the drainer waits
// after a POST it blamed on the session before it tries again.
const PARK_MS = 60000;

// Steam's answer to an ignore POST without a session.
const REFUSED = { status: 400, contentType: 'application/json', body: '{"success":false}' };

// Ignore POSTs are refused while `signedOut()` says so (recorded in `refused`),
// and fall through to interceptIgnoreApi's success otherwise.
async function refuseWhileSignedOut(context, signedOut) {
    const refused = [];
    await context.route('**/recommended/ignorerecommendation/**', async (route) => {
        if (!signedOut()) return route.fallback();
        const params = new URLSearchParams(route.request().postData() || '');
        refused.push({ appid: params.get('appid'), remove: params.get('remove') === '1' });
        await route.fulfill(REFUSED);
    });
    return refused;
}

// A search row for a game the account really ignores, on an anonymous page:
// found by its name, which appdetails gives (a region-locked appid answers
// success:false and is skipped). null when none of the first few is listed.
async function findIgnoredGameRow(page, ignoredIds) {
    for (const appid of ignoredIds.slice(0, 8)) {
        const res = await page.context().request.get(
            `${STORE}/api/appdetails?appids=${appid}&filters=basic`);
        const body = await res.json().catch(() => null);
        const name = body && body[appid] && body[appid].success && body[appid].data.name;
        if (!name) continue;
        await page.goto(`/search/?term=${encodeURIComponent(name)}`);
        await waitForContentScript(page);
        const row = searchRow(page, appid);
        if (await row.count() && await row.boundingBox()) return { link: row, appid };
    }
    return null;
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — the session ends in another window', () => {

    test('old page: a capsule Steam still greys out is tinted and queued, and its refused POST is held', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        await routeUserdata(context, []);   // what a signed-out read returns
        let signedOut = false;
        const refused = await refuseWhileSignedOut(context, () => signedOut);
        await page.goto(searchUrl());
        await waitForContentScript(page);

        const { link, appid } = await pickFirstRow(page);
        await greyOut(link);

        // Signed out elsewhere: every tab of the browser loses the login cookies,
        // this page keeps what it rendered.
        await signOutElsewhere(context);
        signedOut = true;

        await rightClickSwipe(page, link, 60);
        await expect(link).toHaveClass(/ilap-steam-tint-ignore/, { timeout: 5000 });
        await expect.poll(() => refused.length, { timeout: DRAIN_TIMEOUT }).toBeGreaterThan(0);
        await page.waitForTimeout(SETTLE_MS);

        expect(refused.every(r => r.appid === appid && !r.remove)).toBe(true);
        const job = await miJob(context);
        expect(job && job.appids).toContain(appid);
        await expect(link).toHaveClass(/ilap-steam-tint-ignore/);
        await expect(page.locator('.ilap-toast')).toHaveCount(0);
        await expect(searchRow(page, appid).locator(SEL.overlay)).toHaveCount(0);
        expect(calls).toHaveLength(0);
    });

    test('new window: a game the account ignores is not greyed any more, and the swipe is refused', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        // The account's real list, read while still signed in.
        const res = await context.request.get(`${STORE}/dynamicstore/userdata/?_=${Date.now()}`);
        const ignoredIds = Object.keys(((await res.json().catch(() => null)) || {}).rgIgnoredApps || {});
        test.skip(!ignoredIds.length, 'the saved session reads no ignored games');

        // Steam's total as a signed-in page left it, old enough to be re-read.
        const snapshot = { total: ignoredIds.length, tallyAt: 0, ts: Date.now() - 20 * 60 * 1000 };
        await setExtensionStorage(context, { ilap_ignored_total: snapshot });

        await signOutElsewhere(context);
        const fresh = await context.newPage();
        const target = await findIgnoredGameRow(fresh, ignoredIds);
        test.skip(!target, 'none of the account\'s first ignored games is listed to a signed-out visitor');

        await rightClickSwipe(fresh, target.link, 60);
        await fresh.waitForTimeout(SETTLE_MS);

        await expect(searchRow(fresh, target.appid).locator(SEL.overlay)).toHaveCount(0);
        expect(await miJob(context)).toBeNull();
        expect(calls).toHaveLength(0);

        // The page load's poll found the total stale, claimed the attempt and
        // read nothing: a signed-out list is empty, never a 0.
        const after = await getExtensionStorage(context, ['ilap_ignored_total', 'ilap_ignored_total_poll']);
        expect(after.ilap_ignored_total).toEqual(snapshot);
        expect(after.ilap_ignored_total_poll).toBeGreaterThan(snapshot.ts);
    });

    test('old page: a capsule Steam does not grey is held through the dead session and lands once it is back', async ({ page, context }) => {
        // The park after the refused POST is waited out in full.
        test.setTimeout(PARK_MS + DRAIN_TIMEOUT + 60000);
        const calls = await interceptIgnoreApi(context);
        await routeUserdata(context, []);
        const setSignedIn = await routeLoginProbe(context, true);
        let signedOut = false;
        const refused = await refuseWhileSignedOut(context, () => signedOut);

        await page.goto(searchUrl());
        await waitForContentScript(page);
        const { link, appid } = await pickFirstRow(page);
        const badge = searchRow(page, appid).locator(SEL.overlay);

        // Signed out elsewhere. The header here still reads signed in.
        await signOutElsewhere(context);
        signedOut = true;
        setSignedIn(false);

        await rightClickSwipe(page, link, 60);
        // The stale header lets it through: badged and queued.
        await expect(badge).not.toHaveCount(0, { timeout: 5000 });
        await expect.poll(() => refused.length, { timeout: DRAIN_TIMEOUT }).toBeGreaterThan(0);
        await page.waitForTimeout(SETTLE_MS);

        // Held: the badge stays, the entry stays, nothing was counted or said.
        expect(refused.every(r => r.appid === appid && !r.remove)).toBe(true);
        await expect(badge).not.toHaveCount(0);
        await expect(page.locator('.ilap-toast')).toHaveCount(0);
        const job = await miJob(context);
        expect(job && job.appids).toContain(appid);
        const held = await getExtensionStorage(context, [`ilap_curator_cursor_${job.id}`,
            'ilap_ignored_count', 'ilap_last_ignored_name']);
        expect(held[`ilap_curator_cursor_${job.id}`] || 0).toBe(0);
        expect(held.ilap_ignored_count).toBeUndefined();
        expect(held.ilap_last_ignored_name).toBeUndefined();
        expect(calls).toHaveLength(0);

        // Signed back in (the probe stub: re-added cookies would not authenticate
        // without a navigation, see routeLoginProbe). The same entry goes out
        // once, after the park.
        signedOut = false;
        setSignedIn(true);
        await expect.poll(() => calls.map(c => c.appid), { timeout: PARK_MS + DRAIN_TIMEOUT })
            .toEqual([appid]);
        await expect(badge).not.toHaveCount(0);
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_ignored_count')).ilap_ignored_count)
            .toBe(1);
    });

    test('old page: an un-ignore after the sign-out sends no rollback and leaves Steam\'s total alone', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        await routeUserdata(context, []);   // also what a signed-out read returns
        let signedOut = false;
        const refused = await refuseWhileSignedOut(context, () => signedOut);

        await page.goto(searchUrl());
        await waitForContentScript(page);
        const { link, appid } = await pickFirstRow(page);
        const badge = searchRow(page, appid).locator(SEL.overlay);

        // Ignored while still signed in.
        await rightClickSwipe(page, link, 60);
        await expect.poll(() => calls.map(c => c.appid), { timeout: DRAIN_TIMEOUT }).toEqual([appid]);
        await expect(badge).not.toHaveCount(0);

        const total = { total: 565, tallyAt: 1, ts: Date.now() };
        await setExtensionStorage(context, { ilap_ignored_total: total });

        await signOutElsewhere(context);
        signedOut = true;
        await page.waitForTimeout(2500);   // past the un-ignore cooldown
        await badge.first().click();
        await expect(badge.first()).toHaveClass(/ilap-undo-pending/, { timeout: 5000 });
        await page.waitForTimeout(SETTLE_MS);

        expect(calls.filter(c => c.remove)).toHaveLength(0);
        expect(refused).toHaveLength(0);   // stopped before the POST, on the empty read
        expect(await miUndoJob(context)).not.toBeNull();
        await expect(badge).not.toHaveCount(0);
        expect((await getExtensionStorage(context, 'ilap_ignored_total')).ilap_ignored_total).toEqual(total);
    });
});
