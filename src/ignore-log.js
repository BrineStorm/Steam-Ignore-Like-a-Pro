// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Timestamped append log of every ignore the EXTENSION performed — the data
    // source for the undo feature. Steam's own rgIgnoredApps is a bare Set with
    // no dates, so count- and time-scoped undo both operate on OUR entries:
    //   { appid, name?, ts, source, curatorId?, undoneAt?, skipped? }
    // source ∈ 'mi' | 'eq' | 'dq' | 'curator'. `undoneAt` marks entries the undo
    // drainer already rolled back (kept, not deleted — a second "undo last N"
    // must not re-undo them, and the curator soft re-stage warning reads them).
    // `skipped` ('unavailable') marks an appid a curator drain could NOT ignore
    // (permanent 400 — no store object in the account's region): a durable
    // record that the job wasn't a full "done". Nothing was ignored, so every
    // undo selector treats these entries as inert.
    //
    // Loaded in BOTH worlds (content_scripts and popup.html), like store.js.
    // The selectors are pure so they unit-test in Node without chrome.

    window.ILAP = window.ILAP || {};

    const LOG_KEY = 'ilap_ignore_log';
    // FIFO cap. Bulk curator drains log one entry per appid, so the cap must
    // comfortably hold a large drain and still leave "undo last 1000" meaningful.
    const LOG_CAP = 5000;

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

    // How many unique appids an "undo everything" would cover — drives the
    // "of N" hint next to the undo input.
    function undoableCount(log) {
        const seen = new Set();
        for (const e of undoable(log)) seen.add(String(e.appid));
        return seen.size;
    }

    // The undo drainer's "last user intent wins" rule: skip an appid when a
    // NEWER ignore entry exists than the undo job's snapshot — the user
    // re-ignored it after staging the undo, and that later action is the one
    // that stands.
    function reIgnoredAfter(log, appid, snapshotTs) {
        appid = String(appid);
        return (log || []).some(e => e && String(e.appid) === appid
            && !e.undoneAt && !e.skipped && (e.ts || 0) > snapshotTs);
    }

    // Newest ts of a LIVE (not undone, not skipped) ignore for `appid`, or 0.
    // The undo drainer uses this to tell a genuinely-not-ignored appid (old
    // ignore ts — trust "absent from rgIgnoredApps" as "already rolled back")
    // from one ignored so recently that Steam's userdata may not reflect it
    // yet: the inverse dedupe would then read the appid as already-undone and
    // skip the remove POST, stranding the game in the ignore list forever.
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

    // Append + trim: oldest entries fall off past the cap.
    function appended(log, entry, cap) {
        const next = (log || []).concat([entry]);
        const max = cap || LOG_CAP;
        return next.length > max ? next.slice(next.length - max) : next;
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
    // Deliberately duplicated shim — see the world-isolation note in
    // src/curator/store.js (the canonical copy of that decision).

    function get(keys) {
        return new Promise(resolve => chrome.storage.local.get(keys, resolve));
    }
    function set(obj) {
        return new Promise(resolve => chrome.storage.local.set(obj, resolve));
    }

    async function getLog() {
        const res = await get(LOG_KEY);
        return Array.isArray(res[LOG_KEY]) ? res[LOG_KEY] : [];
    }

    // Serialized log read-modify-write (the Store.mutateQueue pattern): every
    // mutation in this context funnels through one promise chain so overlapping
    // get→set pairs can't lose a write. Cross-tab still races on chrome.storage's
    // lack of CAS — same accepted class as the stats/queue RMW residuals (at
    // worst one log entry is lost, never a functional break).
    let logChain = Promise.resolve();
    function mutateLog(mutator) {
        const run = logChain.then(async () => {
            const log = await getLog();
            const next = mutator(log);
            if (!Array.isArray(next)) return log;
            await set({ [LOG_KEY]: next });
            return next;
        });
        logChain = run.catch(() => {});
        return run;
    }

    // Record one performed ignore (or, with `skipped`, one permanent refusal
    // the curator drainer stepped over). `name` is optional (bulk curator
    // drains only know appids) and is normalized at this boundary like every
    // stored name.
    // A missing appid (DQ's slide parser can fail to find the app link) is
    // dropped — an entry that can't be un-ignored has no place in an undo log.
    function append(entry) {
        if (!entry || !entry.appid) return Promise.resolve();
        const safe = {
            appid: String(entry.appid),
            ts: entry.ts || Date.now(),
            source: entry.source
        };
        if (entry.name) {
            safe.name = (window.ILAP && window.ILAP.sanitizeName)
                ? window.ILAP.sanitizeName(entry.name)
                : String(entry.name).replace(/[<>]/g, '').trim().slice(0, 120);
        }
        if (entry.curatorId) safe.curatorId = String(entry.curatorId);
        if (entry.skipped) safe.skipped = String(entry.skipped);
        return mutateLog(log => appended(log, safe));
    }

    // Called by the undo drainer after a CONFIRMED un-ignore POST.
    function markUndone(appid, snapshotTs) {
        return mutateLog(log => markedUndone(log, appid, snapshotTs, Date.now()));
    }

    window.ILAP.IgnoreLog = {
        // pure
        undoable, snapshotLastN, snapshotSince, undoableCount,
        reIgnoredAfter, lastIgnoredAt, lastUndoneForCurator, appended, markedUndone,
        // storage
        getLog, mutateLog, append, markUndone,
        // constants
        LOG_KEY, LOG_CAP
    };
})();
