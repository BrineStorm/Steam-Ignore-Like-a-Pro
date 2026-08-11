const { test, expect } = require('../_fixtures.js');
const {
    SEL,
    DRAIN_TIMEOUT,
    routeUserdata,
    rightClickSwipe,
    rightClickZigzag,
    pickFirstRow,
    searchRow,
    gotoWithStubs,
    miUndoJob,
    installContextMenuSpy,
    readContextMenuSpy,
    waitForContentScript,
} = require('./_helpers');
const {
    clearExtensionStorage, setExtensionStorage, getExtensionStorage,
} = require('../_extension.js');
const { searchUrl } = require('../_search.js');

// The solo un-ignore gesture: a zigzag (the X-axis trace of a circle, either
// direction) on a capsule this tab badged enqueues a type:'miundo' job, and the
// SAME drainer that sent the ignore sends remove=1 through the SAME rate gate.
//
// Every test here first has to CREATE something to roll back, so each one drives
// two full drains: swipe → ignore POST → badge, then gesture → remove POST →
// badge gone. Waiting for the ignore POST before gesturing is not just patience:
// the drainer's "last user intent wins" rule skips an appid whose newest ignore
// log entry is younger than the gesture, and that entry is written when the POST
// lands — not when the optimistic badge appears.
//
// Both Steam endpoints are stubbed at the network layer as everywhere else in
// this suite (see _steam-routes.js); un-ignore is the same endpoint as ignore
// with remove=1, so calls are told apart by that flag.

const TOAST = '.ilap-toast';
const PENDING = 'ilap-undo-pending';

// The anti-fiddling brake in src/manual-ignore/main.js, plus a margin. Every
// test that gestures a rollback has to sit it out — and it runs from the moment
// the ignore was QUEUED (`ignoredAt`, stamped right before the optimistic badge
// is painted), not from the POST, so waiting for the POST is not enough on its
// own. Wait from the BADGE for the same reason it can't be waited from the
// swipe: everything between the two — the login gate, the name resolve, the
// queue's read-modify-write — is time the brake hasn't started counting yet, and
// on a loaded headed Firefox that is most of this margin.
const COOLDOWN_WAIT = 2300;

// Ignore a search row and leave the badge on screen, with the ignore POST
// confirmed and the un-ignore cooldown spent. `dx` picks the reason: +60 is the
// default swipe (red, reason 0), -60 the platform swipe (blue, "Played
// Elsewhere", reason 2).
async function ignoreRow(page, calls, link, appid, dx = 60) {
    const before = calls.filter(c => !c.remove).length;
    await rightClickSwipe(page, link, dx);

    // The badge first, and the clock with it: it is painted one statement after
    // the cooldown's own stamp, which makes it the tightest anchor available
    // from out here. Counted, not visibility-checked: Steam's search page also
    // holds off-screen duplicate rows, so "painted" is the contract here.
    await expect(page.locator(`${SEL.overlay}[data-ilap-appid="${appid}"]`))
        .not.toHaveCount(0, { timeout: 5000 });
    const badgedAt = Date.now();

    await expect.poll(() => calls.filter(c => !c.remove).length,
        { timeout: DRAIN_TIMEOUT }).toBe(before + 1);
    const post = calls.filter(c => !c.remove)[before];
    expect(post.appid).toBe(appid);
    expect(post.reason).toBe(dx > 0 ? 0 : 2);

    const left = COOLDOWN_WAIT - (Date.now() - badgedAt);
    if (left > 0) await page.waitForTimeout(left);
}

async function ignoreFirstRow(page, calls, dx = 60) {
    const { link, appid } = await pickFirstRow(page);
    await ignoreRow(page, calls, link, appid, dx);
    return { link, appid };
}

// The Nth search row (each row IS the /app/ link — see _helpers.SEARCH_ROW).
async function pickRow(page, n) {
    const link = page.locator('a.search_result_row[href*="/app/"]').nth(n);
    await link.waitFor({ state: 'attached', timeout: 15000 });
    const href = await link.getAttribute('href');
    const m = href && href.match(/\/app\/(\d+)/);
    if (!m) throw new Error(`pickRow(${n}): no /app/<id> in href "${href}"`);
    return { link, appid: m[1] };
}

// Roll a badged game back and wait for the remove POST to land.
async function unignoreRow(page, calls, link, appid) {
    const before = calls.filter(c => c.remove).length;
    await rightClickZigzag(page, link);
    await expect.poll(() => calls.filter(c => c.remove).length,
        { timeout: DRAIN_TIMEOUT }).toBe(before + 1);
    expect(calls.filter(c => c.remove)[before].appid).toBe(appid);
    await expect(page.locator(`${SEL.overlay}[data-ilap-appid="${appid}"]`))
        .toHaveCount(0, { timeout: DRAIN_TIMEOUT });
}

function badgeFor(page, appid) {
    return page.locator(`${SEL.overlay}[data-ilap-appid="${appid}"]`);
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — solo un-ignore gesture', () => {

    // The zigzag is the most expensive gesture this suite synthesizes: two legs
    // of 8 interpolated mouse.move events, and ZigzagTracker banks a reversal
    // only if enough of them actually arrive. Under a long headed run's CPU
    // contention they coalesce, the tracker sees one leg instead of two, and a
    // test that is rock solid in isolation misses — the same class the firefox
    // project already carries retries for (see playwright.config.js), now
    // reaching Chromium because every earlier gesture here was a two-event
    // swipe or a plain click. Scoped to this describe rather than the chromium
    // project for that reason: no other Chromium suite drives a multi-leg
    // pointer trace. All of them are covered, not just the ones caught missing —
    // which test loses is a property of the load, not of the test.
    test.describe.configure({ retries: 1 });

    test('zigzag on a badged capsule rolls the ignore back', async ({ page, context }) => {
        // Hold the remove leg open so the provisional pending mark — which is
        // the whole point of NOT un-badging optimistically — is observable
        // instead of being overtaken by its own confirmation.
        const calls = [];
        await context.route('**/recommended/ignorerecommendation/**', async (route) => {
            const params = new URLSearchParams(route.request().postData() || '');
            const remove = params.get('remove') === '1';
            calls.push({ appid: params.get('appid'), reason: Number(params.get('ignore_reason')), remove });
            if (remove) await new Promise(r => setTimeout(r, 2000));
            await route.fulfill({
                status: 200, contentType: 'application/json',
                body: JSON.stringify({ success: 1 }),
            });
        });
        await routeUserdata(context, []);
        await page.goto(searchUrl());
        await waitForContentScript(page);

        const { link, appid } = await ignoreFirstRow(page, calls);

        await rightClickZigzag(page, link);

        // Provisional: the badge stays (the game IS still ignored) and only
        // dims, because nothing has been rolled back yet.
        await expect(badgeFor(page, appid).first())
            .toHaveClass(new RegExp(PENDING), { timeout: 5000 });

        // …then the rollback lands and the badge goes for real.
        await expect.poll(() => calls.filter(c => c.remove).length,
            { timeout: DRAIN_TIMEOUT }).toBe(1);
        expect(calls.find(c => c.remove).appid).toBe(appid);
        await expect(badgeFor(page, appid)).toHaveCount(0, { timeout: DRAIN_TIMEOUT });
    });

    test('a refused rollback keeps the badge, drops the mark and tells the user', async ({ page, context }) => {
        // The ignore lands; every remove is refused with the permanent
        // per-appid pair (400 + appdetails success:false), so the game stays
        // ignored and the badge it left dimmed has to look ignored again.
        const calls = [];
        await context.route('**/recommended/ignorerecommendation/**', async (route) => {
            const params = new URLSearchParams(route.request().postData() || '');
            const remove = params.get('remove') === '1';
            calls.push({ appid: params.get('appid'), reason: Number(params.get('ignore_reason')), remove });
            return remove
                ? route.fulfill({
                    status: 400, contentType: 'application/json',
                    body: JSON.stringify({ success: false }),
                })
                : route.fulfill({
                    status: 200, contentType: 'application/json',
                    body: JSON.stringify({ success: 1 }),
                });
        });
        await context.route('**/api/appdetails**', (route) => {
            const id = new URL(route.request().url()).searchParams.get('appids');
            return route.fulfill({
                status: 200, contentType: 'application/json',
                body: JSON.stringify({ [id]: { success: false } }),
            });
        });
        await routeUserdata(context, []);
        await page.goto(searchUrl());
        await waitForContentScript(page);

        const { link, appid } = await ignoreFirstRow(page, calls);

        await rightClickZigzag(page, link);
        await expect.poll(() => calls.filter(c => c.remove).length,
            { timeout: DRAIN_TIMEOUT }).toBe(1);

        // The user asked for a rollback that will never happen: card raised…
        await expect(page.locator(TOAST)).toBeVisible({ timeout: DRAIN_TIMEOUT });
        // …the badge stays, because it is telling the truth…
        await expect(badgeFor(page, appid)).not.toHaveCount(0);
        // …and it stops looking provisional.
        await expect(badgeFor(page, appid).first()).not.toHaveClass(new RegExp(PENDING));
    });

    test('zigzag on a capsule this tab never badged is inert', async ({ page, context }) => {
        // Scope guard: the gesture reaches only games in the tab's session map.
        const calls = await gotoWithStubs(page, context, searchUrl());

        const { link } = await pickFirstRow(page);
        await rightClickZigzag(page, link);
        await page.waitForTimeout(600);

        expect(await miUndoJob(context)).toBeNull();
        expect(calls).toHaveLength(0);
    });

    test('binding OFF: zigzag no longer rolls back', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_unignore_key: 'off' });
        const calls = await gotoWithStubs(page, context, searchUrl());
        await page.waitForTimeout(300);   // let ConfigService ingest the pre-set value

        const { link, appid } = await ignoreFirstRow(page, calls);

        await rightClickZigzag(page, link);
        await page.waitForTimeout(600);

        expect(await miUndoJob(context)).toBeNull();
        expect(calls.filter(c => c.remove)).toHaveLength(0);
        await expect(badgeFor(page, appid)).not.toHaveCount(0);
        await expect(badgeFor(page, appid).first()).not.toHaveClass(new RegExp(PENDING));
    });

    test('binding OFF: a click on the badge STILL rolls back (the hard-wired floor)', async ({ page, context }) => {
        // 'off' switches off the rebindable gesture, not the un-ignore: the badge
        // click is wired unconditionally, which is what the option's label
        // ("Badge click only") promises. The test that proves the promise — with
        // the setting at its most hostile value.
        await setExtensionStorage(context, { ilap_unignore_key: 'off' });
        const calls = await gotoWithStubs(page, context, searchUrl());
        await page.waitForTimeout(300);

        const { appid } = await ignoreFirstRow(page, calls);

        // Scoped to the row: the search page also holds off-screen duplicate
        // rows carrying their own badge.
        await searchRow(page, appid).locator(SEL.overlay).first().click();

        await expect.poll(() => calls.filter(c => c.remove).length,
            { timeout: DRAIN_TIMEOUT }).toBe(1);
        expect(calls.find(c => c.remove).appid).toBe(appid);
        await expect(badgeFor(page, appid)).toHaveCount(0, { timeout: DRAIN_TIMEOUT });
    });

    test('the badge-click floor is still under the master toggle', async ({ page, context }) => {
        // Hard-wired against the un-ignore SETTING, not against the extension
        // being switched off — an extension the user disabled must queue nothing
        // and swallow nothing. Same guard the right-click test below asserts,
        // reached through the other event.
        const calls = await gotoWithStubs(page, context, searchUrl());
        await page.waitForTimeout(300);

        const { appid } = await ignoreFirstRow(page, calls);

        await setExtensionStorage(context, { ilap_master_enabled: false });
        await page.waitForTimeout(300);   // ConfigService re-reads on onChanged

        await searchRow(page, appid).locator(SEL.overlay).first().click();
        await page.waitForTimeout(600);

        expect(await miUndoJob(context)).toBeNull();
        expect(calls.filter(c => c.remove)).toHaveLength(0);
        await expect(badgeFor(page, appid).first()).not.toHaveClass(new RegExp(PENDING));
    });

    test('ctrlKey binding: a modifier-click rolls the ignore back', async ({ page, context }) => {
        // The un-ignore select now offers the ignore selects' whole vocabulary.
        // ctrlKey is free here (the ignore bindings are the two default swipes),
        // which is the state the popup's cross-guard enforces.
        await setExtensionStorage(context, { ilap_unignore_key: 'ctrlKey' });
        const calls = await gotoWithStubs(page, context, searchUrl());
        await page.waitForTimeout(300);

        const { link, appid } = await ignoreFirstRow(page, calls);

        await link.scrollIntoViewIfNeeded();
        // force:true so Steam's nav overlays can't intercept — the capture-phase
        // document listener still sees the click (see shortcut-key.spec.js).
        await link.click({ modifiers: ['Control'], force: true });

        await expect.poll(() => calls.filter(c => c.remove).length,
            { timeout: DRAIN_TIMEOUT }).toBe(1);
        expect(calls.find(c => c.remove).appid).toBe(appid);
        await expect(badgeFor(page, appid)).toHaveCount(0, { timeout: DRAIN_TIMEOUT });
    });

    test('swipeLeft binding: the freed platform swipe un-ignores instead', async ({ page, context }) => {
        // A swipe can carry the rollback too — but only a swipe no ignore binding
        // claims, so Already Played is switched off to free it. Also pins the
        // precedence: the ignore bindings are resolved first, and the un-ignore
        // one only gets the swipe because nothing else wanted it.
        await setExtensionStorage(context, {
            ilap_platform_key: 'off',
            ilap_unignore_key: 'swipeLeft',
        });
        const calls = await gotoWithStubs(page, context, searchUrl());
        await page.waitForTimeout(300);

        const { link, appid } = await ignoreFirstRow(page, calls);   // swipe right, reason 0

        await rightClickSwipe(page, link, -60);

        await expect.poll(() => calls.filter(c => c.remove).length,
            { timeout: DRAIN_TIMEOUT }).toBe(1);
        expect(calls.find(c => c.remove).appid).toBe(appid);
        await expect(badgeFor(page, appid)).toHaveCount(0, { timeout: DRAIN_TIMEOUT });
    });

    test('a RIGHT-click on the badge rolls the ignore back too', async ({ page, context }) => {
        // The badge answers to either button, and to neither setting: the right
        // click is hard-wired next to the left one. Left at the shipped default
        // on purpose — the point is that no setting is involved.
        const calls = await gotoWithStubs(page, context, searchUrl());
        await page.waitForTimeout(300);

        const { appid } = await ignoreFirstRow(page, calls);

        // Scoped to the row so the click lands on a badge that is actually on
        // screen, not on one of the page's off-screen duplicate rows.
        await searchRow(page, appid).locator(SEL.overlay).first().click({ button: 'right' });

        await expect.poll(() => calls.filter(c => c.remove).length,
            { timeout: DRAIN_TIMEOUT }).toBe(1);
        expect(calls.find(c => c.remove).appid).toBe(appid);
        await expect(badgeFor(page, appid)).toHaveCount(0, { timeout: DRAIN_TIMEOUT });
    });

    test('the badge right-click still obeys the master toggle', async ({ page, context }) => {
        // The regression: the badge listeners are delegated listeners of their
        // own rather than a branch of the gesture detector, and this one used to
        // read only `unignoreKey`. With the extension disabled it still queued a
        // rollback — one the gate then refuses forever — so the badge sat dimmed
        // for good and the page's own context menu was swallowed by an extension
        // the user had turned off. Now that the binding answers to no setting at
        // all, the master toggle is the ONLY thing that can stop it.
        const calls = await gotoWithStubs(page, context, searchUrl());
        await page.waitForTimeout(300);

        const { appid } = await ignoreFirstRow(page, calls);

        // Off AFTER the ignore landed, so there is a real badge to right-click.
        await setExtensionStorage(context, { ilap_master_enabled: false });
        await page.waitForTimeout(300);   // ConfigService re-reads on onChanged

        await installContextMenuSpy(page);
        await searchRow(page, appid).locator(SEL.overlay).first().click({ button: 'right' });
        await page.waitForTimeout(600);

        expect(await miUndoJob(context)).toBeNull();
        expect(calls.filter(c => c.remove)).toHaveLength(0);
        await expect(badgeFor(page, appid).first()).not.toHaveClass(new RegExp(PENDING));
        // The other half of the regression: the binding's listener sits in
        // CAPTURE phase and calls stopPropagation, so a handled right-click never
        // reaches this document-level spy at all. Seeing the event — unprevented
        // — is the proof that a disabled extension left the page's own menu alone.
        const spy = await readContextMenuSpy(page);
        expect(spy.fired).toBeGreaterThan(0);
        expect(spy.prevented).toBe(0);
    });

    test('an unrecognised stored binding falls back to the default instead of disabling the gesture', async ({ page, context }) => {
        // ilap_unignore_key is clamped against UNIGNORE_KEYS rather than run
        // through normalizeShortcut, so a value from an older build (or a hand
        // edit) that matches no branch would otherwise silently become an inert
        // binding with nothing on screen to explain it.
        await setExtensionStorage(context, { ilap_unignore_key: 'swipeUp' });
        const calls = await gotoWithStubs(page, context, searchUrl());
        await page.waitForTimeout(300);

        const { link, appid } = await ignoreFirstRow(page, calls);   // spends the cooldown
        await unignoreRow(page, calls, link, appid);                 // default zigzag still fires
    });

    test('the cooldown makes an instant rollback a no-op, and it expires', async ({ page, context }) => {
        const calls = await gotoWithStubs(page, context, searchUrl());

        const { link, appid } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);
        await expect(badgeFor(page, appid)).not.toHaveCount(0, { timeout: 5000 });
        const badgedAt = Date.now();

        // The brake governs a REAL remove=1 and nothing else, so the ignore POST
        // has to land before the gesture: while the swipe is still queued the
        // gesture cancels it outright — a different path with a different
        // outcome (the badge goes), covered by the regret test below.
        // Bounded deliberately tight rather than at DRAIN_TIMEOUT: the whole
        // point is to gesture while the brake is still down, so a drain slow
        // enough to spend it must fail loudly instead of quietly turning this
        // into an assertion about nothing. The gate paces at MIN_GAP+jitter
        // (~0.5–0.8 s) and the queue write kicks the drainer at once, so the
        // margin against the 2 s brake is comfortable.
        await expect.poll(() => calls.filter(c => !c.remove).length,
            { timeout: 1500 }).toBe(1);

        // Straight back, inside the brake: nothing queued, nothing marked — and
        // the badge stays, which is what tells this apart from a cancel.
        await rightClickZigzag(page, link);
        await page.waitForTimeout(400);
        expect(await miUndoJob(context)).toBeNull();
        await expect(badgeFor(page, appid)).not.toHaveCount(0);
        await expect(badgeFor(page, appid).first()).not.toHaveClass(new RegExp(PENDING));

        // It is a brake, not a ban — the same gesture works once it lapses.
        const left = COOLDOWN_WAIT - (Date.now() - badgedAt);
        if (left > 0) await page.waitForTimeout(left);
        await unignoreRow(page, calls, link, appid);
    });

    test('regret before the ignore is SENT cancels it — neither POST goes out', async ({ page, context }) => {
        // The immediate-regret race, made deterministic by parking the MI job:
        // the swipe appends to a paused job the drainer will not touch, so the
        // gesture arrives while the ignore is still queued. Reversing it there
        // used to lose — the drainer compares the gesture against the ignore's
        // LOG entry, which is stamped when the POST lands, so an ignore that had
        // not landed yet always read as the newer intent and the rollback was
        // dropped silently, leaving the badge dimmed forever.
        test.setTimeout(60000);
        await setExtensionStorage(context, {
            ilap_curator_queue: [{
                id: 'job_mi', type: 'mi', curatorId: 'mi', curatorName: '',
                appids: [], meta: {}, total: 0, status: 'paused', addedAt: Date.now(),
            }],
        });
        const calls = await gotoWithStubs(page, context, searchUrl());
        await page.waitForTimeout(300);

        const { link, appid } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);
        await expect(badgeFor(page, appid)).not.toHaveCount(0, { timeout: 5000 });

        // Gestured INSIDE the 2 s brake, deliberately and with no wait: the
        // cancel is tried ahead of the cooldown, because the brake exists to
        // stop ignore→rollback POST ping-pong and a cancel sends neither. Behind
        // it this branch was near unreachable in the real world — the gate paces
        // at ~0.5–0.8 s, so an unparked swipe is already sent long before the
        // brake lifts, and every "wrong game" cost a real remove=1.
        await rightClickZigzag(page, link);

        // The badge goes at once and is never marked pending: there is nothing
        // to wait for, because nothing was ever sent.
        await expect(badgeFor(page, appid)).toHaveCount(0, { timeout: 5000 });
        expect(await miUndoJob(context)).toBeNull();

        // Un-park the job. The drainer must step over the cancelled entry rather
        // than ignore a game whose badge is already gone.
        const { ilap_curator_queue: q } = await getExtensionStorage(context, 'ilap_curator_queue');
        expect(q[0].meta[appid]).toMatchObject({ cancelled: true });
        await setExtensionStorage(context, {
            ilap_curator_queue: [Object.assign({}, q[0], { status: 'pending' })],
        });
        await page.waitForTimeout(4000);
        expect(calls).toHaveLength(0);
    });

    test('a cancelled swipe clears the badge in EVERY tab, not just the gesturing one', async ({ page, context }) => {
        // The cancel used to un-badge in place instead of pulsing it. Badges are
        // per-tab, so a second tab that swiped the same game went on showing
        // IGNORED for a swipe that had been taken back — and went on through
        // reloads, since the session map is persisted. The MI job is parked again
        // so the ignore stays queued and the gesture takes the CANCEL path.
        test.setTimeout(60000);
        await setExtensionStorage(context, {
            ilap_curator_queue: [{
                id: 'job_mi', type: 'mi', curatorId: 'mi', curatorName: '',
                appids: [], meta: {}, total: 0, status: 'paused', addedAt: Date.now(),
            }],
        });
        // ONE url for both tabs: searchUrl() draws a random term per call, so
        // navigating twice would land the two tabs on different result pages.
        const url = searchUrl();
        const calls = await gotoWithStubs(page, context, url);
        await page.waitForTimeout(300);

        const { link, appid } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);
        await expect(badgeFor(page, appid)).not.toHaveCount(0, { timeout: 5000 });

        // A second tab swipes the SAME game: the per-tab session map doesn't block
        // it, the queue de-dupes the entry, and this tab paints its own badge.
        const page2 = await context.newPage();
        await page2.goto(url);
        await waitForContentScript(page2);
        await searchRow(page2, appid).waitFor({ state: 'attached', timeout: 15000 });
        await rightClickSwipe(page2, searchRow(page2, appid), 60);
        await expect(badgeFor(page2, appid)).not.toHaveCount(0, { timeout: 5000 });

        await page.waitForTimeout(COOLDOWN_WAIT);
        await rightClickZigzag(page, link);

        // Nothing was ever sent — and the badge goes in BOTH tabs.
        await expect(badgeFor(page, appid)).toHaveCount(0, { timeout: 5000 });
        await expect(badgeFor(page2, appid)).toHaveCount(0, { timeout: DRAIN_TIMEOUT });
        expect(calls).toHaveLength(0);
        await page2.close();
    });

    test('after a rollback the game can be re-ignored with the OTHER reason, both ways', async ({ page, context }) => {
        // The per-tab session map is what blocks a second swipe on a badged game,
        // and a rollback clears it — so red→blue and blue→red must both be free
        // afterwards. One test, two rows, both directions: the guard is
        // reason-agnostic, so randomizing the direction would leave one of them
        // unexercised for a whole run.
        test.setTimeout(90000);
        const calls = await gotoWithStubs(page, context, searchUrl());

        for (const [first, second] of [[60, -60], [-60, 60]]) {
            const { link, appid } = await pickRow(page, first > 0 ? 0 : 1);
            await ignoreRow(page, calls, link, appid, first);
            await unignoreRow(page, calls, link, appid);
            // Re-ignore with the opposite reason — nothing may stand in the way.
            await ignoreRow(page, calls, link, appid, second);
        }
    });

    test('after a rollback the SAME reason can be applied again', async ({ page, context }) => {
        // The re-application case: same colour in and out. Which colour is
        // immaterial to the guard being tested, so it is drawn at random rather
        // than doubling the test.
        test.setTimeout(60000);
        const calls = await gotoWithStubs(page, context, searchUrl());

        const dx = Math.random() < 0.5 ? 60 : -60;
        const { link, appid } = await ignoreFirstRow(page, calls, dx);
        await unignoreRow(page, calls, link, appid);
        await ignoreRow(page, calls, link, appid, dx);
    });
});
