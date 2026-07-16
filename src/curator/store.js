// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Phase-2 curator storage model: three concerns, one module.
    //
    //  1. Retention cache (`ilap_curator_cache`) — keyed by curatorId, holds the
    //     enumerated apps so re-adding a curator within a week costs 0 network.
    //     TTL 7 days; LRU-capped at 10 curators (evicted on every write).
    //  2. Job queue (`ilap_curator_queue`) — the array the button stages into and
    //     the drainer/applet read. ALL mutations go through `mutateQueue`, a
    //     per-context serialized read-modify-write, and the array holds only
    //     user-owned fields (filter/status/appids); drain progress lives in a
    //     separate per-job cursor key the drainer alone writes. Partitioning the
    //     keys by writer is what makes cross-tab last-writer-wins harmless: the
    //     drainer can never clobber a pause/remove, and a queue write can never
    //     lose a cursor advance.
    //  3. Per-job lease lock (`ilap_curator_lock_<id>`) — exactly one tab drains a
    //     job at a time. Multi-tab is HANDOFF, not parallel: the holder
    //     heartbeats; if it dies the lease expires and a standby tab steals it.
    //     A live lease doubles as the "running" signal for the UI — running is
    //     derived, never stored in the job record.
    //
    // `evictCache` / `lockFree` are pure so they unit-test in Node without chrome.

    window.ILAP = window.ILAP || {};
    window.ILAP.Curator = window.ILAP.Curator || {};

    const CACHE_KEY = 'ilap_curator_cache';
    const QUEUE_KEY = 'ilap_curator_queue';
    const LOCK_PREFIX = 'ilap_curator_lock_';
    const CURSOR_PREFIX = 'ilap_curator_cursor_';
    const PULSE_KEY = 'ilap_curator_pulse';

    const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;  // 7 days
    const CACHE_MAX = 10;                        // LRU cap on cached curators
    const LEASE_MS = 8000;                       // lock TTL; renewed by heartbeat

    // --- pure helpers (unit-tested) ---------------------------------------

    function isFresh(entry, now, ttl) {
        return !!entry && (now - (entry.fetchedAt || 0)) < (ttl || CACHE_TTL);
    }

    // Drop expired entries, then keep only the `max` most-recently-fetched.
    function evictCache(cache, now, ttl, max) {
        ttl = ttl || CACHE_TTL;
        max = max || CACHE_MAX;
        const live = Object.keys(cache || {})
            .map(k => [k, cache[k]])
            .filter(([, v]) => v && (now - (v.fetchedAt || 0)) < ttl)
            .sort((a, b) => (b[1].fetchedAt || 0) - (a[1].fetchedAt || 0))
            .slice(0, max);
        const out = {};
        for (const [k, v] of live) out[k] = v;
        return out;
    }

    // A lock is free to take if it's missing, ours, or expired.
    function lockFree(lock, owner, now) {
        return !lock || lock.owner === owner || (lock.expiresAt || 0) <= now;
    }

    // --- chrome.storage.local wrappers ------------------------------------
    //
    // DELIBERATELY DUPLICATED (decided when triaging the reuse
    // findings — this comment is the canonical copy). The promisified
    // get/set shim, the serialized-RMW promise chain and the TTL-lease math
    // each exist in more than one module (gate.js, discovery-queue/registry.js,
    // explore-queue/utils.js, utils.js StatsManager, and here). They can NOT
    // simply move to utils.js: this file also runs inside popup.html, which
    // deliberately does not load utils.js — the popup and content-script worlds
    // share only small self-contained files (escape.js, surface.js, filters.js).
    // Consolidating would mean a new cross-world module + manifest/popup churn
    // to save ~40 stable lines whose copies each sit beside their only consumer.
    // Accepted as the price of world isolation. If you CHANGE one of the copies'
    // semantics (not cosmetics), visit its siblings.

    function get(keys) {
        return new Promise(resolve => chrome.storage.local.get(keys, resolve));
    }
    function set(obj) {
        return new Promise(resolve => chrome.storage.local.set(obj, resolve));
    }
    function remove(keys) {
        return new Promise(resolve => chrome.storage.local.remove(keys, resolve));
    }

    // --- cache ------------------------------------------------------------

    async function getCache(curatorId) {
        const res = await get(CACHE_KEY);
        const cache = res[CACHE_KEY] || {};
        return cache[curatorId] || null;
    }

    async function putCache(curatorId, entry) {
        const res = await get(CACHE_KEY);
        const cache = res[CACHE_KEY] || {};
        cache[curatorId] = Object.assign({}, entry, { fetchedAt: entry.fetchedAt || Date.now() });
        await set({ [CACHE_KEY]: evictCache(cache, Date.now()) });
    }

    // --- queue ------------------------------------------------------------

    async function getQueue() {
        const res = await get(QUEUE_KEY);
        return Array.isArray(res[QUEUE_KEY]) ? res[QUEUE_KEY] : [];
    }

    async function setQueue(queue) {
        await set({ [QUEUE_KEY]: queue });
    }

    // Serialized queue read-modify-write. chrome.storage has no atomic update,
    // so overlapping get→set pairs in the SAME context (the drainer, the widget
    // applet and the curator button all share a page's content-script context)
    // could lose a write. Every mutation funnels through this one promise chain.
    // The mutator gets a copy of the queue and returns the next array, or a
    // non-array to skip the write.
    let queueChain = Promise.resolve();
    function mutateQueue(mutator) {
        const run = queueChain.then(async () => {
            const queue = await getQueue();
            const next = mutator(queue.slice());
            if (!Array.isArray(next)) return queue;
            await setQueue(next);
            return next;
        });
        queueChain = run.catch(() => {}); // one failed write can't wedge the chain
        return run;
    }

    // Patch one job by id. `patch` may be an object or a (job)=>partial fn.
    // No-ops if the job is gone (removed while we were working).
    async function updateJob(id, patch) {
        const next = await mutateQueue(queue => queue.map(j => j.id === id
            ? Object.assign({}, j, typeof patch === 'function' ? patch(j) : patch)
            : j));
        return next.find(j => j.id === id) || null;
    }

    async function removeJob(id) {
        await mutateQueue(queue => queue.filter(j => j.id !== id));
        await remove(CURSOR_PREFIX + id); // the job's progress cursor dies with it
    }

    // --- drain cursor -------------------------------------------------------
    // Per-job progress lives OUTSIDE the queue array, in a key only the lease
    // holder writes (plus a zeroing reset while the job is 'enumerating', i.e.
    // not drainable). Keeping the drainer's only frequent write out of the
    // shared array is the cross-tab half of the race fix.

    async function getCursor(jobId) {
        const key = CURSOR_PREFIX + jobId;
        const v = (await get(key))[key];
        return Number.isFinite(v) ? v : null;
    }

    // Refuses (returns false) when the job is no longer in the queue: a remove
    // can interleave between a caller's own membership check and this write
    // (resolve()'s bail check, the drainer's loop-top check), and a cursor
    // written after removeJob already ran would leak the key in storage
    // forever — removeJob is the key's only cleanup path. Residual: no CAS,
    // so a cross-context remove can still slip between the read and the write
    // here — same accepted class as the other cross-tab races, but the window
    // shrinks from the caller's whole iteration to one adjacent get→set.
    async function setCursor(jobId, value) {
        if (!(await getQueue()).some(j => j.id === jobId)) return false;
        await set({ [CURSOR_PREFIX + jobId]: value });
        return true;
    }

    // Fire-and-forget signal that a job just finished draining. Surfaces (the
    // on-page widget) watch this key via storage.onChanged to blink once — there
    // is no persisted "done" job to react to, since finished jobs are removed.
    async function signalCompleted() {
        await set({ [PULSE_KEY]: Date.now() });
    }

    // --- lease lock -------------------------------------------------------

    async function acquireLock(curatorId, owner) {
        const key = LOCK_PREFIX + curatorId;
        const now = Date.now();
        const existing = (await get(key))[key];
        if (!lockFree(existing, owner, now)) return false;
        await set({ [key]: { owner, expiresAt: now + LEASE_MS } });
        // chrome.storage has no compare-and-swap, so confirm we actually won
        // after a tiny randomized settle (two tabs racing rarely both confirm).
        await new Promise(r => setTimeout(r, 30 + Math.floor(Math.random() * 50)));
        const after = (await get(key))[key];
        return !!after && after.owner === owner;
    }

    async function renewLock(curatorId, owner) {
        const key = LOCK_PREFIX + curatorId;
        const now = Date.now();
        const existing = (await get(key))[key];
        if (existing && existing.owner !== owner && (existing.expiresAt || 0) > now) return false;
        await set({ [key]: { owner, expiresAt: now + LEASE_MS } });
        return true;
    }

    async function holdsLock(curatorId, owner) {
        const key = LOCK_PREFIX + curatorId;
        const lock = (await get(key))[key];
        return !!lock && lock.owner === owner && (lock.expiresAt || 0) > Date.now();
    }

    async function releaseLock(curatorId, owner) {
        const key = LOCK_PREFIX + curatorId;
        const lock = (await get(key))[key];
        if (!lock || lock.owner === owner) await remove(key);
    }

    window.ILAP.Curator.Store = {
        // pure
        isFresh, evictCache, lockFree,
        // cache
        getCache, putCache,
        // queue
        getQueue, setQueue, mutateQueue, updateJob, removeJob, signalCompleted,
        // drain cursor
        getCursor, setCursor,
        // lock
        acquireLock, renewLock, holdsLock, releaseLock,
        // constants
        CACHE_KEY, QUEUE_KEY, LOCK_PREFIX, CURSOR_PREFIX, PULSE_KEY, CACHE_TTL, CACHE_MAX, LEASE_MS
    };
})();
