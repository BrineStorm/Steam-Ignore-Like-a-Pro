// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Curator storage model.
    //  - Retention cache (`ilap_curator_cache`): enumerated apps per curator, so
    //    re-adding one within a week costs no network. TTL 7 days, LRU 10.
    //  - Job queue (`ilap_curator_queue`): user-owned fields only
    //    (filter/status/appids), every write through `mutateQueue`.
    //  - Drain progress: a cursor and two skip counts per job, each in its own key
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
    const WISHLISTED_PREFIX = 'ilap_curator_wishlisted_';
    const PULSE_KEY = 'ilap_curator_pulse';
    // Games whose marks every Manual-Ignore tab drops (see signalUnignored).
    const UNIGNORE_PULSE_KEY = 'ilap_unignored';
    // A rollback that will never land. No appid: nothing on the page is wrong.
    const UNDO_FAILED_KEY = 'ilap_undo_failed';
    // The service-worker drain (src/background.js): the sessionid a store page
    // caches for it, and the flag it sets after repeated failed POSTs.
    const SW_SID_KEY = 'ilap_sw_sid';
    const SW_HALT_KEY = 'ilap_sw_halt';
    // A built-in list run to its end: `ilap_preset_done_<key>` = the list's rev
    // (data/presets.json). One key per list, so two drainers finishing two lists
    // at once never write over each other.
    const PRESET_DONE_PREFIX = 'ilap_preset_done_';
    const PRESET_ID_PREFIX = 'preset_';
    // Bundles whose job ran to its end, for the IGNORED badge on their capsules:
    // `ilap_ignored_bundles` = { '<bundle|sub>_<id>': { ts, appids } }. The
    // appids let a rollback of any of its games take the mark off.
    const IGNORED_BUNDLES_KEY = 'ilap_ignored_bundles';
    const IGNORED_BUNDLES_MAX = 300;
    const BUNDLE_KEY_RE = /^(bundle|sub)_\d+$/;

    const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
    const CACHE_MAX = 10;
    // Curator, built-in list and bundle jobs plus at most one undo job; the
    // gesture jobs sit outside it.
    const MAX_JOBS = 3;

    // Job types and the two traits the rest of the code asks about:
    //   undo    — POSTs remove=1 under the undo pass policy (strict userdata,
    //             inverted dedupe, "last user intent wins");
    //   gesture — auto-filled by a live gesture: drains first, has no curator.
    // A preset job is a built-in list (data/presets.json), drained like a curator's.
    // A bundle job is a store bundle or package staged by a gesture on its capsule.
    const JOB_TYPE = Object.freeze({
        CURATOR: 'curator', PRESET: 'preset', BUNDLE: 'bundle', UNDO: 'undo', MI: 'mi', MIUNDO: 'miundo'
    });
    const JOB_TRAITS = Object.freeze({
        [JOB_TYPE.CURATOR]: Object.freeze({ undo: false, gesture: false }),
        [JOB_TYPE.PRESET]: Object.freeze({ undo: false, gesture: false }),
        [JOB_TYPE.BUNDLE]: Object.freeze({ undo: false, gesture: false }),
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
    // MAX_JOBS. A swipe is refused while MI_MAX entries wait undrained.
    const MI_ID = 'mi';
    const MI_JOB_ID = 'job_mi';
    const MI_MAX = 200;
    // Drained entries stay in a gesture job until it empties (`appids` indices
    // are the cursor's coordinates), and every gesture rewrites the whole queue
    // record. This bounds a job that never empties, whatever has drained.
    const GESTURE_JOB_CEILING = 1000;

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
    //   QueueSettings and RunLedger).
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
    // _dispatch and its boot, curator/main.js pick and the droplist's cross,
    // the drainer's kick, ExploreAutomator.kick). Note serialChain hands the CALLER its rejection —
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
        await remove([CURSOR_PREFIX + id, SKIPPED_PREFIX + id, WISHLISTED_PREFIX + id]);
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
        if (removed) await remove([CURSOR_PREFIX + id, SKIPPED_PREFIX + id, WISHLISTED_PREFIX + id]);
        return removed;
    }

    // A built-in list job that ran to its end: its list is marked done with its
    // rev. The drainer's call only — a list the user removed was not run, so it
    // stays on offer.
    async function markPresetDone(job) {
        if (!job || !job.presetKey) return;
        await set({ [PRESET_DONE_PREFIX + job.presetKey]: job.presetRev || '' });
    }

    // The marks map, serialized within this context like the queue. Two contexts
    // finishing two bundles in the same instant can lose one mark (no CAS): the
    // bundle then shows no badge, and a swipe on it re-runs a job of dedupe skips.
    const bundleSerial = window.ILAP.serialChain();
    async function getBundleMarks() {
        const marks = (await get(IGNORED_BUNDLES_KEY))[IGNORED_BUNDLES_KEY];
        return marks && typeof marks === 'object' ? marks : {};
    }

    // A bundle job that ran to its end: its capsules get the IGNORED badge. The
    // oldest marks go past IGNORED_BUNDLES_MAX.
    function markBundleDone(job) {
        if (!job || !BUNDLE_KEY_RE.test(String(job.curatorId))) return Promise.resolve();
        return bundleSerial(async () => {
            const marks = await getBundleMarks();
            marks[job.curatorId] = { ts: Date.now(), appids: (job.appids || []).map(String) };
            const keep = Object.keys(marks).sort((a, b) => (marks[b].ts || 0) - (marks[a].ts || 0))
                .slice(0, IGNORED_BUNDLES_MAX);
            const next = {};
            for (const k of keep) next[k] = marks[k];
            await set({ [IGNORED_BUNDLES_KEY]: next });
        });
    }

    // Games rolled back: a bundle with any of them in it is no longer all ignored.
    function unmarkBundlesWith(appids) {
        const gone = new Set((appids || []).map(String));
        return bundleSerial(async () => {
            const marks = await getBundleMarks();
            const hit = Object.keys(marks).filter(k => (marks[k].appids || []).some(a => gone.has(String(a))));
            if (!hit.length) return;
            for (const k of hit) delete marks[k];
            await set({ [IGNORED_BUNDLES_KEY]: marks });
        });
    }

    // The built-in lists the menu cannot offer: queued, or done at the rev this
    // build ships. `revs` = { <key>: rev } (data/presets.json → rev). A Set of keys.
    async function blockedPresets(revs) {
        const keys = Object.keys(revs || {});
        const res = await get([QUEUE_KEY].concat(keys.map(k => PRESET_DONE_PREFIX + k)));
        const queue = Array.isArray(res[QUEUE_KEY]) ? res[QUEUE_KEY] : [];
        const queued = new Set(queue.map(j => j.curatorId));
        return new Set(keys.filter(k =>
            queued.has(PRESET_ID_PREFIX + k) || res[PRESET_DONE_PREFIX + k] === revs[k]));
    }

    // Queue a built-in list. `key` names the list ('ai_2025', 'denuvo'), `rev`
    // is its rev in this build. The list is known up front, so the job is
    // drainable at once. { kind: 'added', jobId } | { kind: 'queued' } (this
    // list is already in the queue) | { kind: 'full' } | { kind: 'empty' }.
    async function stagePreset(key, appids, rev) {
        const curatorId = PRESET_ID_PREFIX + key;
        const list = (appids || []).map(String);
        if (!list.length) return { kind: 'empty' };
        let outcome = null;
        await mutateQueue((queue) => {
            if (queue.some(j => j.curatorId === curatorId)) { outcome = { kind: 'queued' }; return null; }
            if (cappedCount(queue) >= MAX_JOBS) { outcome = { kind: 'full' }; return null; }
            const jobId = 'job_' + curatorId + '_' + Date.now();
            outcome = { kind: 'added', jobId };
            return queue.concat([{
                id: jobId,
                type: JOB_TYPE.PRESET,
                curatorId,
                presetKey: key,
                presetRev: rev || '',
                appids: list,
                total: list.length,
                status: 'pending',
                addedAt: Date.now()
            }]);
        });
        return outcome;
    }

    // Append to (or create) one of the two gesture jobs. One serialized mutation
    // is what makes a gesture landing as the drainer removes the emptied job
    // either append or recreate, never get lost. `appids` stays a plain array;
    // per-entry data lives in `meta`. Several appids go in as a whole or not at
    // all (a bundle that overflowed into the MI job).
    // Returns { kind:'added', total } or { kind:'full' }.
    async function appendToAutoJob(spec, appids, meta) {
        const adding = Array.from(new Set(appids.map(String)));
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
            const already = (appid) => current.indexOf(appid, drained) !== -1;
            const fresh = adding.filter(a => !already(a));
            // The cap counts what still waits, not what already landed. A stale
            // `drained` is low, so it errs toward full.
            const full = current.length - drained + fresh.length > spec.max
                || current.length + fresh.length > GESTURE_JOB_CEILING;
            if (fresh.length && full) return null;  // full → no-op
            const nextAppids = current.concat(fresh);
            // Meta is refreshed on a deduped gesture too: another tab may have
            // swiped the same game with the other reason, and the POST must match
            // the badge the user last saw. `meta(pending, appid)` builds it from
            // the pending entry's meta, null when there is none.
            const nextMeta = Object.assign({}, base.meta);
            for (const appid of adding) {
                nextMeta[appid] = meta(already(appid) && base.meta ? base.meta[appid] : null, appid);
            }
            const nextJob = Object.assign({}, base, { appids: nextAppids, meta: nextMeta, total: nextAppids.length });
            outcome = { kind: 'added', total: nextAppids.length };
            return idx === -1 ? queue.concat([nextJob]) : queue.map((j, i) => i === idx ? nextJob : j);
        });
        return outcome;
    }

    const MI_SPEC = { jobId: MI_JOB_ID, type: JOB_TYPE.MI, curatorId: MI_ID, max: MI_MAX };
    const MIUNDO_SPEC = {
        jobId: MIUNDO_JOB_ID, type: JOB_TYPE.MIUNDO, curatorId: MIUNDO_ID, max: MIUNDO_MAX
    };

    // A swipe: name and reason travel with the entry for the drainer to use.
    // `ts` is when the pending entry was FIRST queued, kept when another
    // gesture dedupes into it: every swipe made since is in it (cancelMiEntry).
    // A cancelled entry starts over: the swipes it held were all taken back.
    async function enqueueMi(entry) {
        return enqueueMiMany([entry]);
    }

    // Several swipes' worth at once, all in or none (a bundle with no free job
    // slot). Each entry: { appid, name?, reason?, ts? }.
    async function enqueueMiMany(entries) {
        const byId = new Map(entries.map(e => [String(e.appid), e]));
        return appendToAutoJob(MI_SPEC, Array.from(byId.keys()), (pending, appid) => {
            const entry = byId.get(appid);
            // A bundle's app that a swipe already queued keeps the swipe's entry:
            // its reason is the badge the user saw, and a game swiped on purpose
            // is not held back by the wishlist.
            if (entry.bundle && pending && !pending.cancelled) return pending;
            const meta = { name: entry.name || '', reason: entry.reason || 0 };
            const ts = pending && !pending.cancelled && Number.isFinite(pending.ts) ? pending.ts : entry.ts;
            if (Number.isFinite(ts)) meta.ts = ts;
            if (entry.bundle) meta.bundle = true;
            return meta;
        });
    }

    // Queue a bundle or package (`kind` 'bundle' | 'sub', its store `id`) with
    // the apps Steam lists in it, games and DLC: [{ appid, name? }]. Its own job
    // while a job slot is free, named after the bundle, so Pause, Remove and the
    // progress bar work as for any job. With every slot taken its apps go into
    // the MI job instead, as a whole or not at all. Merged so, it gets no
    // IGNORED badge (only a bundle job marks one, Store.markBundleDone), so a
    // later swipe on it stages it again, as a run of dedupe skips. `reason` is the gesture's,
    // kept per app in `meta` as the MI job keeps it.
    // { kind: 'added', jobId } | { kind: 'merged' } (into the MI job)
    // | { kind: 'queued' } (this bundle is already a job) | { kind: 'full' } | { kind: 'empty' }.
    async function stageBundle({ kind, id, name, apps, reason }) {
        const curatorId = kind + '_' + id;
        const byId = new Map();
        for (const a of apps || []) {
            if (/^\d+$/.test(String(a.appid)) && !byId.has(String(a.appid))) byId.set(String(a.appid), a);
        }
        if (!byId.size) return { kind: 'empty' };
        const appids = Array.from(byId.keys());
        let outcome = null;
        await mutateQueue((queue) => {
            if (queue.some(j => j.curatorId === curatorId)) { outcome = { kind: 'queued' }; return null; }
            if (cappedCount(queue) >= MAX_JOBS) return null;
            const jobId = 'job_' + curatorId + '_' + Date.now();
            outcome = { kind: 'added', jobId };
            const meta = {};
            for (const appid of appids) meta[appid] = { reason: reason || 0 };
            return queue.concat([{
                id: jobId,
                type: JOB_TYPE.BUNDLE,
                curatorId,
                curatorName: String(name || ''),
                appids,
                meta,
                total: appids.length,
                status: 'pending',
                addedAt: Date.now()
            }]);
        });
        if (outcome) return outcome;
        const ts = Date.now();
        const merged = await enqueueMiMany(appids.map(appid => ({
            appid, name: byId.get(appid).name, reason, ts, bundle: true
        })));
        return merged.kind === 'added' ? { kind: 'merged' } : merged;
    }

    // A solo un-ignore. The entry carries the gesture time: this job lives on
    // and grows, so a job-level snapshot time would be the first gesture's.
    async function enqueueMiUndo(entry) {
        const ts = Date.now();
        return appendToAutoJob(MIUNDO_SPEC, [entry.appid], () => ({ ts }));
    }

    // A rollback gestured for a swipe whose ignore has not been sent: cancel the
    // ignore instead. The entry is marked, not spliced out, because `appids`
    // indices are the cursor's coordinates. A re-swipe rewrites the meta entry,
    // which clears the mark.
    // `ts`: when the caller's own swipe was made. Only an entry that was already
    // queued then contains that swipe. One another tab queued later, for a game
    // this tab's swipe has since ignored, is still marked — it, too, predates
    // this rollback, and left pending it would land after it and re-ignore the
    // game — but reports false: this tab's own ignore was sent, so its
    // rollback must be real. An entry with no `ts` (older build) is anyone's.
    // True only if the entry contained the caller's swipe and was still pending; the
    // cursor is re-read after the mutation, so a lost race reports false and the
    // caller rolls back for real.
    async function cancelMiEntry(appid, ts) {
        appid = String(appid);
        const drained = (await getCursor(MI_JOB_ID)) || 0;
        let markedAt = -1;
        let containsSwipe = false;
        await mutateQueue((queue) => {
            const idx = queue.findIndex(j => jobType(j) === JOB_TYPE.MI);
            if (idx === -1) return null;
            const job = queue[idx];
            const at = (job.appids || []).indexOf(appid, drained);
            if (at === -1) return null;
            const current = (job.meta || {})[appid];
            containsSwipe = !(current && Number.isFinite(current.ts))
                || (Number.isFinite(ts) && current.ts <= ts);
            markedAt = at;
            const entry = Object.assign({}, current, { cancelled: true });
            const nextJob = Object.assign({}, job, {
                meta: Object.assign({}, job.meta, { [appid]: entry })
            });
            return queue.map((j, i) => i === idx ? nextJob : j);
        });
        if (markedAt === -1 || !containsSwipe) return false;
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

    // A per-job skip count. Same writer and guard as the cursor.
    async function bumpCounter(prefix, jobId) {
        if (!(await getQueue()).some(j => j.id === jobId)) return false;
        const key = prefix + jobId;
        const v = (await get(key))[key];
        await set({ [key]: (Number.isFinite(v) ? v : 0) + 1 });
        return true;
    }
    // Entries skipped as region-locked.
    const bumpSkipped = (jobId) => bumpCounter(SKIPPED_PREFIX, jobId);
    // Entries skipped because the game is on the user's wishlist.
    const bumpWishlisted = (jobId) => bumpCounter(WISHLISTED_PREFIX, jobId);

    // --- pulses -----------------------------------------------------------------

    // A job finished draining (finished jobs are removed, so nothing else says so).
    async function signalCompleted() {
        await set({ [PULSE_KEY]: Date.now() });
    }

    // Games whose Manual-Ignore marks are wrong now, for the tabs to drop them.
    // `reason`: 'undo' (rolled back: off the list), 'removed' (the user dropped
    // the MI job) or 'failed' (the deferred POST never landed — the only one the
    // user is told).
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
        enqueueMi, enqueueMiMany, enqueueMiUndo, cancelMiEntry, stagePreset, stageBundle,
        markPresetDone, blockedPresets, getBundleMarks, markBundleDone, unmarkBundlesWith,
        signalCompleted, signalUnignored, signalUndoFailed,
        // drain progress
        getCursor, setCursor, bumpSkipped, bumpWishlisted,
        // constants
        JOB_TYPE, CACHE_KEY, QUEUE_KEY, CURSOR_PREFIX, SKIPPED_PREFIX, WISHLISTED_PREFIX, PULSE_KEY,
        UNIGNORE_PULSE_KEY, UNDO_FAILED_KEY, SW_SID_KEY, SW_HALT_KEY,
        PRESET_DONE_PREFIX, IGNORED_BUNDLES_KEY, BUNDLE_KEY_RE,
        CACHE_TTL, CACHE_MAX, MAX_JOBS, MI_ID, MI_JOB_ID, MI_MAX,
        MIUNDO_ID, MIUNDO_JOB_ID, MIUNDO_MAX, GESTURE_JOB_CEILING
    };
})();
