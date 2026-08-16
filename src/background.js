// SPDX-License-Identifier: GPL-3.0-or-later
//
// MV3 service-worker entry (Chromium only — Firefox's event page loads just
// migrate.js; the no-permission SW fetch behavior is unverified there, so the
// content-script drainer remains the Firefox path). Two jobs:
//
//  1. the install/update surface migration (migrate.js);
//  2. the Phase-3 SW drain: run the curator queue with NO Steam tab open.
//
// The ignore POST needs no page context and no extra permissions — only the
// Steam_Language cookie, which any Steam visit sets. What the SW genuinely
// lacks is document.cookie, so the sessionid is cached into storage by the
// content script at page boot (ilap_sw_sid) and read from there. The queue,
// cursor and lease already live in chrome.storage.local, so this worker joins
// the existing lease/handoff protocol as just another drainer: whoever
// (tab or SW) takes a job's lease first drains it, everyone else stands by.
//
// MV3 lifetime notes: every chrome.* call during an active drain resets the
// ~30 s idle timer, so a drain pass survives on its own. What does NOT survive
// is a long in-memory sleep (a 429 penalty reaches minutes) or a dead standby
// interval — both are replaced with one chrome.alarms alarm: the gate wrapper
// refuses waits longer than the worker's lifetime, and syncAlarm() re-arms the
// retry alarm whenever drainable work remains.

// The shared modules are content-script IIFEs bound to `window`.
self.window = self;

importScripts(
    'escape.js',
    'stats.js',
    'steam-net.js',
    'migrate.js',
    'gate.js',
    'ignore-log.js',
    'curator/store.js',
    'curator/drainer.js'
);

(function () {
    'use strict';

    const ILAP = self.ILAP;
    const Store = ILAP.Curator.Store;
    const Gate = ILAP.IgnoreGate;
    const Log = ILAP.IgnoreLog;
    const Net = ILAP.SteamNet;   // the Steam reads this worker shares with the tab

    const SID_KEY = 'ilap_sw_sid';    // sessionid cached by the content script
    const HALT_KEY = 'ilap_sw_halt';  // SW route halted until a store-page visit
    const ALARM = 'ilap_sw_drain';
    const ALARM_RETRY_MS = 60000;     // standby re-check (chrome.alarms floor is 30 s)
    const MAX_WAIT_MS = 20000;        // a reserve() wait beyond this outlives the SW
    const HALT_AFTER = 2;             // consecutive failed POSTs before halting

    // Deliberately duplicated shim — see the world-isolation note in
    // src/curator/store.js (the SW is a third world, with no DOM at all).
    const get = (q) => new Promise(r => chrome.storage.local.get(q, r));
    const set = (o) => new Promise(r => chrome.storage.local.set(o, r));

    // --- cached sessionid --------------------------------------------------
    // The sessionid the content script cached for us: under a storage-only
    // permission set this worker cannot read document.cookie. Mirrored into
    // memory (loaded at boot, tracked via onChanged) because the POST below
    // needs it synchronously as its CSRF field.
    let cachedSid = null;

    // …and the same cache answers the rate gate's one session question, folded
    // with the live probe the tab's SteamAuth would have run. Injected rather
    // than discovered: gate.js used to walk a ladder of facade names to work out
    // which world it was in, and this file satisfied it by ASSIGNING
    // `ILAP.getSessionID` — faking a facade of a module it cannot see into.
    // No sid cached yet → 'no-session' stop, exactly right; a sid that Steam no
    // longer honours → the probe says so, and the pass stops instead of burning
    // the queue on POSTs that can only 400.
    Gate.configure({
        hasSession: () => cachedSid ? Net.probeLoginCached() : false
    });

    // --- Steam API from the SW ---------------------------------------------
    // The READS (deadline wrapper, userdata, login probe, appdetails
    // classifier) come from the shared steam-net.js — the tab and this worker
    // are the only worlds that talk to Steam. Only the ignore POST below is
    // deliberately this world's own: the sessionid comes from the storage
    // cache rather than the cookie, and it carries the halt counter.

    // A cached sessionid can go stale with no store tab around to refresh it
    // (re-login elsewhere): every POST then fails, and the drainer's MAX_FAILS
    // skip would burn appids one by one. HALT_AFTER consecutive failures
    // (strictly below MAX_FAILS, so the halt engages before the first skip)
    // set the halt flag; the gate wrapper then refuses every slot until a
    // store-page visit re-caches the sid and clears the flag (drainer boot).
    // 429s don't count — that's account throttling, handled by the gate.
    // Two accepted asymmetries: network errors (timeout, offline) count too,
    // so a transient outage halts the route until the next store visit —
    // fails-closed by design; and the whole mechanism assumes Steam answers
    // non-ok for a rejected POST (verified: bad sessionid → 400).
    // A classified per-appid refusal (res.unavailable — region-locked appid,
    // marked by SteamNet.classifyRefusal, which the api wrappers below apply
    // BEFORE this counter sees the result) is neutral: it neither counts toward the halt
    // (two adjacent region-locked titles in one list must not kill the whole
    // SW route) nor resets the counter (it proves nothing about the sid).
    let consecFails = 0;
    function trackFails(res) {
        if (res.ok) {
            consecFails = 0;
        } else if (!res.rateLimited && !res.unavailable) {
            consecFails += 1;
            if (consecFails >= HALT_AFTER) set({ [HALT_KEY]: true });
        }
        return res;
    }

    const IGNORE_URL = 'https://store.steampowered.com/recommended/ignorerecommendation/';
    async function post(fields) {
        try {
            const response = await Net.fetchWithTimeout(IGNORE_URL, {
                method: 'POST',
                // Load-bearing, unlike in utils.js SteamAPI (where the fetch is
                // same-origin): from the SW this POST is CROSS-origin
                // (chrome-extension:// → steampowered.com) and the default
                // 'same-origin' mode attaches ZERO cookies — Steam then 400s
                // every POST (no sessionid CSRF pair, no Steam_Language). Every
                // probe that validated the SW route carried this flag.
                credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                body: new URLSearchParams(fields).toString()
            });
            if (response.status === 429) {
                const ra = parseInt(response.headers.get('Retry-After'), 10);
                return { ok: false, rateLimited: true, retryAfterMs: ra > 0 ? ra * 1000 : 0, status: 429 };
            }
            return { ok: response.ok, rateLimited: false, retryAfterMs: 0, status: response.status };
        } catch (e) { return { ok: false, rateLimited: false, retryAfterMs: 0, status: 0 }; }
    }

    // 400-classification wraps THIS world's POST with the shared rule from
    // steam-net.js (the tab's drainer wraps its own the same way). The ordering
    // is what's specific here: it runs BEFORE trackFails, so a region-locked
    // appid never charges the halt counter — two such titles in a row would
    // otherwise kill the whole SW route.
    async function apiIgnore(appid, reason) {
        if (!cachedSid) return { ok: false, rateLimited: false, retryAfterMs: 0, status: 0 };
        return trackFails(await Net.classifyRefusal(appid, await post({
            sessionid: cachedSid, appid, snr: '', ignore_reason: reason
        })));
    }
    async function apiUnignore(appid) {
        if (!cachedSid) return { ok: false, rateLimited: false, retryAfterMs: 0, status: 0 };
        return trackFails(await Net.classifyRefusal(appid, await post({
            sessionid: cachedSid, appid, snr: '1_account_notinterested_', remove: '1'
        })));
    }

    // Last-Ignored stats for drained MI jobs. Only the chrome.storage
    // read-modify-write is this world's own (the same world-isolation decision
    // as the storage shim above); everything that CAN be shared is: the record's
    // shape and cap come from stats.js, the name normalizer from escape.js and
    // the reason→label map from the queue store, all three loaded by this
    // worker. Serialized so overlapping saves can't lose a count.
    const Stats = ILAP.StatsLogic;
    let statsChain = Promise.resolve();
    function saveStats(name, reason) {
        const source = Store.miSourceLabel(reason);
        const safe = ILAP.Sanitizer.sanitizeName(name);
        statsChain = statsChain.then(() => new Promise((resolve) => {
            chrome.storage.local.get([Stats.HISTORY_KEY, Stats.COUNT_KEY], (r) => {
                chrome.storage.local.set(Stats.nextState(r, safe, source), resolve);
            });
        })).catch(() => {});
        return statsChain;
    }

    // A drained curator ignore counts into the total but stays out of the
    // history (StatsLogic.countState); a confirmed rollback takes it back out
    // (uncountState) and leaves the history alone just the same. Same chain as
    // saveStats — all three move the same key, and a second chain would lose a
    // step when they overlap.
    function countOnly(transform) {
        statsChain = statsChain.then(() => new Promise((resolve) => {
            chrome.storage.local.get([Stats.COUNT_KEY], (r) => {
                chrome.storage.local.set(transform(r), resolve);
            });
        })).catch(() => {});
        return statsChain;
    }
    const bumpCount = () => countOnly(Stats.countState);
    const dropCount = () => countOnly(Stats.uncountState);

    // --- gate wrapper ------------------------------------------------------
    // Gate.reserve() sleeps in memory until the granted slot; a wait longer
    // than the worker's idle lifetime (429 penalties reach minutes) would die
    // mid-sleep. Pre-check the expected wait WITHOUT claiming a slot: too far →
    // stop the pass and let syncAlarm resume it at the penalty's end. Also the
    // halt flag's enforcement point (before any slot is claimed or burned).
    //
    // Accepted residual: the pre-check is not atomic with the claim. A 429 from
    // another source landing in between means reserve() grants a slot further
    // out than MAX_WAIT_MS and sleeps through the worker's death — that slot is
    // burned with no POST. Self-healing (the retry alarm reopens the pass at
    // the penalty's end) and rare enough not to be worth a second round trip.
    async function swReserve() {
        const d = await get({ [HALT_KEY]: false, [Gate.GATE_KEY]: 0, [Gate.PENALTY_KEY]: null });
        if (d[HALT_KEY]) return { ok: false, reason: 'halted' };
        const now = Date.now();
        const slot = Math.max(
            Gate.nextSlot(d[Gate.GATE_KEY], now, Gate.MIN_GAP),
            Gate.penaltyUntil(d[Gate.PENALTY_KEY], now)
        );
        if (slot - now > MAX_WAIT_MS) return { ok: false, reason: 'backoff' };
        return Gate.reserve();
    }

    // --- the drainer -------------------------------------------------------

    const drainer = new ILAP.Curator.CuratorQueueDrainer({
        store: Store,
        api: { ignore: apiIgnore, unignore: apiUnignore },
        gate: {
            reserve: swReserve,
            reportRateLimited: (ms) => Gate.reportRateLimited(ms),
            stopped: () => Gate.stopVerdict()
        },
        fetchUserdata: Net.fetchIgnoredAppsStrict,
        probeLogin: Net.probeLogin,
        saveStats,
        bumpCount,
        dropCount,
        log: Log ? {
            append: (entry) => Log.append(entry),
            markUndone: (appid, ts) => Log.markUndone(appid, ts),
            lastIgnoredAt: async (appid) =>
                Log.lastIgnoredAt(await Log.getLog(), appid),
            wasReIgnoredAfter: async (appid, ts) =>
                Log.reIgnoredAfter(await Log.getLog(), appid, ts)
        } : null,
        // newOwnerId lives in utils.js (not loaded here) — same shape inline.
        ownerId: 'sw_' + Math.random().toString(36).slice(2) + Date.now().toString(36),
        standbyMs: 0   // no in-memory standby tick; the alarm below is the retry
    });

    // Re-arm (or clear) the one retry alarm after every pass: drainable work
    // left behind — because the lease was taken, the gate stopped the pass, or
    // a 429 penalty landed — must eventually be re-checked even if this worker
    // dies right now. The alarm doubles as the orphaned-lease reaper (a closed
    // tab's lease expires and the next firing steals the job).
    async function syncAlarm() {
        const queue = await Store.getQueue();
        const d = await get({ [HALT_KEY]: false, [Gate.PENALTY_KEY]: null });
        // While halted there is no alarm at all: every firing would only wake
        // the worker to be refused by the gate. The recovery write (a store-page
        // visit clears the flag) arrives as an onChanged kick, which re-arms.
        if (d[HALT_KEY] || !(await drainer.hasDrainableWork(queue))) {
            chrome.alarms.clear(ALARM);
            return;
        }
        // A master-off stop is the same situation for the same reason: nothing
        // to do until the toggle comes back, and that IS a storage write
        // (ilap_master_enabled) sitting in the onChanged filter below. Asked
        // only once there IS work, so an idle profile pays no login probe per
        // pass.
        //
        // Every OTHER stop keeps the alarm, because none of them is guaranteed
        // to END with a write this worker hears. 'offline' plainly isn't one —
        // nothing writes storage when a connection comes back, and parking on a
        // 10-second blip would strand the drain until a store tab happened to
        // open, the one situation this worker exists to cover. Neither is
        // 'no-session': the verdict is a live probe now, not "is a sessionid
        // cached", so a sign-in that reuses the same sessionid never reaches the
        // change-only ilap_sw_sid write (curator/drainer.js) and no kick
        // arrives. The price of covering both is one login probe per
        // ALARM_RETRY_MS for as long as work sits queued.
        if ((await Gate.stopVerdict()) === 'disabled') {
            chrome.alarms.clear(ALARM);
            return;
        }
        const now = Date.now();
        const when = Math.max(now + ALARM_RETRY_MS, Gate.penaltyUntil(d[Gate.PENALTY_KEY], now));
        chrome.alarms.create(ALARM, { when });
    }

    function kick() {
        // The halt check sits BEFORE drain(): _drainJob fetches userdata first
        // thing, so a halted route would otherwise still hit the network on
        // every wake for a pass the gate is guaranteed to refuse.
        get({ [HALT_KEY]: false })
            .then((d) => d[HALT_KEY] ? null : drainer.drain().catch(() => {}))
            .then(syncAlarm);
    }

    // Listeners registered synchronously in the first turn, so Chrome re-spawns
    // this worker for them. Not drainer.start(): its onChanged registration
    // would be redundant with this one, and its standby interval is disabled.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[SID_KEY]) {
            cachedSid = changes[SID_KEY].newValue || null;
            consecFails = 0;
        }
        const touched = changes.ilap_curator_queue
            || changes.ilap_master_enabled
            || changes[SID_KEY]
            || changes[HALT_KEY]
            || Object.keys(changes).some(k => k.indexOf('ilap_curator_lock_') === 0);
        if (touched) kick();
    });
    chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) kick(); });

    // Boot pass (covers the wake itself, whatever caused it). The sid cache
    // must be in memory first — the gate reads it synchronously.
    get({ [SID_KEY]: null }).then((d) => {
        cachedSid = d[SID_KEY] || null;
        kick();
    });
})();
