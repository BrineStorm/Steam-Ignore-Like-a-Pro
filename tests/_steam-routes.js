// Steam network stubs shared by every suite whose code path ends in an ignore
// POST — the curator drainer (bulk) and Manual Ignore (which now defers its
// swipes into the SAME drainer as a type:'mi' job, so it needs the identical
// pair of routes). Interception is at the NETWORK layer on purpose: it is
// world-independent (an isolated-world `window.ILAP.apiIgnoreGame` stub is
// invisible to page.evaluate) and it guarantees no request ever reaches Steam.

// Fulfill a fake success for Steam's ignore endpoint and record each call.
// Returns a LIVE array that fills as calls arrive: { appid, reason, at }.
// Install it BEFORE navigating so no gesture can slip through.
async function interceptIgnoreApi(context) {
    const calls = [];
    await context.route('**/recommended/ignorerecommendation/**', async (route) => {
        const params = new URLSearchParams(route.request().postData() || '');
        calls.push({ appid: params.get('appid'), reason: Number(params.get('ignore_reason')), at: Date.now() });
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

module.exports = { interceptIgnoreApi, routeUserdata };
