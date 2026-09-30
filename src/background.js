// SPDX-License-Identifier: GPL-3.0-or-later
//
// MV3 service worker, Chromium only (Firefox's event page loads migrate.js
// alone and drains from content scripts). Two jobs:
//
//  1. the install/update surface migration (migrate.js);
//  2. draining the curator queue with no Steam tab open.
//
// The ignore POST needs only the Steam_Language cookie, not a page. What the
// worker lacks is document.cookie, so the page caches the sessionid for it
// (src/sw-handoff.js). The queue, cursor and lease live in storage, so the
// worker joins the lease/handoff protocol as one more drainer.
//
// Lifetime: chrome.* calls during a drain keep the worker alive, but a long
// in-memory sleep (a 429 penalty) or a standby interval would not survive it,
// so both are replaced by one chrome.alarms alarm.

// The shared modules are content-script IIFEs bound to `window`.
self.window = self;

importScripts(
    'escape.js',
    'settings-schema.js',
    'stats.js',
    'steam-net.js',
    'migrate.js',
    'gate.js',
    'ignore-log.js',
    'curator/lease.js',
    'curator/store.js',
    'curator/drainer.js'
);

(function () {
    'use strict';

    const ILAP = self.ILAP;
    const Store = ILAP.Curator.Store;
    const Lease = ILAP.Curator.Lease;
    const Gate = ILAP.IgnoreGate;
    const Log = ILAP.IgnoreLog;
    const Net = ILAP.SteamNet;   // the Steam reads this worker shares with the tab

    const SID_KEY = Store.SW_SID_KEY;     // sessionid cached by the content script
    const HALT_KEY = Store.SW_HALT_KEY;   // SW route halted (a store-page visit or the hourly retry clears it)
    const ALARM = 'ilap_sw_drain';
    const ALARM_RETRY_MS = 60000;     // standby re-check (chrome.alarms floor is 30 s)
    // A halted route's own re-check. Far rarer than the standby one: the halt
    // usually means a sessionid no page has refreshed, and probing that costs
    // real POSTs. It exists for the case the halt CANNOT tell apart from that —
    // see the alarm handler.
    const HALT_RETRY_MS = 3600000;    // 1 h
    const MAX_WAIT_MS = 20000;        // a reserve() wait beyond this outlives the SW
    const HALT_AFTER = 2;             // consecutive failed POSTs before halting

    // Storage shim, duplicated per world on purpose (see src/curator/store.js).
    const get = (q) => new Promise(r => chrome.storage.local.get(q, r));
    const set = (o) => new Promise(r => chrome.storage.local.set(o, r));

    // --- cached sessionid --------------------------------------------------
    // Mirrored into memory (boot read + onChanged): the POST and the gate need
    // it synchronously.
    let cachedSid = null;

    // The gate's session question: no cached sid is no session; a sid Steam no
    // longer honours shows up in the probe.
    Gate.configure({
        hasSession: () => cachedSid ? Net.probeLoginCached() : false
    });

    // --- Steam API from the SW ---------------------------------------------

    // A cached sessionid can go stale with no store tab to refresh it, and every
    // POST then fails. HALT_AFTER consecutive failures (below the drainer's
    // MAX_FAILS, so no appid is burned first) set the halt flag; the gate wrapper
    // refuses every slot until it is cleared — by a store-page visit, or by the
    // hourly retry in the alarm handler.
    // Not counted: 429s (the gate's penalty handles those) and a classified
    // region-locked appid, which says nothing about the sid either way. Network
    // errors DO count: a failed POST is a failed POST, and there is nothing here
    // that could tell a dead sid from a dead connection. Failing closed on both
    // is the point; the hourly retry is what keeps "closed" from meaning
    // "forever" when the cause was the connection.
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

    async function post(fields) {
        try {
            const response = await Net.fetchWithTimeout(Net.IGNORE_URL, {
                method: 'POST',
                // Cross-origin from the worker: without this no cookie is sent
                // and Steam 400s every POST.
                //
                // With it, the request needs no preflight (a form-encoded POST is
                // a simple request) but READING the answer needs Steam to echo
                // this extension's origin back with Allow-Credentials — which it
                // does today, verified live, and which is why the worker route
                // works under `permissions: ["storage"]` alone, with no host
                // permission to ask the user for. If Steam ever stops, the fetch
                // rejects and this is what happens: two of those in a row set the
                // halt flag below, the worker route parks, and draining falls
                // back to the content script in any open store tab. Fail-safe,
                // not silent — but the halt flag is the symptom to look for.
                credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                body: new URLSearchParams(fields).toString()
            });
            return Net.ignoreResult(response);
        } catch (e) { return Net.ignoreFailed(); }
    }

    // Classified before trackFails sees the result: two region-locked titles in
    // a row must not halt the route.
    async function apiIgnore(appid, reason) {
        if (!cachedSid) return Net.ignoreFailed();
        return trackFails(await Net.classifyRefusal(appid, await post(
            Object.assign({ sessionid: cachedSid }, Net.ignoreFields(appid, reason)))));
    }
    async function apiUnignore(appid) {
        if (!cachedSid) return Net.ignoreFailed();
        return trackFails(await Net.classifyRefusal(appid, await post(
            Object.assign({ sessionid: cachedSid }, Net.unignoreFields(appid)))));
    }

    // Last-Ignored stats for drained MI jobs: this world's own read-modify-write
    // around the shared record shape (stats.js), name normalizer (escape.js) and
    // reason label (stats.js). One chain for all three writers, since they move
    // the same counter.
    const Stats = ILAP.StatsLogic;
    const statsSerial = ILAP.serialChain();
    // Every path resolves, including a throw inside the callback: this is a
    // serialChain, so one promise left pending would stop every later stats
    // write in this worker — and the drainer awaits these inside onLanded, so
    // the pass would hang with its lease held until the worker dies.
    function writeStats(keys, next) {
        return statsSerial(() => new Promise((resolve) => {
            try {
                chrome.storage.local.get(keys, (r) => {
                    try {
                        if (chrome.runtime.lastError) return resolve();
                        chrome.storage.local.set(next(r), resolve);
                    } catch (e) { resolve(); }
                });
            } catch (e) { resolve(); }
        })).catch(() => {});
    }
    function saveStats(name, reason) {
        const source = Stats.miSourceLabel(reason);
        const safe = ILAP.Sanitizer.sanitizeName(name);
        return writeStats([Stats.HISTORY_KEY, Stats.COUNT_KEY], (r) => Stats.nextState(r, safe, source));
    }
    // Total only: +1 for a drained curator ignore, −1 for a confirmed rollback.
    const bumpCount = () => writeStats([Stats.COUNT_KEY], Stats.countState);
    const dropCount = () => writeStats([Stats.COUNT_KEY], Stats.uncountState);

    // --- gate wrapper ------------------------------------------------------
    // reserve() sleeps in memory until its slot, and a wait past the worker's
    // lifetime would die mid-sleep. So check the expected wait first, without
    // claiming: too far → stop, and syncAlarm resumes at the penalty's end. Also
    // where the halt flag is enforced.
    // Not atomic with the claim: a 429 landing in between can make reserve()
    // sleep through the worker's death, burning one slot with no POST. The retry
    // alarm recovers it.
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

    // The drainer's dead-session check, plus the reaping of what it just proved
    // dead. A definite `false` means the cached sessionid is no longer a
    // session, and there is no reason to keep the token sitting in storage
    // until some store page happens to overwrite it — the worker cannot use it
    // for anything either way. `null` is the probe itself failing (offline, a
    // 5xx) and is NOT evidence: clearing on it would throw away a working sid
    // over a hiccup, and the drain could not resume without a store visit.
    async function probeLoginAndReap() {
        const live = await Net.probeLogin();
        if (live === false && cachedSid) await set({ [SID_KEY]: null });
        return live;
    }

    const drainer = new ILAP.Curator.CuratorQueueDrainer({
        store: Store,
        lease: Lease,
        api: { ignore: apiIgnore, unignore: apiUnignore },
        gate: {
            reserve: swReserve,
            reportRateLimited: (ms) => Gate.reportRateLimited(ms),
            stopped: () => Gate.stopVerdict()
        },
        fetchUserdata: Net.fetchIgnoredAppsStrict,
        probeLogin: probeLoginAndReap,
        saveStats,
        bumpCount,
        dropCount,
        log: Log.drainerHooks(),
        ownerId: ILAP.newOwnerId('sw_'),
        standbyMs: 0,  // no in-memory standby tick; the alarm below is the retry
        // A deferred pass comes back through kick(): halt check first, alarm after.
        rekick: () => kick()
    });

    // After every pass: keep one retry alarm while drainable work remains (the
    // lease was elsewhere, the gate stopped the pass, a penalty landed), so the
    // work is re-checked even if the worker dies now. The alarm also reaps a
    // lease orphaned by a closed tab.
    async function syncAlarm() {
        const queue = await Store.getQueue();
        const d = await get({ [HALT_KEY]: false, [Gate.PENALTY_KEY]: null });
        if (!(await drainer.hasDrainableWork(queue))) {
            chrome.alarms.clear(ALARM);
            return;
        }
        // Halted, with work still queued: one slow alarm rather than none. A
        // store-page visit is still the fast cure (it refreshes the sid and
        // clears the flag); this is the cure for when no such visit comes, which
        // is the whole case this worker exists for.
        if (d[HALT_KEY]) {
            chrome.alarms.create(ALARM, { when: Date.now() + HALT_RETRY_MS });
            return;
        }
        // Master off: the same, since turning it back on is a write we hear.
        // Every other stop keeps the alarm: a connection coming back or a sign-in
        // reusing the same sessionid writes nothing. That costs one login probe
        // per ALARM_RETRY_MS while work is queued. Asked only when there is work.
        if ((await Gate.stopVerdict()) === 'disabled') {
            chrome.alarms.clear(ALARM);
            return;
        }
        const now = Date.now();
        const when = Math.max(now + ALARM_RETRY_MS, Gate.penaltyUntil(d[Gate.PENALTY_KEY], now));
        chrome.alarms.create(ALARM, { when });
    }

    function kick() {
        // Before drain(): a pass fetches userdata first, which a halted route
        // must not pay for.
        //
        // The inner catch keeps a failed pass from skipping syncAlarm; the outer
        // one is this chain's terminator. Without it a rejected storage read or a
        // throwing syncAlarm is an unhandled rejection in the worker — and this is
        // the `kick` the storage-shim note in src/curator/store.js lists as an
        // absorber. The tab drainer's own kick() catches (curator/drainer.js);
        // this same-named wrapper has to as well.
        get({ [HALT_KEY]: false })
            .then((d) => d[HALT_KEY] ? null : drainer.drain().catch(() => {}))
            .then(syncAlarm)
            .catch((e) => console.warn('[ILAP] SW drain kick failed:', e));
    }

    // Registered synchronously in the first turn, so Chrome re-spawns the worker
    // for them. The standby interval is off.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[SID_KEY]) {
            cachedSid = changes[SID_KEY].newValue || null;
            consecFails = 0;
        }
        // Cleared by a store-page visit or by the hourly retry: either way the
        // next POST starts a fresh count, or one stale failure still in memory
        // would re-halt the route on its own.
        if (changes[HALT_KEY] && !changes[HALT_KEY].newValue) consecFails = 0;
        const touched = changes[Store.QUEUE_KEY]
            || changes[ILAP.Settings.KEYS.MASTER]
            || changes[SID_KEY]
            || changes[HALT_KEY]
            || Object.keys(changes).some(k => k.indexOf(Lease.LOCK_PREFIX) === 0);
        if (touched) kick();
    });
    chrome.alarms.onAlarm.addListener((a) => {
        if (a.name !== ALARM) return;
        // A halted route gets ONE retry an hour. The halt counter cannot tell a
        // permanently refused POST (a sessionid no page has refreshed, Steam
        // withdrawing the CORS echo the worker's fetch rests on) from a network
        // that was down for twenty seconds — both arrive as a failed POST, and
        // failing closed on both is deliberate. What is not deliberate is the
        // transient case parking the queue until the user happens to open a store
        // page: with no tab open there is nothing to produce one, so the queue
        // would sit there for good, silently. Clearing the flag is the retry —
        // the onChanged listener above kicks the pass — and if the cause was
        // permanent, two more refused POSTs halt it again for another hour.
        get({ [HALT_KEY]: false })
            .then((d) => (d[HALT_KEY] ? set({ [HALT_KEY]: false }) : kick()));
    });

    // Boot pass, whatever woke the worker. The sid goes into memory first.
    get({ [SID_KEY]: null }).then((d) => {
        cachedSid = d[SID_KEY] || null;
        kick();
    });
})();
