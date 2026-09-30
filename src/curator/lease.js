// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Per-job lease lock (`ilap_curator_lock_<curatorId>`): exactly one drainer —
    // a tab or the service worker — drains a job at a time. The holder renews it;
    // if the holder dies the lease expires and a standby drainer takes over. A
    // live lease is also the queue applet's "running" signal, so running is
    // never stored in the job record.

    window.ILAP = window.ILAP || {};
    window.ILAP.Curator = window.ILAP.Curator || {};

    const LOCK_PREFIX = 'ilap_curator_lock_';
    const LEASE_MS = 8000;

    // Free to take if missing, ours, or expired.
    function lockFree(lock, owner, now) {
        return !lock || lock.owner === owner || (lock.expiresAt || 0) <= now;
    }

    const get = (key) => new Promise(resolve => chrome.storage.local.get(key, resolve))
        .then(res => res[key]);
    const set = (obj) => new Promise(resolve => chrome.storage.local.set(obj, resolve));
    const remove = (key) => new Promise(resolve => chrome.storage.local.remove(key, resolve));

    async function acquireLock(curatorId, owner) {
        const key = LOCK_PREFIX + curatorId;
        const now = Date.now();
        if (!lockFree(await get(key), owner, now)) return false;
        await set({ [key]: { owner, expiresAt: now + LEASE_MS } });
        // No compare-and-swap: confirm the write survived a short random settle,
        // so two drainers racing for it rarely both win.
        await new Promise(r => setTimeout(r, 30 + Math.floor(Math.random() * 50)));
        const after = await get(key);
        return !!after && after.owner === owner;
    }

    async function renewLock(curatorId, owner) {
        const key = LOCK_PREFIX + curatorId;
        const now = Date.now();
        const existing = await get(key);
        if (existing && existing.owner !== owner && (existing.expiresAt || 0) > now) return false;
        await set({ [key]: { owner, expiresAt: now + LEASE_MS } });
        return true;
    }

    async function holdsLock(curatorId, owner) {
        const lock = await get(LOCK_PREFIX + curatorId);
        return !!lock && lock.owner === owner && (lock.expiresAt || 0) > Date.now();
    }

    async function releaseLock(curatorId, owner) {
        const key = LOCK_PREFIX + curatorId;
        const lock = await get(key);
        if (!lock || lock.owner === owner) await remove(key);
    }

    window.ILAP.Curator.Lease = {
        lockFree, acquireLock, renewLock, holdsLock, releaseLock, LOCK_PREFIX, LEASE_MS,
    };
})();
