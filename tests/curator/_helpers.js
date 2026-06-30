// Shared helpers for the Phase-2 curator ignore-queue E2E specs.

// Intercept Steam's ignore endpoint at the network layer (world-independent —
// the drainer ignores via window.ILAP.apiIgnoreGame, isolated-world). Fulfills a
// fake success and records each call so tests assert what WOULD have been
// ignored, never touching the real account. Returns a live array of calls.
async function interceptIgnoreApi(context) {
    const calls = [];
    await context.route('**/recommended/ignorerecommendation/**', async (route) => {
        const params = new URLSearchParams(route.request().postData() || '');
        calls.push({ appid: params.get('appid'), reason: Number(params.get('ignore_reason')) });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: 1 }) });
    });
    return calls;
}

// Stub dynamicstore/userdata so the drainer's drain-time dedupe sees exactly the
// appids we choose as already-ignored (keys of rgIgnoredApps). ownedCount keeps
// the logged-in heuristics happy where they matter.
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
