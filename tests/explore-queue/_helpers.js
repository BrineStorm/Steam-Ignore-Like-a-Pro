// Shared helpers for Explore Queue (EQ) E2E tests.
// EQ activates on URLs like /app/<id>?queue=1 and injects the Queue Helper toast.
//
// WHEN AN EQ SPEC GOES RED, SUSPECT THE SAVED SESSION FIRST — refresh it with
// `npm run test:auth`. Every EQ spec pulls AUTH_FILE from here into
// `test.use({ storageState: AUTH_FILE })` and has NO login guard at all, so a
// stale session neither skips nor reports itself: /explore/next/ just bounces a
// logged-out visitor and the queue chrome (#nextInDiscoveryQueue) never renders.
// Symptom: openExploreQueue times out waiting for the Next button, or the toast
// never appears — which reads like an EQ injection bug rather than a login one.

const { AUTH_FILE } = require('../_fixtures.js');

const SEL = {
    toast: '#ilap-toast',
    runBtn: '#ilap-run-btn',
    ffBtn: '#ilap-ff-btn',
    disableBtn: '#ilap-disable-btn',
    closeX: '#ilap-close-x',
    modeBadge: '#ilap-mode-badge',
    runningStopBtn: '#ilap-stop-btn',
    nextBtn: '#nextInDiscoveryQueue .btn_next_in_queue_trigger',
};

const KEYS = {
    ACTIVE: 'ilap_queue_active',
    FF: 'ilap_queue_ff',
    NAV_TOKEN: 'ilap_queue_nav_token',
    ACTIVE_APPID: 'ilap_queue_active_appid',
};

// Always-online popular appids — guaranteed to render Steam's queue chrome.
const APP_A = 730; // Counter-Strike 2
const APP_B = 570; // Dota 2

// Enter the live Discovery Queue. Only /explore/next/ renders Steam's queue
// chrome (#nextInDiscoveryQueue) and the ?queue=1 context the EQ content script
// keys off — navigating directly to /app/<id>?queue=1 just shows a plain store
// page with no queue UI. The queue serves whatever game is next; the caller
// cannot pick a specific appid, so this returns the appid that was actually
// served. Waits for our toast or Steam's next button as proof the page settled.
//
// Pass an integer `pos` to target a specific queue position (/explore/next/<pos>)
// — different positions serve different games, which is how callers land on a
// DISTINCT appid (e.g. to simulate a sideways navigation).
async function gotoQueuePath(page, path) {
    // A concurrent Steam-side navigation can abort our goto — that's benign here.
    await page.goto(path).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function landedOnQueue(page) {
    return Promise.race([
        page.locator(SEL.toast).waitFor({ state: 'attached', timeout: 8000 }).then(() => true),
        page.locator(SEL.nextBtn).waitFor({ state: 'attached', timeout: 8000 }).then(() => true),
    ]).catch(() => false);
}

async function openExploreQueue(page, pos) {
    const wantsPos = !(pos === undefined || pos === null || pos === '');
    const path = wantsPos ? `/explore/next/${pos}` : '/explore/next/';

    await gotoQueuePath(page, path);

    // The queue can be exhausted for the day ("You have viewed all the products
    // in your Discovery Queue for today") — Steam then shows a "Start another
    // queue" CTA instead of a game page, and the EQ content script never
    // activates (no ?queue=1 context → no toast). Generate a fresh queue (this
    // can be done repeatedly) and re-enter.
    if (!(await landedOnQueue(page))) {
        const cta = page.getByText(/start another queue/i).first();
        if (await cta.isVisible().catch(() => false)) {
            // Let the CTA's own navigation finish before touching the page again,
            // otherwise a re-goto races it into net::ERR_ABORTED.
            await Promise.all([
                page.waitForLoadState('load').catch(() => {}),
                cta.click().catch(() => {}),
            ]);
            // Only a position-specific caller needs to re-enter; the default
            // landing is already the new queue's first game.
            if (wantsPos) await gotoQueuePath(page, path);
            await landedOnQueue(page);
        }
    }

    const m = page.url().match(/\/app\/(\d+)/);
    return m ? m[1] : null;
}

async function readSession(page) {
    return page.evaluate((keys) => {
        const out = {};
        for (const [name, key] of Object.entries(keys)) {
            out[name] = sessionStorage.getItem(key);
        }
        return out;
    }, KEYS);
}

// Intercept Steam's ignore endpoint at the network layer (world-independent —
// the EQ automator ignores via window.ILAP.apiIgnoreGame, which lives in the
// isolated world and can't be stubbed from page.evaluate). Fulfills a fake
// success and records each call so tests can assert "no ignore happened"
// without ever touching the real account. Returns a live array of calls.
async function interceptIgnoreApi(context) {
    const calls = [];
    await context.route('**/recommended/ignorerecommendation/**', async (route) => {
        const params = new URLSearchParams(route.request().postData() || '');
        calls.push({ appid: params.get('appid'), reason: Number(params.get('ignore_reason')) });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: 1 }) });
    });
    return calls;
}

module.exports = {
    AUTH_FILE,
    SEL,
    KEYS,
    APP_A,
    APP_B,
    openExploreQueue,
    readSession,
    interceptIgnoreApi,
};
