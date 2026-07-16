// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.Discovery = window.ILAP.Discovery || {};

    // Cross-tab cap on concurrently-active Discovery-Queue automators. The
    // aggregate ignore-rate gate already bounds the POST rate (a 3rd DQ tab just
    // starves on it), so this is a UX bound, not a safety one: give the user a
    // clear "already running" signal instead of silently stacking DQ loops.
    //
    // Model mirrors the curator lease (Store.acquireLock): a heartbeated owner map
    // in chrome.storage.local, TTL-reclaimed so a closed tab frees its slot with no
    // explicit release. All writes funnel through one per-context serialized RMW.
    //
    // Known slack (accepted — this is a UX bound, not a safety one): Chrome throttles
    // a backgrounded tab's timers to ~1/min after a few minutes, so a hidden DQ tab's
    // heartbeat can lapse and its 8 s slot expire even though its automator keeps
    // ignoring (background loops run, ~3× slower). The cap can then undercount and let
    // an extra tab start. That's fine — the aggregate rate gate still bounds the POST
    // rate regardless of how many automators the registry admits.
    const KEY = 'ilap_dq_active';    // { ownerId: expiresAt }
    const CAP = 2;                   // max concurrent DQ automators per profile
    const TTL_MS = 8000;             // slot expiry; renewed by the heartbeat
    const HEARTBEAT_MS = 3000;       // renew well within the TTL

    // --- pure helpers (unit-tested) ---------------------------------------

    // Live owners still inside their TTL (optionally excluding one ownerId).
    function activeCount(map, now, exclude) {
        let n = 0;
        for (const owner of Object.keys(map || {})) {
            if (owner === exclude) continue;
            if ((map[owner] || 0) > now) n++;
        }
        return n;
    }
    // Drop expired owners.
    function prune(map, now) {
        const out = {};
        for (const owner of Object.keys(map || {})) {
            if ((map[owner] || 0) > now) out[owner] = map[owner];
        }
        return out;
    }

    // Deliberately duplicated shim/lease math — see the world-isolation note in
    // src/curator/store.js (the canonical copy of that decision). NB the lease
    // constants here (TTL 8 s / heartbeat 3 s) intentionally mirror the curator
    // lease pair (store.js LOCK_TTL / drainer.js HEARTBEAT_MS) — keep them in step.
    const get = (k) => new Promise(r => chrome.storage.local.get(k, r));
    const set = (o) => new Promise(r => chrome.storage.local.set(o, r));

    // Serialized read-modify-write, same reasoning as Store.mutateQueue. The
    // mutator gets the pruned map and returns the next map, or null to skip the
    // write. Cross-context (other tabs) still races on the missing CAS — two tabs
    // acquiring in the same instant could both pass the cap check and briefly make
    // 3 active; accepted (the rate gate still bounds the aggregate POST rate), same
    // residual class as the curator lease.
    let chain = Promise.resolve();
    function mutate(mutator) {
        const run = chain.then(async () => {
            const map = prune((await get(KEY))[KEY] || {}, Date.now());
            const next = mutator(map);
            if (!next) return map;
            await set({ [KEY]: next });
            return next;
        });
        chain = run.catch(() => {});
        return run;
    }

    // Claim a slot. true if acquired (or already held → renewed); false if OTHER
    // live owners already fill the cap.
    async function tryAcquire(ownerId) {
        let ok = false;
        await mutate((map) => {
            const now = Date.now();
            if (!(ownerId in map) && activeCount(map, now) >= CAP) { ok = false; return null; }
            ok = true;
            return Object.assign({}, map, { [ownerId]: now + TTL_MS });
        });
        return ok;
    }

    async function renew(ownerId) {
        await mutate((map) => Object.assign({}, map, { [ownerId]: Date.now() + TTL_MS }));
    }

    async function release(ownerId) {
        await mutate((map) => { const m = Object.assign({}, map); delete m[ownerId]; return m; });
    }

    window.ILAP.Discovery.Registry = {
        activeCount, prune, tryAcquire, renew, release,
        KEY, CAP, TTL_MS, HEARTBEAT_MS
    };
})();
