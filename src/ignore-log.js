// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Every ignore this extension performed, with a timestamp: the undo feature's
    // data (Steam's rgIgnoredApps has no dates).
    //   { appid, name?, ts, source, curatorId?, undoneAt?, skipped? }
    // source ∈ 'mi' | 'eq' | 'dq' | 'curator'. `undoneAt`: rolled back, kept so a
    // later undo does not repeat it. `skipped` ('unavailable' | 'failed'): a drain
    // could not ignore it; inert for every undo selector.

    window.ILAP = window.ILAP || {};

    // Stored in chunks: a drain appends 1-3 entries a second, and every write
    // hands the key's old and new value to every onChanged listener in every tab.
    //   ilap_ignore_log_index  { first, last }: sequence numbers of the live chunks
    //   ilap_ignore_log_c<seq> entries, oldest -> newest, CHUNK_SIZE at most
    // The whole log is the chunks first..last concatenated; appends go to `last`.
    const INDEX_KEY = 'ilap_ignore_log_index';
    const CHUNK_PREFIX = 'ilap_ignore_log_c';
    const CHUNK_SIZE = 100;
    // A single-array log under this key is migrated into chunks (see loadIndex).
    const LEGACY_KEY = 'ilap_ignore_log';
    // FIFO cap, large enough for a big curator drain. Enforced a chunk at a time.
    const LOG_CAP = 5000;
    const MAX_CHUNKS = LOG_CAP / CHUNK_SIZE;

    const chunkKey = (seq) => CHUNK_PREFIX + seq;
    // Every key the log lives under, the legacy one included, for listeners that
    // must tell a log write from anything else.
    const isLogKey = (k) => k === INDEX_KEY || k === LEGACY_KEY || k.indexOf(CHUNK_PREFIX) === 0;

    // --- pure selectors (unit-tested) --------------------------------------
    // The log array is ordered oldest → newest (append at the end).

    // Entries still eligible for undo: not yet rolled back, actually ignored
    // (a skipped entry records a refusal, not an ignore).
    function undoable(log) {
        return (log || []).filter(e => e && e.appid && !e.undoneAt && !e.skipped);
    }

    // Unique appids of the last `n` undoable entries, newest first. A re-ignored
    // appid can appear twice (older copy undone or not) — keep the newest entry.
    function snapshotLastN(log, n) {
        const out = [];
        const seen = new Set();
        const live = undoable(log);
        for (let i = live.length - 1; i >= 0 && out.length < n; i--) {
            const appid = String(live[i].appid);
            if (seen.has(appid)) continue;
            seen.add(appid);
            out.push(appid);
        }
        return out;
    }

    // Unique appids of undoable entries with ts >= sinceTs, newest first.
    function snapshotSince(log, sinceTs) {
        const out = [];
        const seen = new Set();
        const live = undoable(log);
        for (let i = live.length - 1; i >= 0; i--) {
            if ((live[i].ts || 0) < sinceTs) continue;
            const appid = String(live[i].appid);
            if (seen.has(appid)) continue;
            seen.add(appid);
            out.push(appid);
        }
        return out;
    }

    // How many unique appids an "undo everything" would cover — drives the undo
    // input's placeholder (the bare number) and the stepper's ceiling.
    function undoableCount(log) {
        const seen = new Set();
        for (const e of undoable(log)) seen.add(String(e.appid));
        return seen.size;
    }

    // "Last user intent wins": a live ignore newer than the undo's snapshot.
    function reIgnoredAfter(log, appid, snapshotTs) {
        appid = String(appid);
        return (log || []).some(e => e && String(e.appid) === appid
            && !e.undoneAt && !e.skipped && (e.ts || 0) > snapshotTs);
    }

    // Newest ts of a live ignore for `appid`, or 0: the undo drainer does not trust
    // userdata for an ignore this recent.
    function lastIgnoredAt(log, appid) {
        appid = String(appid);
        let latest = 0;
        for (const e of (log || [])) {
            if (e && String(e.appid) === appid && !e.undoneAt && !e.skipped
                && (e.ts || 0) > latest) latest = e.ts || 0;
        }
        return latest;
    }

    // Newest undoneAt among entries staged from this curator within `windowMs`
    // of `now`, or 0 — feeds the soft re-stage warning in the curator droplist.
    function lastUndoneForCurator(log, curatorId, windowMs, now) {
        let latest = 0;
        for (const e of (log || [])) {
            if (!e || String(e.curatorId || '') !== String(curatorId)) continue;
            const u = e.undoneAt || 0;
            if (u > latest && u >= now - windowMs) latest = u;
        }
        return latest;
    }

    // One append against the index and the tail chunk. Returns the writes and
    // removals it takes: the tail (or a fresh chunk once the tail is full), the
    // index when it moved, and the oldest chunks past `maxChunks`.
    function appendPlan(index, tail, entry, chunkSize, maxChunks) {
        const size = chunkSize || CHUNK_SIZE;
        const max = maxChunks || MAX_CHUNKS;
        const next = { first: index.first, last: index.last };
        let chunk = tail || [];
        if (chunk.length >= size) { next.last += 1; chunk = []; }
        const writes = { [chunkKey(next.last)]: chunk.concat([entry]) };
        const removes = [];
        while (next.last - next.first + 1 > max) removes.push(chunkKey(next.first++));
        if (next.first !== index.first || next.last !== index.last) writes[INDEX_KEY] = next;
        return { writes, removes };
    }

    // A flat array as chunk writes plus their index, newest entries kept past the cap.
    function chunkedPlan(entries, chunkSize, maxChunks) {
        const size = chunkSize || CHUNK_SIZE;
        const max = maxChunks || MAX_CHUNKS;
        const kept = entries.slice(Math.max(0, entries.length - size * max));
        const writes = {};
        let seq = 0;
        for (let i = 0; i < kept.length; i += size) writes[chunkKey(seq++)] = kept.slice(i, i + size);
        writes[INDEX_KEY] = { first: 0, last: Math.max(0, seq - 1) };
        return writes;
    }

    // Mark every not-yet-undone entry of `appid` with ts <= snapshotTs as
    // undone at `now`. Newer entries stay live — they were ignored after the
    // undo job's snapshot and are not covered by it.
    function markedUndone(log, appid, snapshotTs, now) {
        appid = String(appid);
        return (log || []).map(e => (e && String(e.appid) === appid
            && !e.undoneAt && !e.skipped && (e.ts || 0) <= snapshotTs)
            ? Object.assign({}, e, { undoneAt: now })
            : e);
    }

    // --- chrome.storage.local wrappers -------------------------------------
    // Duplicated per world on purpose (see src/curator/store.js).

    function get(keys) {
        return new Promise(resolve => chrome.storage.local.get(keys, resolve));
    }
    function set(obj) {
        return new Promise(resolve => chrome.storage.local.set(obj, resolve));
    }

    function remove(keys) {
        return new Promise(resolve => chrome.storage.local.remove(keys, resolve));
    }

    const asArray = (v) => (Array.isArray(v) ? v : []);
    const chunkKeys = (index) => {
        const keys = [];
        for (let seq = index.first; seq <= index.last; seq++) keys.push(chunkKey(seq));
        return keys;
    };

    // One write chain per context, so overlapping get→set pairs cannot lose an
    // entry. Across contexts there is no CAS: at worst one entry is lost.
    const serialized = window.ILAP.serialChain();

    async function readChunks(index) {
        const keys = chunkKeys(index);
        const res = await get(keys);
        return keys.reduce((all, k) => all.concat(asArray(res[k])), []);
    }

    // The index, migrating a single-array log first; the array replaces any
    // chunks. The two cannot coexist in a real profile: an update swaps every
    // script, and an orphaned content script loses storage access (verified on
    // Chromium). Inside the write chain only. Right after an update the SW and a
    // tab can both migrate, and the later write can drop a few entries.
    async function loadIndex() {
        const res = await get([INDEX_KEY, LEGACY_KEY]);
        const index = res[INDEX_KEY] || { first: 0, last: 0 };
        if (!Array.isArray(res[LEGACY_KEY])) return index;
        const writes = chunkedPlan(res[LEGACY_KEY]);
        const stale = chunkKeys(index).filter(k => !(k in writes));
        await set(writes);
        await remove(stale.concat([LEGACY_KEY]));
        return writes[INDEX_KEY];
    }

    async function getLog() {
        return readChunks(await serialized(loadIndex));
    }

    // One performed ignore, or with `skipped` one refusal. The name is optional
    // and sanitized here. No appid, no entry: it could never be undone.
    function append(entry) {
        if (!entry || !entry.appid) return Promise.resolve();
        const safe = {
            appid: String(entry.appid),
            ts: entry.ts || Date.now(),
            source: entry.source
        };
        if (entry.name) safe.name = window.ILAP.Sanitizer.sanitizeName(entry.name);
        if (entry.curatorId) safe.curatorId = String(entry.curatorId);
        if (entry.skipped) safe.skipped = String(entry.skipped);
        return serialized(async () => {
            const index = await loadIndex();
            const tailKey = chunkKey(index.last);
            const tail = asArray((await get(tailKey))[tailKey]);
            const { writes, removes } = appendPlan(index, tail, safe);
            await set(writes);
            if (removes.length) await remove(removes);
        });
    }

    // After a confirmed un-ignore; rewrites only the chunks that change.
    function markUndone(appid, snapshotTs) {
        const now = Date.now();
        return serialized(async () => {
            const keys = chunkKeys(await loadIndex());
            const res = await get(keys);
            const writes = {};
            for (const k of keys) {
                const chunk = asArray(res[k]);
                const next = markedUndone(chunk, appid, snapshotTs, now);
                if (next.some((entry, i) => entry !== chunk[i])) writes[k] = next;
            }
            if (Object.keys(writes).length) await set(writes);
        });
    }

    // The drainer asks these two per ENTRY, and an undo job is up to the whole
    // undoable list — "un-ignore everything" on a full log is 5000 entries, each
    // re-reading all 50 chunks and rebuilding a 5000-object array, i.e. O(n²).
    // The gate hides it while POSTs are being sent; a dedupe pass skips the gate
    // entirely and runs that loop flat out.
    //
    // So: one snapshot, dropped whenever the log changes. Own writes drop it
    // synchronously (onChanged is delivered a tick later, and `append` here is
    // exactly what a re-ignore mid-pass goes through); the listener covers the
    // other context — a tab draining MI while the worker drains the undo job.
    // Only the drainer's hooks share it. `getLog` stays a fresh read for the
    // popup, which must not show a stale undoable count.
    let snapshot = null;
    const dropSnapshot = () => { snapshot = null; };
    function cachedLog() {
        if (!snapshot) snapshot = getLog().catch((e) => { dropSnapshot(); throw e; });
        return snapshot;
    }

    // The curator drainer's `log` dependency. Identical for its two hosts (a
    // store tab and the service worker), both of which load this file.
    function drainerHooks() {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && Object.keys(changes).some(isLogKey)) dropSnapshot();
        });
        return {
            append: (entry) => { dropSnapshot(); return append(entry); },
            markUndone: (appid, ts) => { dropSnapshot(); return markUndone(appid, ts); },
            lastIgnoredAt: async (appid) => lastIgnoredAt(await cachedLog(), appid),
            wasReIgnoredAfter: async (appid, ts) => reIgnoredAfter(await cachedLog(), appid, ts),
        };
    }

    window.ILAP.IgnoreLog = {
        // pure
        undoable, snapshotLastN, snapshotSince, undoableCount,
        reIgnoredAfter, lastIgnoredAt, lastUndoneForCurator, markedUndone,
        appendPlan, chunkedPlan,
        // storage
        getLog, append, markUndone, drainerHooks,
        // keys
        isLogKey, INDEX_KEY, CHUNK_PREFIX, LEGACY_KEY, CHUNK_SIZE, LOG_CAP
    };
})();
