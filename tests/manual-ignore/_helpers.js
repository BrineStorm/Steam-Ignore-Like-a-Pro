// Shared helpers for Manual Ignore (MI) E2E tests.
//
// IMPORTANT: Manual Ignore is the ONLY automator that calls the real Steam
// ignore API directly (DQ/EQ click Steam's own UI buttons). To keep tests from
// polluting the real account we intercept the ignore endpoint at the NETWORK
// layer via context.route. This is world-independent (the old window.ILAP stub
// lived in the isolated world and was invisible to page.evaluate) AND guarantees
// no request ever reaches Steam, because the route fulfills a fake success.

const { popupUrl } = require('../_extension.js');
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

// Intercept POSTs to Steam's ignore endpoint and fulfill a fake success. Returns
// a LIVE array that fills as calls arrive: { appid, reason }. The body shape is
// `sessionid=...&appid=<id>&snr=&ignore_reason=<reason>` (see SteamAPI.ignore in
// src/utils.js). Install this BEFORE navigating so no gesture can slip through.
async function interceptIgnoreApi(context) {
    const calls = [];
    await context.route('**/recommended/ignorerecommendation/**', async (route) => {
        const params = new URLSearchParams(route.request().postData() || '');
        calls.push({
            appid: params.get('appid'),
            reason: Number(params.get('ignore_reason')),
        });
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: 1 }),
        });
    });
    return calls;
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

// Pick the first /app/<id> link inside a given container selector. Returns
// both the locator and the parsed appid so tests can assert against it.
async function pickFirstAppLink(page, containerSelector) {
    const link = page.locator(`${containerSelector} a[href*="/app/"]`).first();
    await link.waitFor({ state: 'attached', timeout: 15000 });
    const href = await link.getAttribute('href');
    const m = href && href.match(/\/app\/(\d+)/);
    if (!m) throw new Error(`pickFirstAppLink: no /app/<id> in href "${href}"`);
    return { link, appid: m[1], href };
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
    popupUrl,
    interceptIgnoreApi,
    installContextMenuSpy,
    readContextMenuSpy,
    rightClickSwipe,
    pickFirstAppLink,
    pickFirstRow,
    searchRow,
    SEARCH_ROW,
    waitForContentScript,
};
