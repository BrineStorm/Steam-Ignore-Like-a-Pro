// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Phase-2 curator storage model: three concerns, one module.
    //
    //  1. Retention cache (`ilap_curator_cache`) — keyed by curatorId, holds the
    //     enumerated apps so re-adding a curator within a week costs 0 network.
    //     TTL 7 days; LRU-capped at 10 curators (evicted on every write).
    //  2. Job queue (`ilap_curator_queue`) — the array the button stages into and
    //     the drainer/applet read; thin CRUD helpers so callers don't race on
    //     read-modify-write.
    //  3. Per-job lease lock (`ilap_curator_lock_<id>`) — exactly one tab drains a
    //     job at a time. Multi-tab is HANDOFF, not parallel: the holder
    //     heartbeats; if it dies the lease expires and a standby tab steals it.
    //
    // `evictCache` / `lockFree` are pure so they unit-test in Node without chrome.

    window.ILAP = window.ILAP || {};
    window.ILAP.Curator = window.ILAP.Curator || {};

    const CACHE_KEY = 'ilap_curator_cache';
    const QUEUE_KEY = 'ilap_curator_queue';
    const LOCK_PREFIX = 'ilap_curator_lock_';
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

    // Patch one job by id. `patch` may be an object or a (job)=>partial fn.
    // No-ops if the job is gone (removed while we were working).
    async function updateJob(id, patch) {
        const queue = await getQueue();
        const next = queue.map(j => j.id === id
            ? Object.assign({}, j, typeof patch === 'function' ? patch(j) : patch)
            : j);
        await setQueue(next);
        return next.find(j => j.id === id) || null;
    }

    async function removeJob(id) {
        const queue = await getQueue();
        await setQueue(queue.filter(j => j.id !== id));
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
        getQueue, setQueue, updateJob, removeJob, signalCompleted,
        // lock
        acquireLock, renewLock, holdsLock, releaseLock,
        // constants
        CACHE_KEY, QUEUE_KEY, LOCK_PREFIX, PULSE_KEY, CACHE_TTL, CACHE_MAX, LEASE_MS
    };
})();
