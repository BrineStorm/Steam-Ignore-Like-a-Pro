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
const { interceptIgnoreApi, routeUserdata } = require('../_steam-routes.js');
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
const DRAIN_TIMEOUT = 15000;

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

// The deferral job, or null. Negative tests assert on THIS rather than on "no
// POST arrived within X ms": the POST is now seconds behind the gesture, so a
// short wait proves nothing about a swipe that wrongly enqueued.
async function miJob(context) {
    const { ilap_curator_queue: queue } = await getExtensionStorage(context, 'ilap_curator_queue');
    return (queue || []).find(j => j.type === 'mi') || null;
}

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

// Synthesize a held right-click swipe over the given locator.
//   dx: horizontal distance in px (positive = right). Detector threshold is 40.
//   dy: vertical drift; default 0 keeps it a clean horizontal swipe.
// Uses Playwright's mouse API which fires real MouseEvent with button=2,
// which is what SwipeGestureDetector listens for in capture phase.
async function rightClickSwipe(page, locator, dx, dy = 0) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error('rightClickSwipe: target has no bounding box');

    // Anchor near top-left of the element so even tall capsules stay in view
    // after the swipe. Cap at 30px so we don't fall off small tiles.
    const startX = box.x + Math.min(box.width / 2, 30);
    const startY = box.y + Math.min(box.height / 2, 30);

    await page.mouse.move(startX, startY);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(startX + dx / 2, startY + dy / 2, { steps: 5 });
    await page.mouse.move(startX + dx, startY + dy, { steps: 5 });
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
    gotoWithStubs,
    miJob,
    installContextMenuSpy,
    readContextMenuSpy,
    rightClickSwipe,
    pickFirstRow,
    searchRow,
    SEARCH_ROW,
    waitForContentScript,
};
