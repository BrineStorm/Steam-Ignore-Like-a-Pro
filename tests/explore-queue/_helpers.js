// Shared helpers for Explore Queue (EQ) E2E tests.
// EQ activates on URLs like /app/<id>?queue=1 and injects the Queue Helper toast.

const AUTH_FILE = 'playwright/.auth/user.json';

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

// Visit /explore/ first so Steam initializes a queue session, then jump to the
// queue page for the requested app. Wait for either our toast or Steam's own
// next-in-queue button as proof the page settled.
async function openExploreQueue(page, appid = APP_A) {
    await page.goto('/explore/');
    await page.waitForLoadState('domcontentloaded');

    await page.goto(`/app/${appid}?queue=1`);
    await Promise.race([
        page.locator(SEL.toast).waitFor({ state: 'attached', timeout: 20000 }),
        page.locator(SEL.nextBtn).waitFor({ state: 'attached', timeout: 20000 }),
    ]).catch(() => { /* one of them is enough; tests assert specifics */ });
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

module.exports = {
    AUTH_FILE,
    SEL,
    KEYS,
    APP_A,
    APP_B,
    openExploreQueue,
    readSession,
};
