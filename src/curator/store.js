// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Curator storage model.
    //  - Retention cache (`ilap_curator_cache`): enumerated apps per curator, so
    //    re-adding one within a week costs no network. TTL 7 days, LRU 10.
    //  - Job queue (`ilap_curator_queue`): user-owned fields only
    //    (filter/status/appids), every write through `mutateQueue`.
    //  - Drain progress: a cursor and a skip count per job, each in its own key
    //    that only the lease holder (curator/lease.js) writes.
    //  - Cross-tab pulses: completed / un-ignored / undo-failed.
    // Keeping the drainer's frequent writes out of the queue array is what makes
    // cross-tab last-writer-wins harmless: a drain can never clobber a pause or
    // remove, and a queue write can never lose a cursor advance.

    window.ILAP = window.ILAP || {};
    window.ILAP.Curator = window.ILAP.Curator || {};

    const CACHE_KEY = 'ilap_curator_cache';
    const QUEUE_KEY = 'ilap_curator_queue';
    const CURSOR_PREFIX = 'ilap_curator_cursor_';
    const SKIPPED_PREFIX = 'ilap_curator_skipped_';
    const PULSE_KEY = 'ilap_curator_pulse';
    // Games that stopped being ignored, for every Manual-Ignore tab to un-badge.
    const UNIGNORE_PULSE_KEY = 'ilap_unignored';
    // A rollback that will never land. No appid: nothing on the page is wrong.
    const UNDO_FAILED_KEY = 'ilap_undo_failed';
    // The service-worker drain (src/background.js): the sessionid a store page
    // caches for it, and the flag it sets after repeated failed POSTs.
    const SW_SID_KEY = 'ilap_sw_sid';
    const SW_HALT_KEY = 'ilap_sw_halt';

    const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
    const CACHE_MAX = 10;
    // Curator jobs plus at most one undo job; the gesture jobs sit outside it.
    const MAX_JOBS = 3;

    // Job types and the two traits the rest of the code asks about:
    //   undo    — POSTs remove=1 under the undo pass policy (strict userdata,
    //             inverted dedupe, "last user intent wins");
    //   gesture — auto-filled by a live gesture: drains first, has no curator.
    const JOB_TYPE = Object.freeze({ CURATOR: 'curator', UNDO: 'undo', MI: 'mi', MIUNDO: 'miundo' });
    const JOB_TRAITS = Object.freeze({
        [JOB_TYPE.CURATOR]: Object.freeze({ undo: false, gesture: false }),
        [JOB_TYPE.UNDO]: Object.freeze({ undo: true, gesture: false }),
        [JOB_TYPE.MI]: Object.freeze({ undo: false, gesture: true }),
        [JOB_TYPE.MIUNDO]: Object.freeze({ undo: true, gesture: true }),
    });
    // A job with no `type` predates the field and is a curator job. A type this
    // build does not know (after a downgrade) has no traits: it could be a
    // rollback, so callers must not drain it as an ignore.
    const jobType = (job) => (job && job.type) || JOB_TYPE.CURATOR;
    const jobTraits = (job) => JOB_TRAITS[jobType(job)] || null;
    // The jobs MAX_JOBS counts. A type this build does not know counts: it
    // could be either kind.
    const cappedCount = (queue) => queue.filter(j => {
        const traits = jobTraits(j);
        return !(traits && traits.gesture);
    }).length;

    // The Manual-Ignore job: a swipe enqueues here and the drainer POSTs through
    // the rate gate. One at a time, auto-created and auto-removed; may exceed
    // MAX_JOBS. Past MI_MAX a swipe is refused.
    const MI_ID = 'mi';
    const MI_JOB_ID = 'job_mi';
    const MI_MAX = 200;

    // The solo un-ignore job: the same machinery, a separate job, because the
    // direction is a property of the whole pass (see JOB_TRAITS.undo), not of
    // one entry.
    const MIUNDO_ID = 'miundo';
    const MIUNDO_JOB_ID = 'job_mi_undo';
    const MIUNDO_MAX = 200;

    // --- pure helpers -------------------------------------------------------

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

    // --- chrome.storage.local wrappers --------------------------------------
    // Duplicated on purpose. SEVEN copies, and this is the list — a reader who
    // finds one that is not here has found a drift, not a discovery:
    //   gate.js, curator/lease.js, this file, discovery-queue/registry.js,
    //   ignore-log.js, background.js, and explore-queue/utils.js (inline, in
    //   QueueSettings.read).
    // popup.html does not load utils.js, and a shared shim would be a new
    // cross-world file for a few stable lines. Pure helpers go to escape.js and
    // Steam reads to steam-net.js instead of being copied.
    // NOT one of them: utils.js StatsManager, which calls chrome.storage with raw
    // callbacks precisely so it CAN check lastError and the context id — a throw
    // inside a storage callback there would strand a promise in a serialChain and
    // wedge every later stats write in the page, which is a different failure with
    // a different cost from the one below.
    //
    // None of these copies guards the invalidated-extension-context case (an
    // update swaps every script while a store page keeps running the old one,
    // and its chrome.storage calls throw from then on). That is deliberate: the
    // tab has no storage left, so there is nothing to recover — the guard would
    // only be turning a throw into a silent no-op, seven times over. The callers
    // that are fire-and-forget absorb it instead (manual-ignore/main.js
    // _dispatch and its boot, curator/main.js jobAction, the drainer's kick,
    // ExploreAutomator.kick). Note serialChain hands the CALLER its rejection —
    // it swallows only its own continuation — so a new one needs its own catch.

    function get(keys) {
        return new Promise(resolve => chrome.storage.local.get(keys, resolve));
    }
    function set(obj) {
        return new Promise(resolve => chrome.storage.local.set(obj, resolve));
    }
    function remove(keys) {
        return new Promise(resolve => chrome.storage.local.remove(keys, resolve));
    }

    // --- cache ----------------------------------------------------------------

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

    // --- queue ----------------------------------------------------------------

    async function getQueue() {
        const res = await get(QUEUE_KEY);
        return Array.isArray(res[QUEUE_KEY]) ? res[QUEUE_KEY] : [];
    }

    async function setQueue(queue) {
        await set({ [QUEUE_KEY]: queue });
    }

    // Serialized read-modify-write within this context: the drainer, the applet
    // and the curator button share a page's context, and overlapping get→set
    // pairs would lose a write. The mutator gets a copy and returns the next
    // array, or a non-array to skip the write.
    const queueSerial = window.ILAP.serialChain();
    function mutateQueue(mutator) {
        return queueSerial(async () => {
            const queue = await getQueue();
            const next = mutator(queue.slice());
            if (!Array.isArray(next)) return queue;
            await setQueue(next);
            return next;
        });
    }

    // Patch one job by id; `patch` is an object or (job) => partial. No-op if gone.
    async function updateJob(id, patch) {
        const next = await mutateQueue(queue => queue.map(j => j.id === id
            ? Object.assign({}, j, typeof patch === 'function' ? patch(j) : patch)
            : j));
        return next.find(j => j.id === id) || null;
    }

    // Removing a gesture job must correct what its gestures already painted:
    //  - MI: the undrained entries were badged optimistically and will now never
    //    be sent, so their badges go;
    //  - solo un-ignore: the games stay ignored, so only the pending marks go.
    // Both pulses say 'removed': the user did this, so nothing is announced.
    // The cursor is read after the removal, when `setCursor` can no longer move
    // it. A POST already in flight can still land after its badge went.
    async function removeJob(id) {
        let job = null;
        await mutateQueue((queue) => {
            job = queue.find(j => j.id === id) || null;
            return queue.filter(j => j.id !== id);
        });
        const type = job && jobType(job);
        const cursor = type === JOB_TYPE.MI || type === JOB_TYPE.MIUNDO
            ? ((await getCursor(id)) || 0) : 0;
        const orphaned = type === JOB_TYPE.MI ? (job.appids || []).slice(cursor) : [];
        const strandedUndo = type === JOB_TYPE.MIUNDO && (job.appids || []).length > cursor;
        await remove([CURSOR_PREFIX + id, SKIPPED_PREFIX + id]);
        if (orphaned.length) await signalUnignored(orphaned, 'removed');
        if (strandedUndo) await signalUndoFailed('removed');
    }

    // The drainer's removal of a job its snapshot saw finished. Emptiness is
    // re-checked inside the mutation, because a gesture may have appended to the
    // job since. Returns true only if the job was removed.
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

    // Append to (or create) one of the two gesture jobs. One serialized mutation
    // is what makes a gesture landing as the drainer removes the emptied job
    // either append or recreate, never get lost. `appids` stays a plain array;
    // per-entry data lives in `meta`.
    // Returns { kind:'added', total } or { kind:'full' }.
    async function appendToAutoJob(spec, appid, meta) {
        appid = String(appid);
        // Dedupe only against the entries not drained yet: a game ignored,
        // drained, undone and swiped again is a real new ignore. The cursor read
        // outside the mutation can only be stale-low, so the tail checked is a
        // superset of the real pending tail.
        const drained = (await getCursor(spec.jobId)) || 0;
        let outcome = { kind: 'full' };
        await mutateQueue((queue) => {
            const idx = queue.findIndex(j => jobType(j) === spec.type);
            const job = idx === -1 ? null : queue[idx];
            const base = job || {
                id: spec.jobId, type: spec.type, curatorId: spec.curatorId, curatorName: '',
                appids: [], meta: {}, total: 0, status: 'pending', addedAt: Date.now()
            };
            const current = base.appids || [];
            // Dedupe BEFORE the cap: a game still in the undrained tail is already
            // queued and already badged, and answering that swipe with 'full'
            // would raise the stuck-queue card over a gesture that changes
            // nothing (in another tab, which has no badge of its own to stop it
            // earlier). Only a gesture that would GROW the job can be refused.
            const already = current.indexOf(appid, drained) !== -1;
            if (!already && current.length >= spec.max) return null;  // full → no-op
            const appids = already ? current : current.concat([appid]);
            // Meta is refreshed on a deduped gesture too: another tab may have
            // swiped the same game with the other reason, and the POST must match
            // the badge the user last saw.
            const nextMeta = Object.assign({}, base.meta, { [appid]: meta });
            const nextJob = Object.assign({}, base, { appids, meta: nextMeta, total: appids.length });
            outcome = { kind: 'added', total: appids.length };
            return idx === -1 ? queue.concat([nextJob]) : queue.map((j, i) => i === idx ? nextJob : j);
        });
        return outcome;
    }

    const MI_SPEC = { jobId: MI_JOB_ID, type: JOB_TYPE.MI, curatorId: MI_ID, max: MI_MAX };
    const MIUNDO_SPEC = {
        jobId: MIUNDO_JOB_ID, type: JOB_TYPE.MIUNDO, curatorId: MIUNDO_ID, max: MIUNDO_MAX
    };

    // A swipe: name and reason travel with the entry for the drainer to use.
    async function enqueueMi(entry) {
        return appendToAutoJob(MI_SPEC, entry.appid,
            { name: entry.name || '', reason: entry.reason || 0 });
    }

    // A solo un-ignore. The entry carries the gesture time: this job lives on
    // and grows, so a job-level snapshot time would be the first gesture's.
    async function enqueueMiUndo(entry) {
        return appendToAutoJob(MIUNDO_SPEC, entry.appid, { ts: Date.now() });
    }

    // A rollback gestured for a swipe whose ignore has not been sent: cancel the
    // ignore instead. The entry is marked, not spliced out, because `appids`
    // indices are the cursor's coordinates. A re-swipe rewrites the meta entry,
    // which clears the mark.
    // True only if the entry was still pending; the cursor is re-read after the
    // mutation, so a lost race reports false and the caller rolls back for real.
    async function cancelMiEntry(appid) {
        appid = String(appid);
        const drained = (await getCursor(MI_JOB_ID)) || 0;
        let markedAt = -1;
        await mutateQueue((queue) => {
            const idx = queue.findIndex(j => jobType(j) === JOB_TYPE.MI);
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

    // --- drain progress -------------------------------------------------------

    async function getCursor(jobId) {
        const key = CURSOR_PREFIX + jobId;
        const v = (await get(key))[key];
        return Number.isFinite(v) ? v : null;
    }

    // Refuses (false) for a job no longer queued: removeJob is the key's only
    // cleanup, so a write after it would leak the key. No CAS, so a remove from
    // another context can still slip between the read and the write.
    // `queue`: a snapshot the caller read with no network wait since, to check
    // against instead of reading the queue again.
    async function setCursor(jobId, value, queue) {
        if (!(queue || await getQueue()).some(j => j.id === jobId)) return false;
        await set({ [CURSOR_PREFIX + jobId]: value });
        return true;
    }

    // Drop a retired job id's progress keys, for a record that lives on under a
    // new id (a filter switch) rather than through removeJob.
    async function dropProgress(jobId) {
        await remove([CURSOR_PREFIX + jobId, SKIPPED_PREFIX + jobId]);
    }

    // Entries skipped as region-locked. Same writer and guard as the cursor.
    async function bumpSkipped(jobId) {
        if (!(await getQueue()).some(j => j.id === jobId)) return false;
        const key = SKIPPED_PREFIX + jobId;
        const v = (await get(key))[key];
        await set({ [key]: (Number.isFinite(v) ? v : 0) + 1 });
        return true;
    }

    // --- pulses -----------------------------------------------------------------

    // A job finished draining (finished jobs are removed, so nothing else says so).
    async function signalCompleted() {
        await set({ [PULSE_KEY]: Date.now() });
    }

    // Games that stopped being ignored, for Manual-Ignore tabs to un-badge.
    // `reason`: 'undo' (rolled back), 'removed' (the user dropped the MI job) or
    // 'failed' (the deferred POST never landed — the only one the user is told).
    async function signalUnignored(appids, reason) {
        const list = (Array.isArray(appids) ? appids : [appids]).map(String);
        if (!list.length) return;
        await set({
            [UNIGNORE_PULSE_KEY]: { appids: list, ts: Date.now(), reason: reason || 'undo' }
        });
    }

    // A rollback that will not happen. `reason`: 'failed' raises a card,
    // 'removed' (the user dropped the job) only clears the pending marks.
    async function signalUndoFailed(reason) {
        await set({
            [UNDO_FAILED_KEY]: { ts: Date.now(), reason: reason || 'failed' }
        });
    }

    window.ILAP.Curator.Store = {
        // pure
        isFresh, evictCache, jobType, jobTraits, cappedCount,
        // cache
        getCache, putCache,
        // queue
        getQueue, mutateQueue, updateJob, removeJob, removeIfDrained,
        enqueueMi, enqueueMiUndo, cancelMiEntry,
        signalCompleted, signalUnignored, signalUndoFailed,
        // drain progress
        getCursor, setCursor, bumpSkipped, dropProgress,
        // constants
        JOB_TYPE, CACHE_KEY, QUEUE_KEY, CURSOR_PREFIX, SKIPPED_PREFIX, PULSE_KEY,
        UNIGNORE_PULSE_KEY, UNDO_FAILED_KEY, SW_SID_KEY, SW_HALT_KEY,
        CACHE_TTL, CACHE_MAX, MAX_JOBS, MI_ID, MI_JOB_ID, MI_MAX,
        MIUNDO_ID, MIUNDO_JOB_ID, MIUNDO_MAX
    };
})();
