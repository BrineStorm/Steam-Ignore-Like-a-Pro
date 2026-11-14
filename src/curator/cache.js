// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // What a curator's pages gave, per curator (`ilap_curator_cache`), so adding
    // one again within a week costs no network. TTL 7 days, LRU 10. Only complete
    // runs come here (EnqueueService.resolve).

    window.ILAP = window.ILAP || {};
    window.ILAP.Curator = window.ILAP.Curator || {};

    const KEY = 'ilap_curator_cache';
    const TTL = 7 * 24 * 60 * 60 * 1000;
    const MAX = 10;

    function isFresh(entry, now, ttl) {
        return !!entry && (now - (entry.fetchedAt || 0)) < (ttl || TTL);
    }

    // Drop expired entries, then keep only the `max` most-recently-fetched.
    function evictCache(cache, now, ttl, max) {
        const live = Object.keys(cache || {})
            .map(k => [k, cache[k]])
            .filter(([, v]) => v && isFresh(v, now, ttl))
            .sort((a, b) => (b[1].fetchedAt || 0) - (a[1].fetchedAt || 0))
            .slice(0, max || MAX);
        const out = {};
        for (const [k, v] of live) out[k] = v;
        return out;
    }

    // Storage shim, duplicated per world on purpose (see src/curator/store.js).
    const read = () => new Promise(resolve => chrome.storage.local.get(KEY, resolve)).then(res => res[KEY] || {});
    const write = (cache) => new Promise(resolve => chrome.storage.local.set({ [KEY]: cache }, resolve));

    async function get(curatorId) {
        return (await read())[curatorId] || null;
    }

    async function put(curatorId, entry) {
        const cache = await read();
        cache[curatorId] = Object.assign({}, entry, { fetchedAt: entry.fetchedAt || Date.now() });
        await write(evictCache(cache, Date.now()));
    }

    window.ILAP.Curator.Cache = { isFresh, evictCache, get, put };
})();
