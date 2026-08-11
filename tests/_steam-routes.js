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
// appids we choose as already-ignored (keys of rgIgnoredApps). ownedCount keeps
// the logged-in heuristics happy where they matter.
//
// Passing an empty list is the normal choice for a test that expects a POST:
// the dedupe then cannot skip the appid. That matters for MI since the deferral
// — a swiped game that happens to sit in the real account's ~450 ignores would
// otherwise be dropped by the drainer with no POST at all.
async function routeUserdata(context, ignoredAppids) {
    const rgIgnoredApps = {};
    for (const id of ignoredAppids || []) rgIgnoredApps[String(id)] = 1;
    await context.route('**/dynamicstore/userdata/**', async (route) => {
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
// Re-adding the saved cookies used to play that part and no longer can: after
// `context.clearCookies()` a restored session only authenticates once the page
// NAVIGATES again (reproduced against live Steam with no extension loaded — a
// warm-up fetch does not do it), and "without a reload" is the very thing these
// specs assert. Both URLs are matched exactly so nothing else is intercepted.
const ACCOUNT_URL = 'https://store.steampowered.com/account/';
const LOGIN_REDIRECT = 'https://store.steampowered.com/login/?redir=account%2F';

async function routeLoginProbe(context, signedIn) {
    let live = !!signedIn;
    await context.route(ACCOUNT_URL, async (route) => {
        // Signed in: answer AT the requested URL. Signed out: send the probe
        // where Steam sends it, and fulfil that too so the stub stays offline.
        if (live) {
            await route.fulfill({ status: 200, contentType: 'text/html', body: '' });
        } else {
            await route.fulfill({ status: 302, headers: { location: LOGIN_REDIRECT } });
        }
    });
    await context.route(LOGIN_REDIRECT, (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '' }));
    return (v) => { live = !!v; };
}

module.exports = { interceptIgnoreApi, routeUserdata, routeLoginProbe };
