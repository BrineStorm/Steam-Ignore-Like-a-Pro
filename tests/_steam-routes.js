// Steam network stubs shared by every suite whose code path ends in an ignore
// POST — the curator drainer (bulk) and Manual Ignore (which now defers its
// swipes into the SAME drainer as a type:'mi' job, so it needs the identical
// pair of routes). Interception is at the NETWORK layer on purpose: it is
// world-independent (an isolated-world `window.ILAP.apiIgnoreGame` stub is
// invisible to page.evaluate) and it guarantees no request ever reaches Steam.

// Fulfill a fake success for Steam's ignore endpoint and record each call.
// Returns a LIVE array that fills as calls arrive: { appid, reason, remove, at }.
// `remove` separates the two directions — un-ignore is the SAME endpoint with
// remove=1 (src/utils.js SteamAPI.unignore), so a spec that drives both an
// ignore and a rollback sees both here and must tell them apart.
// Install it BEFORE navigating so no gesture can slip through.
async function interceptIgnoreApi(context) {
    const calls = [];
    await context.route('**/recommended/ignorerecommendation/**', async (route) => {
        const params = new URLSearchParams(route.request().postData() || '');
        calls.push({
            appid: params.get('appid'),
            reason: Number(params.get('ignore_reason')),
            remove: params.get('remove') === '1',
            at: Date.now(),
        });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: 1 }) });
    });
    return calls;
}

// Stub dynamicstore/userdata so the drainer's drain-time dedupe sees exactly the
// appids we choose as already-ignored (keys of rgIgnoredApps), all with
// `reason` (0 Default, 2 Played Elsewhere — the MI dedupe compares it). ownedCount keeps
// the logged-in heuristics happy where they matter.
//
// Only the EXTENSION's read is stubbed (src/steam-net.js asks with `?_=<ts>`);
// the store page's own (`?id=…&cc=…`) goes to Steam. Stubbing that one too
// told the page the account ignores nothing, so Steam neither flagged nor hid
// the games it really ignores, and a spec picking "a capsule that isn't
// ignored" (pickFirstRow) could not tell them apart and badged one anyway.
//
// Passing an empty list is the normal choice for a test that expects a POST:
// the dedupe then cannot skip the appid. That matters for MI since the deferral
// — a swiped game that happens to sit in the real account's ~450 ignores would
// otherwise be dropped by the drainer with no POST at all.
async function routeUserdata(context, ignoredAppids, reason = 0) {
    const rgIgnoredApps = {};
    for (const id of ignoredAppids || []) rgIgnoredApps[String(id)] = reason;
    await context.route('**/dynamicstore/userdata/**', async (route) => {
        if (!new URL(route.request().url()).searchParams.has('_')) return route.continue();
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ rgIgnoredApps, rgOwnedApps: [1], rgWishlist: [] })
        });
    });
}

// Stub the live login probe (src/steam-net.js `probeLogin`): a GET of /account/,
// which Steam answers with a redirect to /login when the session is dead — the
// probe reads nothing but the final URL. Returns a setter, so a spec can flip
// the answer mid-test ("the user just signed in in another tab") while the page
// itself stays genuinely signed out, which is the state those specs are about.
//
// Only the signed-IN answer is stubbed, at /account/ itself. A signed-out probe
// goes to Steam: Playwright routes only the first request of a redirect chain,
// so a stubbed redirect would send its /login hop to the real page, which
// bounces a browser still holding the login cookie straight back to /account/
// — a "signed out" stub that answers signed in. A spec that wants signed out
// drops the cookies instead (signOutElsewhere, or clearCookies), as a real
// sign-out does.
//
// Re-adding the saved cookies used to play the signed-in part and no longer
// can: after `context.clearCookies()` a restored session only authenticates
// once the page NAVIGATES again (reproduced against live Steam with no
// extension loaded — a warm-up fetch does not do it), and "without a reload" is
// the very thing these specs assert. The URL is matched exactly so nothing else
// is intercepted.
const ACCOUNT_URL = 'https://store.steampowered.com/account/';

async function routeLoginProbe(context, signedIn) {
    let live = !!signedIn;
    await context.route(ACCOUNT_URL, (route) => (live
        ? route.fulfill({ status: 200, contentType: 'text/html', body: '' })
        : route.continue()));
    return (v) => { live = !!v; };
}

// A sign-out in another window, as every tab of the browser sees it: the login
// cookie is gone, and so is the refresh cookie a page load would re-issue it
// from (the probe's fetch already reads signed out without the first alone,
// measured); the sessionid — a CSRF token anonymous visitors get too — stays,
// and pages already open keep the header they rendered.
async function signOutElsewhere(context) {
    await context.clearCookies({ name: /^steam(LoginSecure|Refresh_steam)$/ });
}

// Stub Steam's Discovery Queue sale reward (src/queue-common/sale-reward.js): a definition
// running around now, and an account that has earned `earned` of its `perDef`
// items. Lets a spec drive the locked path whatever the real account holds and
// whether or not a sale is on. The request is a cross-origin fetch from the
// content script, so the CORS header is answered the way the real API answers
// it: only to the store's own origin. A browser that sends anything else (an
// extension origin) is refused here as it would be live.
async function routeSaleReward(context, { earned, perDef = 3 }) {
    const now = Math.floor(Date.now() / 1000);
    const def = {
        sale_reward_def_id: 1, rtime_start_time: now - 3600, rtime_end_time: now + 86400,
        num_items_per_def: perDef, reward_def_type: 2,
    };
    const STORE = 'https://store.steampowered.com';
    const reply = (route, response) => route.fulfill({
        status: 200, contentType: 'application/json',
        headers: route.request().headers().origin === STORE ? { 'Access-Control-Allow-Origin': STORE } : {},
        body: JSON.stringify({ response }),
    });
    await context.route('**/ISaleItemRewardsService/GetCurrentDefinition/**',
        (route) => reply(route, { definition: def }));
    await context.route('**/ISaleItemRewardsService/GetClaimedSaleRewards/**',
        (route) => reply(route, { num_items_earned: earned, num_items_granted: earned, current_def: def }));
}

module.exports = { interceptIgnoreApi, routeUserdata, routeLoginProbe, signOutElsewhere, routeSaleReward };
