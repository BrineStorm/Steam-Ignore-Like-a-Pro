// Shared helpers for Manual Ignore (MI) E2E tests.
//
// IMPORTANT: a swipe no longer POSTs. It badges optimistically and enqueues a
// type:'mi' job that the CURATOR DRAINER sends through the IgnoreGate a few
// hundred ms later. Two consequences for every spec here:
//
//  1. the ignore endpoint must be intercepted at the NETWORK layer (the drainer
//     may even POST from another tab of the context — an isolated-world
//     window.ILAP stub could not see that, and route interception fulfills a
//     fake success so no request ever reaches Steam);
//  2. the drainer dedupes against dynamicstore/userdata before POSTing, so that
//     endpoint must be stubbed too — otherwise a swiped game that happens to be
//     among the real account's ~450 ignores is skipped and the spec waits for a
//     POST that will never come. `gotoWithStubs` installs both.
//
// Both stubs are shared with the curator suite (tests/_steam-routes.js).

const { popupUrl, getExtensionStorage } = require('../_extension.js');
const { interceptIgnoreApi, routeUserdata, routeLoginProbe } = require('../_steam-routes.js');
const { AUTH_FILE } = require('../_fixtures.js');

const SEL = {
    overlay: '.ilap-ignored-overlay',
    listBadge: '.ilap-ignored-overlay.ilap-list-badge',
    gridBadge: '.ilap-ignored-overlay.ilap-grid-badge',
    heroBadge: '.ilap-ignored-overlay.ilap-hero-badge',
    historyTrigger: '.history-trigger',
    historyList: '#history-list',
    lastGame: '#last-game',
};

// How long a deferred swipe may take to reach the POST: enqueue (storage RMW) →
// onChanged kick → the drainer's userdata read → an IgnoreGate slot (500-800 ms,
// serialized across appids) → POST. Comfortably over that, because a headed
// Firefox run under load is the slow case and a timeout here reads as a product
// bug rather than the harness being impatient.
//
// 25 s, not 15, as headroom rather than as a fix for anything observed: the
// gate's stop verdict can now cost a LIVE /account/ probe (gate.js →
// SteamAuth.hasLiveSession → steam-net.js) carrying the shared 10 s
// FETCH_TIMEOUT_MS deadline. On a page whose store header has not rendered
// readable-signed-in by the time the drain opens its pass, that probe plus the
// whole drain had to fit in 15 s — tight on arithmetic alone. No failure has
// been traced to it; the margin is for a slow connection or a loaded machine.
// Only failures pay for it: a poll that succeeds exits at its first satisfied
// check.
const DRAIN_TIMEOUT = 25000;

// Install both Steam stubs, navigate, and wait for the content script. Returns
// the live ignore-call array. Routes go up BEFORE the navigation so no gesture
// and no drain pass can slip past them.
async function gotoWithStubs(page, context, url) {
    const calls = await interceptIgnoreApi(context);
    await routeUserdata(context, []);   // nothing pre-ignored → the dedupe can never skip
    await page.goto(url);
    await waitForContentScript(page);
    return calls;
}

// The deferral job of a given type, or null. Negative tests assert on THIS
// rather than on "no POST arrived within X ms": the POST is now seconds behind
// the gesture, so a short wait proves nothing about a swipe that wrongly
// enqueued. 'mi' is the ignore direction, 'miundo' the solo rollback.
async function queueJob(context, type) {
    const { ilap_curator_queue: queue } = await getExtensionStorage(context, 'ilap_curator_queue');
    return (queue || []).find(j => j.type === type) || null;
}

async function miJob(context) { return queueJob(context, 'mi'); }
async function miUndoJob(context) { return queueJob(context, 'miundo'); }

// Track contextmenu events on document so tests can assert that the
// SwipeGestureDetector blocked the native menu after a successful gesture.
// The content script listens in capture phase (isolated world) and calls
// preventDefault; the underlying event's canceled flag is shared across worlds,
// so a main-world listener reads the correct defaultPrevented.
async function installContextMenuSpy(page) {
    await page.evaluate(() => {
        window.__ctxMenu = { fired: 0, prevented: 0 };
        document.addEventListener('contextmenu', (e) => {
            window.__ctxMenu.fired += 1;
            if (e.defaultPrevented) window.__ctxMenu.prevented += 1;
        });
    });
}

async function readContextMenuSpy(page) {
    return page.evaluate(() => window.__ctxMenu || { fired: 0, prevented: 0 });
}

// Where a gesture presses: 30 px in from the target's top-left corner, so even a
// tall capsule stays in view after the travel, capped at half the box so a small
// tile is still pressed inside itself. Returns VIEWPORT coordinates, or null when
// the element does not own that point.
//
// Owning it does not follow from having a box. The storefront's special-offers
// carousel keeps four pages in the DOM at once and marks them
// `.home_special_offers_group` + focus / next / prev — and every page but the
// focused one computes `pointer-events: none` (measured on the live page). An
// anchor inside such a page keeps its full 341x341 rect, so Playwright's
// `:visible` accepts it, while elementFromPoint over that rect falls straight
// through to div.carousel_items. Manual Ignore builds its intent from the
// mousedown TARGET (EventParser.createIntent), so a press there produces nothing
// at all: no POST, no badge, no queued job — at the assertion indistinguishable
// from a broken product, which is exactly how it read when it hit (a 25 s poll
// for a POST that was never going to come).
//
// Re-checked rather than sampled once because the carousel advances on its own:
// the page under the pointer can gain or lose `focus` between the measurement
// and the press, so rightClickSwipe asks again immediately before pressing.
async function pressPoint(locator, attempts = 3) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        await locator.scrollIntoViewIfNeeded();
        const box = await locator.boundingBox();
        if (!box) return null;
        const x = box.x + Math.min(box.width / 2, 30);
        const y = box.y + Math.min(box.height / 2, 30);
        const owned = await locator.evaluate((el, p) => {
            const hit = document.elementFromPoint(p.x, p.y);
            return !!hit && (el === hit || el.contains(hit));
        }, { x, y });
        if (owned) return { x, y };
        await locator.page().waitForTimeout(200);   // give an advancing carousel a beat
    }
    return null;
}

// Like pickFirstRow, but for surfaces where the first match is not necessarily
// pressable: returns the first candidate that owns its press point (see
// pressPoint), or null when none of them does.
async function pickSwipeable(page, selector, limit = 8) {
    const all = page.locator(selector);
    const count = Math.min(await all.count(), limit);
    for (let i = 0; i < count; i++) {
        const link = all.nth(i);
        if (!(await pressPoint(link))) continue;
        const href = await link.getAttribute('href');
        const m = href && href.match(/\/app\/(\d+)/);
        if (m) return { link, appid: m[1], href };
    }
    return null;
}

// Synthesize a held right-click swipe over the given locator.
//   dx: horizontal distance in px (positive = right). Detector threshold is 40.
//   dy: vertical drift; default 0 keeps it a clean horizontal swipe.
// Uses Playwright's mouse API which fires real MouseEvent with button=2,
// which is what SwipeGestureDetector listens for in capture phase.
async function rightClickSwipe(page, locator, dx, dy = 0) {
    const start = await pressPoint(locator);
    if (!start) throw new Error(
        'rightClickSwipe: the target owns no press point — it is rendered but not '
        + 'hit-testable (a carousel page with pointer-events: none), so the press '
        + 'would miss it entirely and the gesture would produce nothing');
    const { x: startX, y: startY } = start;

    await page.mouse.move(startX, startY);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(startX + dx / 2, startY + dy / 2, { steps: 5 });
    await page.mouse.move(startX + dx, startY + dy, { steps: 5 });
    await page.mouse.up({ button: 'right' });
}

// Synthesize the solo un-ignore gesture: a held right-click that travels out
// and comes back — the X-axis trace a circle leaves, either direction (see
// ZigzagTracker in src/manual-ignore/utils.js). One reversal, both legs `dx`
// long; the detector needs ≥30 px per leg and ≥12 px of counter-travel before a
// reversal counts, so the default clears both with room to spare.
//
// Anchored like rightClickSwipe, and it returns to the START x: that also keeps
// the release point inside the capsule, which matters because the gesture is
// resolved from its start element, not from where the button came up.
async function rightClickZigzag(page, locator, dx = 70) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error('rightClickZigzag: target has no bounding box');

    const startX = box.x + Math.min(box.width / 2, 30);
    const startY = box.y + Math.min(box.height / 2, 30);

    await page.mouse.move(startX, startY);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(startX + dx, startY, { steps: 8 });   // leg 1
    await page.mouse.move(startX, startY, { steps: 8 });        // leg 2 (the reversal)
    await page.mouse.up({ button: 'right' });
}

// On /search/, each result row IS the /app/ link (<a class="search_result_row">),
// so there is no nested anchor to query. Pick the row element directly. The
// extension resolves these rows via its Fallback strategy → 'grid' badge.
const SEARCH_ROW = 'a.search_result_row[href*="/app/"]';

async function pickFirstRow(page, rowSelector = SEARCH_ROW) {
    const link = page.locator(rowSelector).first();
    await link.waitFor({ state: 'attached', timeout: 15000 });
    const href = await link.getAttribute('href');
    const m = href && href.match(/\/app\/(\d+)/);
    if (!m) throw new Error(`pickFirstRow: no /app/<id> in href "${href}"`);
    return { link, appid: m[1], href };
}

// Locator for the search row of a specific appid (used to scope badge asserts).
function searchRow(page, appid) {
    return page.locator(`a.search_result_row[href*="/app/${appid}/"]`).first();
}

// World-independent readiness gate. Content scripts boot on the window 'load'
// event (src/manual-ignore/main.js) and then run an async config init before
// attaching gesture listeners. We can't observe the isolated-world window.ILAP
// from a main-world evaluate, so wait for load plus a short settle tick.
async function waitForContentScript(page) {
    await page.waitForLoadState('load');
    await page.waitForTimeout(800);
}

module.exports = {
    AUTH_FILE,
    SEL,
    DRAIN_TIMEOUT,
    popupUrl,
    interceptIgnoreApi,
    routeUserdata,
    routeLoginProbe,
    gotoWithStubs,
    queueJob,
    miJob,
    miUndoJob,
    installContextMenuSpy,
    readContextMenuSpy,
    rightClickSwipe,
    rightClickZigzag,
    pickFirstRow,
    pickSwipeable,
    searchRow,
    SEARCH_ROW,
    waitForContentScript,
};
