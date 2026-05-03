// Shared helpers for Manual Ignore (MI) E2E tests.
//
// IMPORTANT: Manual Ignore is the ONLY automator that calls the real Steam
// ignore API directly (DQ/EQ click Steam's own UI buttons). To keep tests
// from polluting the real account, every test stubs window.ILAP.apiIgnoreGame
// before triggering any gesture. The adapter in main.js reads the global on
// every call (closure, not capture), so the stub is honored.

const { popupUrl } = require('../_extension.js');

const AUTH_FILE = 'playwright/.auth/user.json';

const SEL = {
    overlay: '.ilap-ignored-overlay',
    listBadge: '.ilap-ignored-overlay.ilap-list-badge',
    gridBadge: '.ilap-ignored-overlay.ilap-grid-badge',
    heroBadge: '.ilap-ignored-overlay.ilap-hero-badge',
    historyTrigger: '.history-trigger',
    historyList: '#history-list',
    lastGame: '#last-game',
};

// Replace the real Steam ignore call with a recorder that always succeeds.
// Adapters in src/manual-ignore/main.js call window.ILAP.apiIgnoreGame at
// invocation time, so swapping it out *after* the content script has booted
// is enough — no rebuild needed.
async function stubIgnoreApi(page) {
    await page.waitForFunction(() => window.ILAP && window.ILAP.apiIgnoreGame, null, { timeout: 15000 });
    await page.evaluate(() => {
        window.__ilapApiCalls = [];
        window.ILAP.apiIgnoreGame = (appid, reason) => {
            window.__ilapApiCalls.push({ appid: String(appid), reason });
            return Promise.resolve(true);
        };
    });
}

async function getApiCalls(page) {
    return page.evaluate(() => window.__ilapApiCalls || []);
}

// Track contextmenu events on document so tests can assert that the
// SwipeGestureDetector blocked the native menu after a successful gesture.
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

// Wait until the content script has booted and IgnoreManager is reachable.
// We use the presence of the global facade as the gate.
async function waitForContentScript(page) {
    await page.waitForFunction(
        () => window.ILAP && typeof window.ILAP.apiIgnoreGame === 'function',
        null,
        { timeout: 15000 }
    );
}

module.exports = {
    AUTH_FILE,
    SEL,
    popupUrl,
    stubIgnoreApi,
    getApiCalls,
    installContextMenuSpy,
    readContextMenuSpy,
    rightClickSwipe,
    pickFirstAppLink,
    waitForContentScript,
};
