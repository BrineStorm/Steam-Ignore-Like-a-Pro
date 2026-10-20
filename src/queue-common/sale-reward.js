// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The Discovery Queue sale reward: the stickers a Steam sale hands out for
    // going through a queue. Steam's Subscriber Agreement (4.C) rules out
    // earning rewards or progress without genuine user input, so the queue
    // automators ask here before they advance a queue on their own, and while
    // the reward is still unearned, advancing stays the user's.
    //
    // Read the way Steam's own end-of-queue card reads it (verified live): the
    // sale window from GetCurrentDefinition, which needs no token, and the
    // account's progress from GetClaimedSaleRewards, which needs the page's
    // webapi token. One finished queue grants every item of the definition at
    // once, the Classic Discovery Queue included.
    //
    // Asked only when an automator is about to advance a queue itself: a DQ
    // Start and every advance of the DQ loop after it, or a Classic Discovery
    // Queue advance after an ignore — never on a page load, and never by the
    // curator drain.
    //
    // check() resolves to one of:
    //   'allowed' — no sale reward is running, or this account has earned it;
    //   'pending' — a reward is running and not yet earned;
    //   'unknown' — whether a reward is running, or its status, could not be read.
    // Callers refuse on anything but 'allowed'. check({ fresh: true }) is for a
    // Start the user clicked: it does not reuse a cached "no sale" either, so a
    // run never starts on an answer from before a sale began. A click is the
    // only throttle it needs.

    window.ILAP = window.ILAP || {};

    const STATUS = Object.freeze({ ALLOWED: 'allowed', PENDING: 'pending', UNKNOWN: 'unknown' });

    const API = 'https://api.steampowered.com/ISaleItemRewardsService/';
    // The Discovery Queue reward, as Steam's own page asks for it.
    const DEF_TYPE = 2;

    // The last answer, for every tab: { status, until, account } (`until` in
    // epoch ms). Only the two answers that let an automated run go on are
    // reused, inside `until`, so one advance per game costs nothing:
    //   'done' — until the sale ends: nothing can un-earn the reward. One
    //            account's progress, so reused only for that account: signing
    //            into another one in the same browser asks again;
    //   'none' — no reward running: a minute, or until one is due to start. A
    //            sale can begin inside it, so it is short: an automated run goes
    //            at most that long into a new sale on an old answer.
    // 'pending' and 'unknown' are written (they replace a stale 'none') but never
    // reused: they are asked again only at a human pace — a refused Start is
    // clicked again, a locked Classic Discovery Queue moves when the user presses
    // Next, the Discovery Queue loop stops at its first refusal — so a queue just
    // finished by hand counts at the next check and a retry is a real retry.
    const CACHE_KEY = 'ilap_sale_reward';
    const TTL = Object.freeze({ none: 60000, pending: 0, unknown: 0 });
    // A record further out than any sale lasts is corruption, not an answer.
    const MAX_AHEAD = 31 * 86400000;
    // Per request: two run back to back before a Start can answer.
    const CALL_TIMEOUT_MS = 5000;
    const VERDICT = Object.freeze({
        done: STATUS.ALLOWED, none: STATUS.ALLOWED, pending: STATUS.PENDING, unknown: STATUS.UNKNOWN,
    });

    // A count or a time from Steam's answer: a number, or one sent as a numeric
    // string; anything else (null, a missing field, '') is NaN, never 0, so a
    // field gone missing cannot read as "no sale" or "nothing to earn".
    const num = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);

    // Storage shim, duplicated per world on purpose (see src/curator/store.js).
    const get = (query) => new Promise(r => chrome.storage.local.get(query, r));
    const set = (obj) => new Promise(r => chrome.storage.local.set(obj, r));

    // The method's `response` object, or null on any failure. The token rides
    // in the query string, as on Steam's own requests, and goes nowhere else.
    async function call(method, input, token) {
        const url = API + method + '/v1/?' + (token ? 'access_token=' + encodeURIComponent(token) + '&' : '')
            + 'input_json=' + encodeURIComponent(JSON.stringify(input));
        try {
            const res = await window.ILAP.SteamNet.fetchWithTimeout(url, {}, CALL_TIMEOUT_MS);
            if (!res.ok) return null;
            const data = await res.json();
            return (data && data.response) || null;
        } catch (e) {
            return null;
        }
    }

    // The signed-in user's webapi token, from the store page's own config; null
    // when there is none (a signed-out page) or the config is not where it was.
    function readToken() {
        const el = document.getElementById('application_config');
        try {
            const cfg = JSON.parse(el.dataset.store_user_config);
            return typeof cfg.webapi_token === 'string' && cfg.webapi_token ? cfg.webapi_token : null;
        } catch (e) {
            return null;
        }
    }

    // Whose token it is: the SteamID in the `sub` claim of the token's JWT;
    // null when it cannot be read, and then no account-bound answer is reused.
    function readAccount(token) {
        try {
            const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const sub = JSON.parse(atob(part)).sub;
            return typeof sub === 'string' && sub ? sub : null;
        } catch (e) {
            return null;
        }
    }

    // Ask Steam. Resolves the record to cache: { status, until } (run() adds
    // whose it is).
    async function ask(now, token) {
        const brief = (status) => ({ status, until: now + TTL[status] });
        const current = await call('GetCurrentDefinition', { sale_def_type: DEF_TYPE, language: 'english' });
        if (!current) return brief('unknown');
        // No sale reward running is an empty answer: what Steam serves for a
        // reward type with no current definition (seen live). Anything else
        // without a definition is a shape we do not know, and a renamed field
        // must not unlock.
        const def = current.definition;
        if (!def) return brief(Object.keys(current).length === 0 ? 'none' : 'unknown');
        // A window we cannot read is 'unknown', not "no sale": a renamed field
        // must not unlock.
        const start = num(def.rtime_start_time) * 1000, end = num(def.rtime_end_time) * 1000;
        if (!Number.isFinite(start) || !Number.isFinite(end)) return brief('unknown');
        if (now >= end) return brief('none');
        if (now < start) return { status: 'none', until: Math.min(start, now + TTL.none) };

        const need = num(def.num_items_per_def);
        if (!(need > 0)) return brief('unknown');
        if (!token) return brief('unknown');
        const claimed = await call('GetClaimedSaleRewards',
            { sale_def_type: DEF_TYPE, language: 'english', include_community_item_def: false }, token);
        if (!claimed) return brief('unknown');
        // A count of zero may be left out of the answer.
        const earned = claimed.num_items_earned === undefined ? 0 : num(claimed.num_items_earned);
        if (!Number.isFinite(earned)) return brief('unknown');
        if (earned < need) return brief('pending');
        return { status: 'done', until: end };
    }

    async function run(fresh) {
        const now = Date.now();
        const token = readToken();
        const account = token && readAccount(token);
        const cached = (await get({ [CACHE_KEY]: null }))[CACHE_KEY];
        const reusable = cached && Number.isFinite(cached.until)
            && now < cached.until && cached.until <= now + MAX_AHEAD
            && ((cached.status === 'done' && account && cached.account === account)
                || (cached.status === 'none' && !fresh));
        if (reusable) return VERDICT[cached.status];
        const record = Object.assign(await ask(now, token), { account: account || null });
        await set({ [CACHE_KEY]: record });
        return VERDICT[record.status];
    }

    // Checks made while one is in flight in this tab share its answer. A fresh
    // one runs on its own: the one in flight may be answered from the cache.
    let inFlight = null;
    function check(opts) {
        if (opts && opts.fresh) return run(true);
        if (!inFlight) inFlight = run(false).finally(() => { inFlight = null; });
        return inFlight;
    }

    window.ILAP.SaleReward = Object.freeze({ check, STATUS, CACHE_KEY, TTL });
})();
