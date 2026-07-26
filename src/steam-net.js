// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The read-side Steam network layer, exposed as window.ILAP.SteamNet and
    // shared by the TWO worlds that actually talk to Steam: the content script
    // (loaded from content_scripts, right after escape.js and before utils.js)
    // and the MV3 service worker (first files of background.js's importScripts).
    // popup.html never fetches Steam, so the "the popup deliberately does not
    // load utils.js" argument behind the knowingly-duplicated storage plumbing
    // (canonical note in src/curator/store.js) does not apply to any of this —
    // these four functions were byte-identical (or one flag apart) in two files.
    //
    // What stays duplicated per world ON PURPOSE: the ignore/unignore POST. The
    // worlds genuinely diverge there — sessionid from the cookie vs the
    // ilap_sw_sid cache, cross-origin credentials in the SW, the SW's halt
    // counter wrapper — and a shared factory with three injection points on the
    // most dangerous path in the extension would let one bug in the abstraction
    // break both worlds at once.

    // Every Steam fetch gets a hard deadline: a hung request (server not
    // answering, half-dead connection) must fail like a network error rather
    // than hold its caller forever — most critically the curator drainer, whose
    // `draining` latch a hung ignore POST would otherwise wedge until reload
    // (the lease would expire and hand off to another tab, but THIS tab would
    // never drain again). Callers already treat a throw as failure, and an
    // abort throws, so no call site needs extra handling.
    const FETCH_TIMEOUT_MS = 10000;
    function fetchWithTimeout(url, options, timeoutMs) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs || FETCH_TIMEOUT_MS);
        // The timer is deliberately NOT cleared when fetch() resolves: fetch()
        // resolves at HEADERS, while body reads (res.json()) run afterwards
        // under the same signal — a server that sends headers then stalls the
        // body must hit the same deadline. Once the body has been consumed the
        // late abort() is a no-op (at worst it cancels an unread body).
        return fetch(url, Object.assign({}, options, { signal: ctl.signal }))
            .catch(err => { clearTimeout(timer); throw err; });
    }

    // Authoritative ignore-state source: Steam's own dynamic store. Read-only
    // GET (NOT an ignore API call); rgIgnoredApps is the map of every ignored
    // appid. Strict: null on any failure (network/parse/non-ok/timeout), for
    // callers whose SKIP direction inverts on this data — the undo drainer
    // treats "appid not in the set" as "already rolled back", so a failure must
    // be distinguishable from a real empty set or a dead job burns to
    // completion. The lenient flavour (empty Set on failure) is caller policy
    // and lives with its callers, in utils.js.
    const USERDATA_URL = 'https://store.steampowered.com/dynamicstore/userdata/';
    async function fetchIgnoredAppsStrict() {
        try {
            const res = await fetchWithTimeout(`${USERDATA_URL}?_=${Date.now()}`, {
                credentials: 'include', cache: 'no-store'
            });
            if (!res.ok) return null;
            const data = await res.json();
            const ignored = data && data.rgIgnoredApps;
            return new Set(ignored ? Object.keys(ignored).map(String) : []);
        } catch (e) {
            return null;
        }
    }

    // Live login check against the CURRENT cookies (a read, not an ignore
    // call): /account/ redirects to the login page when the session cookies are
    // absent (steamLoginSecure is HttpOnly, so the cookie can't be read
    // directly). null when the request itself failed (offline) — the caller
    // keeps the current state. The DOM half of the login gate (the store
    // header, and the policy that picks between the two) is DOM-bound and
    // stays in utils.js SteamAuth.
    const ACCOUNT_URL = 'https://store.steampowered.com/account/';
    async function probeLogin() {
        try {
            const res = await fetchWithTimeout(ACCOUNT_URL, { credentials: 'include', cache: 'no-store' });
            if (!res.ok) return null;
            return !res.url.includes('/login');
        } catch (e) { return null; }
    }

    // 400-classifier for the curator drainer: the ignore endpoint answers a
    // permanent 400 for an appid with no purchasable store object in the
    // account's region (CDPR titles in RU, Spacewar anywhere) — verified to
    // correlate 1:1 with appdetails `success:false`. Resolves true only on
    // that positive evidence; false/null (available / probe failed) keep the
    // caller on its systemic-failure path. No cc override and no filters
    // param: the session's own region must decide, exactly like the probe
    // that established the correlation. Called at most once per FAILED post,
    // so the endpoint's aggressive rate limit is not a concern.
    // credentials:'include' is load-bearing in the SW only — cross-origin
    // there, and the account cookies are what pin the response to the
    // account's region; for the tab's same-origin fetch it is a no-op, which
    // is what lets both worlds share this one copy.
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

    // The verdict wrapper both drain hosts apply to a REFUSED ignore/unignore
    // POST: mark the result `unavailable` when the refusal is the permanent
    // per-appid kind, so the drainer steps over the appid in ONE attempt
    // instead of burning MAX_FAILS retries (and, in the worker, instead of
    // charging the halt counter that kills the whole SW route). Gated strictly
    // on HTTP 400 — the region-lock ⇔ success:false correlation was established
    // for 400, so a timeout / 5xx / dead-network refusal (status 0) stays on
    // the systemic path; otherwise a transient failure coinciding with a
    // sporadic appdetails success:false would falsely skip a live appid in one
    // attempt. A failed or negative probe leaves the result unmarked.
    //
    // Shared rather than per-world because nothing in it is world-bound: no
    // session id, no credentials, no halt counter — just policy over the one
    // shared probe above. What stays per-world is WHERE it wraps (each world's
    // own POST) and WHEN — the SW must classify BEFORE its halt counter sees
    // the result, or two region-locked titles in a row would halt the route.
    async function classifyRefusal(appid, res) {
        if (res.status === 400 && (await checkAppUnavailable(appid)) === true) {
            res.unavailable = true;
        }
        return res;
    }

    window.ILAP = window.ILAP || {};
    window.ILAP.SteamNet = window.ILAP.SteamNet || {};
    window.ILAP.SteamNet.fetchWithTimeout = fetchWithTimeout;
    window.ILAP.SteamNet.fetchIgnoredAppsStrict = fetchIgnoredAppsStrict;
    window.ILAP.SteamNet.probeLogin = probeLogin;
    window.ILAP.SteamNet.checkAppUnavailable = checkAppUnavailable;
    window.ILAP.SteamNet.classifyRefusal = classifyRefusal;

})();
