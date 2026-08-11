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
    const SKIPPED_PREFIX = 'ilap_curator_skipped_';
    const PULSE_KEY = 'ilap_curator_pulse';
    // Pulse a confirmed un-ignore (undo drain) writes so the Manual-Ignore
    // content scripts can clear those games' on-page IGNORED badges in every
    // tab (sessionMap + badge are per-tab; onChanged is the only cross-tab reach).
    const UNIGNORE_PULSE_KEY = 'ilap_unignored';
    // The undo counterpart of an `ilap_unignored` 'failed' pulse: a rollback the
    // user asked for that will never land. Nothing to un-badge (the game stays
    // ignored, which is exactly what its badge says) — this key exists only to
    // tell them, so it carries a timestamp and no appid.
    const UNDO_FAILED_KEY = 'ilap_undo_failed';

    const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;  // 7 days
    const CACHE_MAX = 10;                        // LRU cap on cached curators
    const LEASE_MS = 8000;                       // lock TTL; renewed by heartbeat
    // The one queue-job cap (curator jobs + at most one undo job). Lives here —
    // the queue model — so every staging surface (curator button, undo droplist)
    // enforces the same number.
    const MAX_JOBS = 3;

    // Manual-Ignore deferral job. A swipe no longer fires an ungated instant
    // POST: it enqueues the game here and the drainer sends every MI ignore
    // through the IgnoreGate, paced like EQ/DQ/curator — eliminating the last
    // ungated POST, the residual ban risk. One MI job at a time (pseudo curator
    // id 'mi' → lease ilap_curator_lock_mi), auto-filled on each swipe and
    // auto-deleted when drained empty. MI_MAX caps its size; a swipe past the
    // cap is a silent no-op. The MI job is the ONE type allowed to exceed
    // MAX_JOBS as an exclusive 4th slot — it has top drainer priority and drains
    // fastest, so it never blocks real work for long.
    const MI_ID = 'mi';
    const MI_JOB_ID = 'job_mi';
    const MI_MAX = 200;

    // Solo un-ignore deferral job — the mirror of the MI job, and a SEPARATE one
    // on purpose. Direction is a property of the JOB, not of the entry: the
    // drainer reads `isUndo` from `job.type` and it governs the policy of the
    // whole pass (strict vs lenient userdata read, the live login probe on an
    // empty set, the INVERTED dedupe, the snapshotTs "last intent wins" rule).
    // Folding un-ignores into `job_mi` as a per-appid flag would force that
    // policy to "strict if any entry is an undo" — i.e. always strict — and MI's
    // lenient path would disappear. So: same shape, same auto-create/auto-delete,
    // same cap discipline, own lease (ilap_curator_lock_miundo), and the drainer
    // treats it as an undo job that shares MI's foreground priority.
    const MIUNDO_ID = 'miundo';
    const MIUNDO_JOB_ID = 'job_mi_undo';
    const MIUNDO_MAX = 200;

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
    //
    // The rule holds for this STORAGE plumbing only, and only because of the
    // popup. Two kinds of code were pulled out of it:
    //   - PURE helpers, which never had the excuse and had already drifted (the
    //     SW's and the log's own name normalizers were missing the control-char
    //     strip) → escape.js, one definition every world loads;
    //   - the Steam network READS (deadline wrapper, userdata, login probe,
    //     appdetails classifier) → steam-net.js. That block is a TWO-world
    //     problem: popup.html never talks to Steam, so the argument above
    //     simply does not apply to it. Only the ignore POST stays per-world
    //     (see the note at the top of steam-net.js).
    // Keep it that way: a new pure helper belongs in escape.js and a new Steam
    // read in steam-net.js, not in a fourth local copy.

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

    // Dropping a job drops the intent behind it — and for an MI job that intent
    // is already painted on the page: every entry the drainer has NOT reached
    // yet was badged optimistically at swipe time, and its POST is now never
    // going to fire. The badges have to go with the job, or they lie until the
    // tab is reloaded. Not an edge case: the `mi_queue_stuck` card tells the
    // user in so many words to remove the job and retry.
    // The cursor is read AFTER the removal on purpose — `setCursor` refuses to
    // write for a job that left the queue, so by then the value is frozen and a
    // concurrent advance can't make us un-badge an appid that WAS ignored.
    // (Residual: a POST already in flight for `appids[cursor]` still lands after
    // its badge went; same no-CAS class as the rest of the cross-tab races.)
    async function removeJob(id) {
        let job = null;
        await mutateQueue((queue) => {
            job = queue.find(j => j.id === id) || null;
            return queue.filter(j => j.id !== id);
        });
        const orphaned = job && job.type === 'mi'
            ? (job.appids || []).slice((await getCursor(id)) || 0)
            : [];
        // A dropped SOLO UN-IGNORE job is the mirror case: nothing on the page is
        // wrong (the games stay ignored, which is what their badges say), but the
        // rollbacks the user gestured for will never fire — so the pending marks
        // those gestures left have to come off, which is the other half of what
        // the undo-failed pulse does.
        const strandedUndo = !!job && job.type === 'miundo'
            && (job.appids || []).length > ((await getCursor(id)) || 0);
        // The job's drainer-owned progress keys die with it.
        await remove([CURSOR_PREFIX + id, SKIPPED_PREFIX + id]);
        // Reason 'removed', not 'failed', on BOTH pulses and for the same reason:
        // the marks do have to come off, but the user dropped the job themselves
        // — "Steam didn't accept this ignore" / "Steam refused some rollbacks"
        // would each name the wrong culprit. Silent, like every other correction
        // they asked for.
        if (orphaned.length) await signalUnignored(orphaned, 'removed');
        if (strandedUndo) await signalUndoFailed('removed');
    }

    // Completion-safe removal, called by the drainer when its snapshot showed the
    // cursor at/past the end. The emptiness is RE-CHECKED inside the serialized
    // mutation against the fresh queue: an MI swipe can append to this job in the
    // window between the drainer's loop-top snapshot and here (enqueueMi funnels
    // through the same queueChain), and a blind removeJob would wipe the
    // just-appended appid — a lost ignore whose optimistic badge would then lie.
    // Kept if the job grew (drainer loops on to drain the new entries); curator/
    // undo jobs never grow, so for them this is exactly removeJob. Returns true
    // only when the job was actually removed (drainer then pulses completion).
    async function removeIfDrained(id, cursor) {
        let removed = false;
        await mutateQueue((queue) => {
            const j = queue.find(x => x.id === id);
            if (!j) return null;                                   // already gone elsewhere
            if ((cursor || 0) < (j.appids || []).length) return null; // grew → keep it
            removed = true;
            return queue.filter(x => x.id !== id);
        });
        if (removed) await remove([CURSOR_PREFIX + id, SKIPPED_PREFIX + id]);
        return removed;
    }

    // Last-Ignored history label for an MI entry's ignore reason. The reason
    // lives in this file's `meta` map, so the mapping lives here too — both
    // drain hosts (the content-script wiring in curator/drainer.js and the SW's
    // saveStats shim in background.js) read it instead of re-spelling the
    // literals in two worlds. NB the other reason===2 branch, the badge colour +
    // tooltip in manual-ignore/ui.js, is a different mapping (presentation, not
    // stored data) and deliberately stays where it is.
    const miSourceLabel = (reason) => (Number(reason) === 2 ? 'Played Elsewhere' : 'Default Ignore');

    // Append-or-create one of the two AUTO-FILLED gesture jobs: the Manual-Ignore
    // deferral job (see the MI_* consts) and its mirror, the solo un-ignore job
    // (MIUNDO_*). Identical machinery, different direction — factored into one
    // function because it is race-critical and two copies would drift: the single
    // serialized mutateQueue is what closes the create/complete race, so a gesture
    // landing exactly as the drainer removes the just-emptied job either finds the
    // job (append) or recreates it, and is never lost.
    // Each entry carries a per-appid `meta` record (the ignore direction decides
    // what's in it) while `appids` stays a plain string array, so the generic
    // drainer/cursor/dedupe paths are untouched.
    // Returns { kind:'added', total } or { kind:'full' } (the cap was reached → the
    // caller no-ops entirely). Never checks MAX_JOBS — these two are the types
    // allowed to exceed it, being live user actions that drain first and fastest.
    async function appendToAutoJob(spec, appid, meta) {
        appid = String(appid);
        // Dedupe only against the entries the drainer has NOT reached yet.
        // `appids` keeps drained entries until the job completes, so matching
        // the whole array would swallow a LEGITIMATE re-swipe: ignore a game,
        // let it drain, undo it (which clears its badge and its session-map
        // entry), swipe it again while the MI job is still alive — the appid is
        // still in the drained head, so the swipe was dropped while the caller
        // was told 'added' and painted a badge for an ignore that never fired.
        // The cursor only moves forward, so a read taken before the mutation is
        // at worst stale-low: the tail we consider is a superset of the real
        // pending tail, which keeps the guarantee that matters (never append a
        // second copy of something still queued) and leaves a one-appid window
        // where the old behaviour survives. Erring the other way would cost a
        // duplicate POST, which Steam accepts idempotently — but this direction
        // needs no extra request at all.
        const drained = (await getCursor(spec.jobId)) || 0;
        let outcome = { kind: 'full' };
        await mutateQueue((queue) => {
            const idx = queue.findIndex(j => j.type === spec.type);
            const job = idx === -1 ? null : queue[idx];
            if (job && (job.appids || []).length >= spec.max) return null;  // full → no-op
            const base = job || {
                id: spec.jobId, type: spec.type, curatorId: spec.curatorId, curatorName: '',
                appids: [], meta: {}, total: 0, status: 'pending', addedAt: Date.now()
            };
            // De-dup within the job's PENDING tail (see `drained` above): the
            // session map should already block a re-swipe, but a double-append
            // would double-POST the same game.
            const already = base.appids.indexOf(appid, drained) !== -1;
            const appids = already ? base.appids : base.appids.concat([appid]);
            // Meta is refreshed even on a de-duped swipe, so the LAST gesture
            // wins. The session map only blocks a re-swipe inside ONE tab; from
            // a second tab the same game can be swiped with the other reason
            // (blue "Played Elsewhere" vs the default), and that tab paints the
            // badge its gesture chose. Keeping the first reason would send a
            // POST that contradicts the badge the user is looking at.
            const nextMeta = Object.assign({}, base.meta, { [appid]: meta });
            const nextJob = Object.assign({}, base, { appids, meta: nextMeta, total: appids.length });
            outcome = { kind: 'added', total: appids.length };
            return idx === -1 ? queue.concat([nextJob]) : queue.map((j, i) => i === idx ? nextJob : j);
        });
        return outcome;
    }

    const MI_SPEC = { jobId: MI_JOB_ID, type: 'mi', curatorId: MI_ID, max: MI_MAX };
    const MIUNDO_SPEC = {
        jobId: MIUNDO_JOB_ID, type: 'miundo', curatorId: MIUNDO_ID, max: MIUNDO_MAX
    };

    // A swipe: the entry carries the resolved name + ignore reason, so the drainer
    // can POST the right reason and stamp Last Ignored when it actually lands.
    async function enqueueMi(entry) {
        return appendToAutoJob(MI_SPEC, entry.appid,
            { name: entry.name || '', reason: entry.reason || 0 });
    }

    // The mirror gesture: un-ignore ONE game. The entry carries the moment of the
    // gesture instead of a reason — the drainer's undo path needs a "last user
    // intent wins" boundary, and for an auto-filling job the JOB-level snapshotTs
    // the undo droplist uses would be wrong: the job is created once and appended
    // to for as long as it lives, so a game ignored AFTER the job was created but
    // BEFORE this gesture would look re-ignored-after-the-snapshot and be skipped.
    // Per-appid, the boundary is exactly what it should be — this gesture, now.
    async function enqueueMiUndo(entry) {
        return appendToAutoJob(MIUNDO_SPEC, entry.appid, { ts: Date.now() });
    }

    // Immediate regret: the user gestured a rollback for a game whose ignore has
    // not been SENT yet. Cancel the ignore instead of reversing it — no POST in
    // either direction, no rate budget spent, no ignore-log entry for something
    // that never happened, and no dependence on comparing the two intents'
    // timestamps (which is what made the reverse path lose this race: the log
    // entry is stamped when the POST lands, not when the user swiped).
    //
    // The entry is MARKED, not spliced out. `appids` indices are the drain
    // cursor's coordinate system, so removing one would slide an innocent entry
    // underneath a cursor already advanced past it — the drainer would skip a
    // game it never sent. The drainer checks the mark before spending a rate
    // slot and again after the wait; a re-swipe of the same game rewrites the
    // whole meta entry, which clears the mark by construction.
    //
    // Returns true only if the entry was still PENDING. `getCursor` is read
    // OUTSIDE the mutation, so it can be stale-low and the tail we search is a
    // superset of the real one; re-reading it afterwards is what makes the
    // answer trustworthy — losing the race reports false, and the caller falls
    // back to a real rollback rather than un-badging a game that IS ignored.
    async function cancelMiEntry(appid) {
        appid = String(appid);
        const drained = (await getCursor(MI_JOB_ID)) || 0;
        let markedAt = -1;
        await mutateQueue((queue) => {
            const idx = queue.findIndex(j => j.type === 'mi');
            if (idx === -1) return null;
            const job = queue[idx];
            const at = (job.appids || []).indexOf(appid, drained);
            if (at === -1) return null;
            markedAt = at;
            const entry = Object.assign({}, (job.meta || {})[appid], { cancelled: true });
            const nextJob = Object.assign({}, job, {
                meta: Object.assign({}, job.meta, { [appid]: entry })
            });
            return queue.map((j, i) => i === idx ? nextJob : j);
        });
        if (markedAt === -1) return false;
        return markedAt >= ((await getCursor(MI_JOB_ID)) || 0);
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

    // Per-job count of appids skipped as permanently refused (no store object
    // in the account's region — the drainer's 400-classifier). Same writer and
    // partitioning as the cursor: only the lease holder bumps it, so it lives
    // beside the cursor key, guarded the same way against a concurrent remove.
    async function bumpSkipped(jobId) {
        if (!(await getQueue()).some(j => j.id === jobId)) return false;
        const key = SKIPPED_PREFIX + jobId;
        const v = (await get(key))[key];
        await set({ [key]: (Number.isFinite(v) ? v : 0) + 1 });
        return true;
    }

    // Fire-and-forget signal that a job just finished draining. Surfaces (the
    // on-page widget) watch this key via storage.onChanged to blink once — there
    // is no persisted "done" job to react to, since finished jobs are removed.
    async function signalCompleted() {
        await set({ [PULSE_KEY]: Date.now() });
    }

    // Pulse the undo drainer fires after each CONFIRMED un-ignore, so every
    // Manual-Ignore content script can drop those games from its per-tab
    // sessionMap and un-render their on-page IGNORED badges (which otherwise
    // linger and lie). The drainer pulses ONE appid at a time (not batched at
    // job end) so the badge clears as each game rolls back; the payload is a
    // list because `removeJob` drops a whole undrained MI tail at once, and one
    // write beats a burst of N onChanged fan-outs.
    // `reason` tells the MI listener WHY the badges are going away: 'undo' (the
    // user rolled the ignore back), 'removed' (they dropped the whole MI job
    // with entries still undrained) or 'failed' (the deferred MI POST never
    // landed: region-locked appid, or every retry refused). Only the last
    // warrants telling the user anything — the other two they asked for.
    async function signalUnignored(appids, reason) {
        const list = (Array.isArray(appids) ? appids : [appids]).map(String);
        if (!list.length) return;
        await set({
            [UNIGNORE_PULSE_KEY]: { appids: list, ts: Date.now(), reason: reason || 'undo' }
        });
    }

    // The mirror image of a 'failed' un-badge pulse, for an UNDO job's entries:
    // a rollback the user asked for is not going to happen, so the game stays
    // ignored. There is no badge to correct — the page is already truthful —
    // but the pending marks a solo gesture left have to come off, and (usually)
    // the user has to be told: "of N" only ever showed up as a job-row skip line
    // that dies with the finished job.
    // `reason` carries the SAME distinction as signalUnignored's: 'failed' (the
    // remove POST was permanently refused or failed every retry) raises the
    // card; 'removed' (the user dropped the whole job from the queue applet)
    // clears the marks and stays silent, because naming Steam for something the
    // user just did would be a lie. No appid in either case.
    async function signalUndoFailed(reason) {
        await set({
            [UNDO_FAILED_KEY]: { ts: Date.now(), reason: reason || 'failed' }
        });
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
        isFresh, evictCache, lockFree, miSourceLabel,
        // cache
        getCache, putCache,
        // queue
        getQueue, setQueue, mutateQueue, updateJob, removeJob, removeIfDrained,
        enqueueMi, enqueueMiUndo, cancelMiEntry,
        signalCompleted, signalUnignored, signalUndoFailed,
        // drain cursor
        getCursor, setCursor, bumpSkipped,
        // lock
        acquireLock, renewLock, holdsLock, releaseLock,
        // constants
        CACHE_KEY, QUEUE_KEY, LOCK_PREFIX, CURSOR_PREFIX, SKIPPED_PREFIX, PULSE_KEY,
        UNIGNORE_PULSE_KEY, UNDO_FAILED_KEY,
        CACHE_TTL, CACHE_MAX, LEASE_MS, MAX_JOBS, MI_ID, MI_JOB_ID, MI_MAX,
        MIUNDO_ID, MIUNDO_JOB_ID, MIUNDO_MAX
    };
})();
