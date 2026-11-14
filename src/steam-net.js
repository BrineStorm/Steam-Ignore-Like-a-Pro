// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Steam network reads, shared by the two worlds that talk to Steam: the
    // content script and the service worker (popup.html never fetches Steam).
    // The ignore POST itself stays per world on purpose: the sessionid source,
    // the cookie mode and the SW's halt counter differ, and a shared factory on
    // the most dangerous path would let one bug break both worlds.

    // Every Steam fetch has a deadline, so a hung request fails like a network
    // error instead of wedging its caller (the drainer's `draining` latch above
    // all). The timer is not cleared when fetch() resolves: that happens at the
    // headers, and a stalled body must hit the same deadline.
    const FETCH_TIMEOUT_MS = 10000;
    function fetchWithTimeout(url, options, timeoutMs) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs || FETCH_TIMEOUT_MS);
        return fetch(url, Object.assign({}, options, { signal: ctl.signal }))
            .catch(err => { clearTimeout(timer); throw err; });
    }

    // Every ignored appid with its ignore reason (0 Default, 2 Played
    // Elsewhere), from Steam's dynamic store: Map<appid string, reason number>.
    // Strict: null on any failure, an answer with no ignore list among them,
    // because the undo drainer reads "not in the map" as "already rolled back"
    // and must tell a failure from an empty map.
    // The lenient flavour is caller policy (utils.js).
    // The same read has the wishlist and the library, so the map has them as
    // `wishlist` and `owned`, Sets of appid strings: the automated sources never
    // ignore a wishlisted or owned game. Each is null when the answer has no
    // list: a changed shape must not read as an empty list, or every automated
    // source would ignore those games. The creators the account ignores and
    // follows come the same way, as `creatorsIgnored` and `creatorsFollowed`,
    // Sets of clan id strings.
    // `opts.onRateLimited(retryAfterMs)`: told of a 429, which is Steam asking
    // for less of everything. A drain pass passes the gate's penalty.
    const USERDATA_URL = 'https://store.steampowered.com/dynamicstore/userdata/';
    // It lags an ignore POST, and a remove=1, by seconds: a read this soon after
    // one may not show it yet. The drainer's dedupe and the ignored-total poll
    // both wait it out.
    const USERDATA_LAG_MS = 15000;
    async function fetchIgnoredAppsStrict(opts) {
        try {
            const res = await fetchWithTimeout(`${USERDATA_URL}?_=${Date.now()}`, {
                credentials: 'include', cache: 'no-store'
            });
            if (res.status === 429 && opts && opts.onRateLimited) await opts.onRateLimited(ignoreResult(res).retryAfterMs);
            if (!res.ok) return null;
            const data = await res.json();
            const ignored = data && data.rgIgnoredApps;
            // Steam sends an empty list as {} or []: both are objects.
            if (!ignored || typeof ignored !== 'object') return null;
            const map = new Map(Object.keys(ignored).map(k => [String(k), Number(ignored[k])]));
            const list = (v) => (Array.isArray(v) ? new Set(v.map(String)) : null);
            map.wishlist = list(data && data.rgWishlist);
            map.owned = list(data && data.rgOwnedApps);
            map.creatorsIgnored = list(data && data.rgCreatorsIgnored);
            map.creatorsFollowed = list(data && data.rgCreatorsFollowed);
            return map;
        } catch (e) {
            return null;
        }
    }

    // Live login check: /account/ redirects to the login page without a session
    // (steamLoginSecure is HttpOnly and cannot be read). null when the request
    // itself failed.
    const ACCOUNT_URL = 'https://store.steampowered.com/account/';
    async function probeLogin() {
        try {
            const res = await fetchWithTimeout(ACCOUNT_URL, { credentials: 'include', cache: 'no-store' });
            if (!res.ok) return null;
            return !res.url.includes('/login');
        } catch (e) { return null; }
    }

    // The probe behind one cache, for the hot ignore-side gates (the rate gate,
    // once per POST; the Manual-Ignore gestures). Whatever needs a fresh answer
    // (the widget lock, the drainer's dead-session check) calls probeLogin.
    //  - a confirmed session is reused for OK_TTL: it changes only on sign-out;
    //  - a confirmed sign-out for NEG_TTL, so a page opened before signing in
    //    elsewhere recovers on the next gesture;
    //  - a failed probe is never cached.
    // Concurrent callers share the in-flight request. In memory, per world.
    const LOGIN_OK_TTL_MS = 60000;
    const LOGIN_NEG_TTL_MS = 10000;
    let loginVerdict = null;    // { ok: boolean, at: epoch-ms }
    let loginInFlight = null;
    async function probeLoginCached() {
        const now = Date.now();
        if (loginVerdict) {
            const ttl = loginVerdict.ok ? LOGIN_OK_TTL_MS : LOGIN_NEG_TTL_MS;
            if (now - loginVerdict.at < ttl) return loginVerdict.ok;
        }
        // probeLogin never rejects, so the latch cannot be stranded.
        if (!loginInFlight) {
            loginInFlight = probeLogin().then((v) => { loginInFlight = null; return v; });
        }
        const verdict = await loginInFlight;
        if (verdict !== null) loginVerdict = { ok: verdict, at: Date.now() };
        return verdict;
    }

    // Does this appid have no store object in the account's region? The ignore
    // endpoint answers such an appid with a permanent 400, and that correlates
    // 1:1 with appdetails `success:false` (verified). true only on that evidence;
    // false/null leave the caller on its systemic-failure path. No cc override:
    // the session's own region must decide. `credentials` matters in the SW,
    // where the request is cross-origin.
    const APPDETAILS_URL = 'https://store.steampowered.com/api/appdetails';
    async function checkAppUnavailable(appid) {
        try {
            const res = await fetchWithTimeout(`${APPDETAILS_URL}?appids=${appid}`, {
                credentials: 'include'
            });
            if (!res.ok) return null;
            const data = await res.json();
            const entry = data && data[appid];
            return entry ? entry.success !== true : null;
        } catch (e) { return null; }
    }

    // A game's localized name from appdetails, sanitized, or null. The last
    // resort of name resolution (src/game-name.js).
    async function fetchAppName(appid) {
        try {
            const res = await fetchWithTimeout(`${APPDETAILS_URL}?appids=${appid}&filters=basic`);
            if (!res.ok) return null;
            const data = await res.json();
            const entry = data && data[appid];
            const name = entry && entry.success && entry.data && entry.data.name;
            return name ? window.ILAP.Sanitizer.sanitizeName(name) : null;
        } catch (e) { return null; }
    }

    // One item of the store's anonymous lookup (a bundle's apps, a game's
    // creators), or null. `id` is one GetItems id ({ appid }, { bundleid },
    // { packageid }). No key or token, and it answers the store origin's CORS, so
    // a content script can ask it. The caller paces it (IgnoreGate.paceRead).
    const GET_ITEMS = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=';
    async function fetchStoreItem(id, context, dataRequest) {
        const input = { ids: [id], context, data_request: dataRequest };
        try {
            const res = await fetchWithTimeout(GET_ITEMS + encodeURIComponent(JSON.stringify(input)));
            if (!res.ok) return null;
            const data = await res.json();
            const items = data && data.response && data.response.store_items;
            return Array.isArray(items) && items[0] ? items[0] : null;
        } catch (e) { return null; }
    }

    // Marks a refused POST `unavailable` when the refusal is the permanent
    // per-appid kind, so the drainer skips it in one attempt instead of spending
    // MAX_FAILS, and the SW's halt counter never sees it. Only for HTTP 400: that
    // is what the correlation was established for, and a timeout or 5xx must stay
    // a systemic failure. Each world wraps its own POST; the SW before its halt
    // counter.
    async function classifyRefusal(appid, res) {
        if (res.status === 400 && (await checkAppUnavailable(appid)) === true) {
            res.unavailable = true;
        }
        return res;
    }

    // What either world's ignore POST resolves to:
    //   { ok, rateLimited, retryAfterMs, status } — see post() in utils.js.
    const IGNORE_URL = 'https://store.steampowered.com/recommended/ignorerecommendation/';
    // The form fields of an ignore and of its rollback, less the sessionid each
    // world adds. The rollback is sent the way Steam's own notinterested page does.
    const ignoreFields = (appid, reason) => ({ appid, snr: '', ignore_reason: reason });
    const unignoreFields = (appid) => ({ appid, snr: '1_account_notinterested_', remove: '1' });
    // A POST that got no answer (no sessionid, network error, timeout). A fresh
    // object each time: classifyRefusal marks the one it gets.
    const ignoreFailed = () => ({ ok: false, rateLimited: false, retryAfterMs: 0, status: 0 });
    // An answered POST. A 429 throttles the account; a Retry-After in seconds
    // becomes retryAfterMs, an HTTP-date one 0, and the gate's backoff decides.
    function ignoreResult(response) {
        if (response.status === 429) {
            const ra = parseInt(response.headers.get('Retry-After'), 10);
            return { ok: false, rateLimited: true, retryAfterMs: ra > 0 ? ra * 1000 : 0, status: 429 };
        }
        return { ok: response.ok, rateLimited: false, retryAfterMs: 0, status: response.status };
    }

    // Steam's own "Ignore this creator" (developer, publisher or franchise),
    // the call its creator pages make: one clan id, `ignore` 1 or 0. It stops
    // Steam recommending the creator's games and leaves the games themselves
    // as they are. Steam answers JSON; its own page counts any 200 as done.
    const CREATOR_IGNORE_URL = 'https://store.steampowered.com/curators/ajaxignore';
    const creatorFields = (clanid, ignore) => ({ clanid, ignore: ignore ? '1' : '0' });
    // The same shape as ignoreResult. A 200 whose JSON does not say success, or
    // a 4xx other than 429, is Steam refusing this one creator (followed, the
    // 100-creator limit, a limited account): `refused`, which the caller turns
    // into a drop once the session is known to be live. Measured live, Steam
    // answers those three with a 400 and `success` 2, and a signed-out POST with
    // a 400 and `success` 8, which is why the session is checked first.
    async function creatorResult(response) {
        const res = ignoreResult(response);
        if (res.rateLimited) return res;
        if (!response.ok) {
            res.refused = response.status >= 400 && response.status < 500;
            return res;
        }
        let data = null;
        try { data = await response.json(); } catch (e) { /* not JSON: refused */ }
        const s = data && data.success;
        const code = s && typeof s === 'object' ? s.success : s;
        if (code !== 1) return { ok: false, rateLimited: false, retryAfterMs: 0, status: response.status, refused: true };
        return res;
    }

    window.ILAP = window.ILAP || {};
    window.ILAP.SteamNet = window.ILAP.SteamNet || {};
    window.ILAP.SteamNet.CREATOR_IGNORE_URL = CREATOR_IGNORE_URL;
    window.ILAP.SteamNet.creatorFields = creatorFields;
    window.ILAP.SteamNet.creatorResult = creatorResult;
    window.ILAP.SteamNet.IGNORE_URL = IGNORE_URL;
    window.ILAP.SteamNet.ignoreFields = ignoreFields;
    window.ILAP.SteamNet.unignoreFields = unignoreFields;
    window.ILAP.SteamNet.ignoreFailed = ignoreFailed;
    window.ILAP.SteamNet.ignoreResult = ignoreResult;
    window.ILAP.SteamNet.fetchWithTimeout = fetchWithTimeout;
    window.ILAP.SteamNet.fetchIgnoredAppsStrict = fetchIgnoredAppsStrict;
    window.ILAP.SteamNet.USERDATA_LAG_MS = USERDATA_LAG_MS;
    window.ILAP.SteamNet.probeLogin = probeLogin;
    window.ILAP.SteamNet.probeLoginCached = probeLoginCached;
    window.ILAP.SteamNet.checkAppUnavailable = checkAppUnavailable;
    window.ILAP.SteamNet.fetchAppName = fetchAppName;
    window.ILAP.SteamNet.fetchStoreItem = fetchStoreItem;
    window.ILAP.SteamNet.classifyRefusal = classifyRefusal;

})();
