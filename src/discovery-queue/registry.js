// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.Discovery = window.ILAP.Discovery || {};

    // Cross-tab cap on running Discovery Queue automators. A UX bound, not a
    // safety one: the rate gate already bounds the POSTs, this gives a clear
    // "already running" instead of stacked loops. A heartbeated owner map with a
    // TTL, like the curator lease, so a closed tab frees its slot by itself.
    // A backgrounded tab's throttled heartbeat can lapse while its loop still
    // runs, letting one extra tab start; the gate still bounds the rate.
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

    // Storage shim, duplicated per world on purpose (see src/curator/store.js).
    // TTL and heartbeat mirror the curator lease (lease.js LEASE_MS, drainer.js
    // HEARTBEAT_MS).
    const get = (k) => new Promise(r => chrome.storage.local.get(k, r));
    const set = (o) => new Promise(r => chrome.storage.local.set(o, r));

    // Serialized read-modify-write, like Store.mutateQueue: the mutator gets the
    // pruned map and returns the next one, or null. Two tabs acquiring at once can
    // both pass the cap (no CAS); the gate still bounds the rate.
    const serial = window.ILAP.serialChain();
    function mutate(mutator) {
        return serial(async () => {
            const map = prune((await get(KEY))[KEY] || {}, Date.now());
            const next = mutator(map);
            if (!next) return map;
            await set({ [KEY]: next });
            return next;
        });
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
