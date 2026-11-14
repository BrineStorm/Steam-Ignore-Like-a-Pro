// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Every ignore this extension performed, with a timestamp: the undo feature's
    // data (Steam's rgIgnoredApps has no dates).
    //   { appid, name?, ts, source, curatorId?, auto?, undoneAt?, skipped? }
    // source ∈ 'mi' | 'eq' | 'dq' | 'curator'. A built-in list's and a bundle
    // job's ignores are 'curator' too, with curatorId 'preset_<key>', or
    // 'bundle_<id>' / 'sub_<id>'. A bundle's app that went into the MI job is
    // 'mi' with the bundle's curatorId, and a game the AI tab's HIGH level shot
    // while browsing is 'mi' with `auto`. `undoneAt`: rolled back, kept so a
    // later undo does not repeat it. `skipped` ('unavailable' | 'failed'): a drain
    // could not ignore it; inert for every undo selector.
    // A creator ignore or its rollback is { creator, name?, ignore, ts, source:
    // 'creator' }: no appid, so every selector below passes it by, and it
    // never counts as a game.

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
    // FIFO cap. Undo reaches only what is still here, and one built-in list
    // ignores thousands of games. About 2 MB at the cap. Enforced a chunk at a time.
    const LOG_CAP = 20000;
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
        return liveIgnoreAfter(timesIndex(log), appid, snapshotTs);
    }

    // The same over a timesIndex: the newest live ignore is newer, or none is.
    function liveIgnoreAfter(times, appid, snapshotTs) {
        const at = times.ignored.get(String(appid));
        return at !== undefined && at > snapshotTs;
    }

    // Newest ts of a live ignore for `appid`, or 0: the undo drainer does not trust
    // userdata for an ignore this recent.
    function lastIgnoredAt(log, appid) {
        return timesIndex(log).ignored.get(String(appid)) || 0;
    }

    // Newest undoneAt for `appid`, or 0: the drainer does not trust a userdata
    // read that may predate a rollback of this game.
    function lastUndoneAt(log, appid) {
        return timesIndex(log).undone.get(String(appid)) || 0;
    }

    // The three above for every appid in one pass: appid -> newest time. The
    // drainer asks them on every dedupe skip, so it reads these maps, not the log.
    // A live ignore with no ts is kept as 0: it still exists for reIgnoredAfter.
    function timesIndex(log) {
        const ignored = new Map();
        const undone = new Map();
        const bump = (map, appid, at) => { if (!map.has(appid) || at > map.get(appid)) map.set(appid, at); };
        for (const e of (log || [])) {
            if (!e || !e.appid) continue;
            const appid = String(e.appid);
            if (e.undoneAt > 0) bump(undone, appid, e.undoneAt);
            else if (!e.undoneAt && !e.skipped) bump(ignored, appid, e.ts || 0);
        }
        return { ignored, undone };
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

    // Appids of the live ignores logged since `sinceTs`. Reads back from the newest
    // chunk and stops at one that begins earlier, so a page's scan, which asks this
    // often, does not read the whole log.
    async function ignoredSince(sinceTs) {
        const index = await serialized(loadIndex);
        const out = new Set();
        for (let seq = index.last; seq >= index.first; seq--) {
            const key = chunkKey(seq);
            const chunk = asArray((await get(key))[key]);
            for (const e of undoable(chunk)) if ((e.ts || 0) >= sinceTs) out.add(String(e.appid));
            if (chunk.length && (chunk[0].ts || 0) < sinceTs) break;
        }
        return out;
    }

    // One performed ignore, or with `skipped` one refusal, or one creator
    // ignore or rollback. The name is optional and sanitized here. No appid and
    // no creator, no entry: it could never be undone.
    function append(entry) {
        return appendEntry(entry, null);
    }

    // `own` (the drainer hooks) hears the plan before it is written and again
    // once it landed, inside the write chain.
    function appendEntry(entry, own) {
        if (!entry || !(entry.appid || entry.creator)) return Promise.resolve();
        const safe = entry.appid
            ? { appid: String(entry.appid), ts: entry.ts || Date.now(), source: entry.source }
            : { creator: String(entry.creator), ignore: !!entry.ignore, ts: entry.ts || Date.now(), source: entry.source };
        if (entry.name) safe.name = window.ILAP.Sanitizer.sanitizeName(entry.name);
        if (entry.curatorId) safe.curatorId = String(entry.curatorId);
        if (entry.auto) safe.auto = true;
        if (entry.skipped) safe.skipped = String(entry.skipped);
        return serialized(async () => {
            const index = await loadIndex();
            const tailKey = chunkKey(index.last);
            const tail = asArray((await get(tailKey))[tailKey]);
            const plan = appendPlan(index, tail, safe);
            if (own) own.sending(plan);
            await set(plan.writes);
            if (plan.removes.length) await remove(plan.removes);
            if (own) own.landed(index, tail, plan, safe);
        });
    }

    // After a confirmed un-ignore; rewrites only the chunks that change.
    // Resolves to the curatorIds of the entries it marked, so a built-in list
    // that ignored the game can be offered again.
    function markUndone(appid, snapshotTs) {
        const now = Date.now();
        return serialized(async () => {
            const keys = chunkKeys(await loadIndex());
            const res = await get(keys);
            const writes = {};
            const by = new Set();
            for (const k of keys) {
                const chunk = asArray(res[k]);
                const next = markedUndone(chunk, appid, snapshotTs, now);
                next.forEach((entry, i) => {
                    if (entry === chunk[i]) return;
                    writes[k] = next;
                    if (entry.curatorId) by.add(entry.curatorId);
                });
            }
            if (Object.keys(writes).length) await set(writes);
            return [...by];
        });
    }

    // --- the drainer's view -------------------------------------------------
    // The drainer asks lastIgnoredAt / lastUndoneAt / wasReIgnoredAfter for
    // every entry and marks every rollback, and an undo job can be the whole
    // log. A full read for each made it O(n²). On 5000 games already off the
    // list, a pass that skips the gate spent a minute of worker CPU.
    //
    // So the hooks keep a copy of the log in memory, read once:
    //   - their own writes (append, markUndone) update the copy in place, and
    //     the onChanged echo of each is recognized and passed by;
    //   - any other write to a log key (another context, or this one outside
    //     the hooks) drops the copy, and the next question reads it again;
    //   - markUndone reads and rewrites only the chunks with the appid in
    //     them, plus every chunk from the copy's tail on. So it also marks what
    //     another context appended before that write's onChanged arrives, and a
    //     chunk that reads back different from the copy drops the copy;
    //   - a copy with no question or own write for IDLE_MS is dropped too.
    // Reads of the copy and own writes share the write chain, so a read never
    // sees half of an own write. `getLog` stays a fresh read for the popup.
    const GONE = {};       // the echo of a removed key
    const ECHO_MAX = 16;   // own writes to one key whose echo may still be on its way
    // At the cap the copy takes several MB (7.6 MB measured), and a host that
    // drained once (a Firefox store tab) would keep it as long as the page lives.
    const IDLE_MS = 60000;

    // Values are compared by content: Chromium hands a stored object back with
    // its keys in its own order. A log value is a chunk (an array of flat
    // entries) or the index (one flat object).
    function sameFlat(a, b) {
        if (a === b) return true;
        if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length && keys.every(k => a[k] === b[k]);
    }
    function sameValue(a, b) {
        if (!Array.isArray(a) && !Array.isArray(b)) return sameFlat(a, b);
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length
            && a.every((e, i) => sameFlat(e, b[i]));
    }
    const seqOf = (key) => Number(key.slice(CHUNK_PREFIX.length));

    // The copy's times, and which chunks each appid is in, from all its chunks.
    function reindex(copy) {
        const where = new Map();
        for (const [seq, chunk] of copy.chunks) {
            for (const e of chunk) {
                if (!e || !e.appid) continue;
                const appid = String(e.appid);
                if (!where.has(appid)) where.set(appid, new Set());
                where.get(appid).add(seq);
            }
        }
        return Object.assign(copy, timesIndex([].concat(...copy.chunks.values())), { where });
    }

    // Every chunk, inside the write chain.
    async function readCopy() {
        const index = await loadIndex();
        const res = await get(chunkKeys(index));
        const chunks = new Map();
        for (let seq = index.first; seq <= index.last; seq++) chunks.set(seq, asArray(res[chunkKey(seq)]));
        return reindex({ index, chunks });
    }

    // The chunks of the copy with the appid in them, and its times again from those.
    const seqsWith = (copy, appid) => [...(copy.where.get(appid) || [])];
    function retime(copy, appid) {
        const own = [];
        for (const seq of seqsWith(copy, appid)) {
            for (const e of copy.chunks.get(seq) || []) if (e && String(e.appid) === appid) own.push(e);
        }
        const t = timesIndex(own);
        for (const map of ['ignored', 'undone']) {
            if (t[map].has(appid)) copy[map].set(appid, t[map].get(appid));
            else copy[map].delete(appid);
        }
    }

    // The curator drainer's `log` dependency. Identical for its two hosts (a
    // store tab and the service worker), both of which load this file.
    function drainerHooks() {
        // { index, chunks: Map seq -> entries, where: Map appid -> Set of seqs, ignored, undone }
        let copy = null;
        let reading = null;   // the read of it in flight
        let gen = 0;          // bumped by every drop: a read begun before one is not kept
        const echoes = new Map();   // key -> what this context wrote there, oldest first

        const drop = () => { copy = null; reading = null; gen++; };
        let idle = null;
        // Every question and own write keeps the copy another IDLE_MS.
        const touch = () => { clearTimeout(idle); idle = setTimeout(drop, IDLE_MS); };
        const expectEcho = (key, value) => {
            const list = echoes.get(key) || [];
            list.push(value === undefined ? GONE : value);
            echoes.set(key, list.slice(-ECHO_MAX));
        };
        const isEcho = (key, change) => {
            const list = echoes.get(key);
            const got = change.newValue;
            const at = list ? list.findIndex(v => (v === GONE ? got === undefined : sameValue(v, got))) : -1;
            if (at < 0) return false;
            list.splice(0, at + 1);
            if (!list.length) echoes.delete(key);
            return true;
        };
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            let foreign = false;
            for (const k of Object.keys(changes)) {
                if (isLogKey(k) && !isEcho(k, changes[k])) foreign = true;
            }
            if (foreign) drop();
        });

        function load() {
            touch();
            if (copy) return Promise.resolve(copy);
            if (!reading) {
                const at = gen;
                reading = serialized(readCopy).then((c) => {
                    if (at === gen) { copy = c; reading = null; }
                    return c;
                }, (e) => {
                    if (at === gen) reading = null;
                    throw e;
                });
            }
            return reading;
        }

        function appendOwn(entry) {
            touch();
            let at = -1;
            return appendEntry(entry, {
                sending(plan) {
                    at = gen;
                    for (const k of Object.keys(plan.writes)) expectEcho(k, plan.writes[k]);
                    for (const k of plan.removes) expectEcho(k, undefined);
                },
                landed(index, tail, plan, safe) {
                    const c = copy;
                    if (!c || at !== gen) return;
                    if (index.first !== c.index.first || index.last !== c.index.last
                        || !sameValue(c.chunks.get(index.last), tail)) { drop(); return; }
                    const next = plan.writes[INDEX_KEY] || index;
                    c.chunks.set(next.last, plan.writes[chunkKey(next.last)]);
                    for (const k of plan.removes) c.chunks.delete(seqOf(k));
                    c.index = next;
                    // Retired chunks can take any appid's newest time with them.
                    if (plan.removes.length) reindex(c);
                    else if (safe.appid) {
                        if (!c.where.has(safe.appid)) c.where.set(safe.appid, new Set());
                        c.where.get(safe.appid).add(next.last);
                        retime(c, safe.appid);
                    }
                },
            });
        }

        // Mark every not-yet-undone entry of `appid` up to `snapshotTs`, as
        // markUndone does. Resolves to the curatorIds of the entries it marked.
        function markUndoneOwn(appid, snapshotTs) {
            touch();
            appid = String(appid);
            const now = Date.now();
            return serialized(async () => {
                const at = gen;
                const index = await loadIndex();
                // Seqs only grow: a copy past the live index predates a migration.
                const c = copy && index.first >= copy.index.first && index.last >= copy.index.last ? copy : null;
                const seqs = [];
                if (c) {
                    for (const seq of seqsWith(c, appid)) if (seq >= index.first) seqs.push(seq);
                    for (let seq = Math.max(c.index.last, index.first); seq <= index.last; seq++) {
                        if (!seqs.includes(seq)) seqs.push(seq);
                    }
                } else {
                    for (let seq = index.first; seq <= index.last; seq++) seqs.push(seq);
                }
                const res = await get(seqs.map(chunkKey));
                let fresh = !!c && index.first === c.index.first && index.last === c.index.last;
                const read = new Map();
                const writes = {};
                const by = new Set();
                for (const seq of seqs) {
                    const chunk = asArray(res[chunkKey(seq)]);
                    if (c && !sameValue(c.chunks.get(seq), chunk)) fresh = false;
                    const next = markedUndone(chunk, appid, snapshotTs, now);
                    next.forEach((entry, i) => {
                        if (entry === chunk[i]) return;
                        writes[chunkKey(seq)] = next;
                        if (entry.curatorId) by.add(entry.curatorId);
                    });
                    read.set(seq, writes[chunkKey(seq)] || chunk);
                }
                const keys = Object.keys(writes);
                if (keys.length) {
                    keys.forEach(k => expectEcho(k, writes[k]));
                    await set(writes);
                }
                if (at !== gen) return [...by];        // another write came in: the copy is gone
                if (!c) copy = reindex({ index, chunks: read });   // a full read: the copy anew
                else if (!fresh) drop();
                else if (keys.length) {
                    for (const [seq, chunk] of read) c.chunks.set(seq, chunk);
                    retime(c, appid);
                }
                return [...by];
            });
        }

        return {
            append: appendOwn,
            markUndone: markUndoneOwn,
            lastIgnoredAt: async (appid) => (await load()).ignored.get(String(appid)) || 0,
            lastUndoneAt: async (appid) => (await load()).undone.get(String(appid)) || 0,
            wasReIgnoredAfter: async (appid, ts) => liveIgnoreAfter(await load(), appid, ts),
        };
    }

    window.ILAP.IgnoreLog = {
        // pure
        undoable, snapshotLastN, snapshotSince, undoableCount,
        reIgnoredAfter, lastIgnoredAt, lastUndoneAt, lastUndoneForCurator, markedUndone,
        appendPlan, chunkedPlan,
        // storage
        getLog, ignoredSince, append, markUndone, drainerHooks,
        // keys
        isLogKey, INDEX_KEY, CHUNK_PREFIX, LEGACY_KEY, CHUNK_SIZE, LOG_CAP
    };
})();
