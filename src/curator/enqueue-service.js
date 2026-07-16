// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.Curator = window.ILAP.Curator || {};

    // Headless orchestration for staging + resolving a curator ignore job. All the
    // I/O (queue store, curator enumerator) is injected, so the branching that
    // mattered — cache-vs-enumerate, the mid-enumeration removal bail, the cursor
    // reset — is unit-testable with plain stubs. No DOM, no window.ILAP
    // reach-through: the curator page's main.js builds this with real deps and only
    // does DOM + wiring + toasts.
    class EnqueueService {
        constructor({ store, enumerator, maxJobs }) {
            this.store = store;
            this.enumerator = enumerator;
            this.maxJobs = maxJobs;
        }

        // Stage (or re-target) a job in the queue via the serialized RMW so a click
        // can't interleave with the drainer's or the applet's writes. Returns the
        // outcome the UI reacts to: { kind:'added'|'switched'|'full', jobId?, name? }
        // (or null for an already-this-filter no-op).
        async stage(id, name, url, filter) {
            let outcome = null;
            await this.store.mutateQueue((queue) => {
                const idx = queue.findIndex(j => j.curatorId === id);

                if (idx >= 0) {
                    if (queue[idx].filter === filter) return null; // already this type — no-op
                    // Switching filter changes the appid set, so re-resolve from
                    // scratch; already-ignored games are skipped instantly by the
                    // drainer's userdata dedupe, so progress isn't really lost.
                    outcome = { kind: 'switched', jobId: queue[idx].id, name: queue[idx].curatorName };
                    queue[idx] = Object.assign({}, queue[idx], {
                        filter, status: 'enumerating', appids: [], total: 0
                    });
                    return queue;
                }

                if (queue.length >= this.maxJobs) { outcome = { kind: 'full' }; return null; }
                const jobId = 'job_' + id + '_' + Date.now();
                outcome = { kind: 'added', jobId, name };
                queue.push({
                    id: jobId,
                    curatorId: id,
                    curatorName: name,
                    curatorUrl: url,
                    filter,
                    appids: [],   // resolved by resolve()
                    total: 0,     // drain progress lives in the per-job cursor key
                    status: 'enumerating',
                    addedAt: Date.now()
                });
                return queue;
            });
            return outcome;
        }

        // Resolve a staged job's appids and flip it to `pending` so the drainer can
        // start. Uses the 7-day retention cache when fresh (0 network), otherwise
        // enumerates the curator and caches the result. Honours removal
        // mid-enumeration. Returns the outcome the UI reacts to: { ok:true } on
        // success, { error:true } when no drainable list could be built (enumeration
        // failed, or nothing matched the filter), undefined when the user themselves
        // removed the job while it was enumerating.
        async resolve(id, jobId, name, filter) {
            const Enum = this.enumerator, Store = this.store;
            try {
                let apps;
                const cache = await Store.getCache(id);
                if (cache && Store.isFresh(cache, Date.now())) {
                    apps = cache.apps;
                } else {
                    const result = await Enum.enumerate(id);
                    await Store.putCache(id, { total: result.total, name, apps: result.apps });
                    apps = result.apps;
                }

                // Bail if the user removed the job while we were enumerating.
                if (!(await Store.getQueue()).some(j => j.id === jobId)) return;

                const appids = Enum.filterAppids(apps, filter);
                // An empty list means the enumeration parsed nothing (a Steam markup
                // change silently yields 0 rows) or the curator has no games under
                // this filter. Either way there's nothing to drain: drop the job so
                // it doesn't sit as an invisible "pending 0/—" forever, and report it.
                if (appids.length === 0) {
                    await Store.removeJob(jobId);
                    return { error: true };
                }
                // Fresh appid list → progress restarts. The cursor key is reset here,
                // while the job is still 'enumerating' (not drainable), so the drainer
                // can't be advancing it concurrently.
                await Store.setCursor(jobId, 0);
                // Function patch: the droplist/applet Pause is live while the job is
                // still 'enumerating', so a pause landed mid-enumeration must survive
                // — a blind status:'pending' here would silently clobber it.
                await Store.updateJob(jobId, (j) => ({
                    appids, total: appids.length,
                    status: j.status === 'paused' ? 'paused' : 'pending'
                }));
                return { ok: true };
            } catch (e) {
                // Enumeration failed (network/parse/timeout) — never auto-ignore on a
                // half-resolved list. Drop the job rather than leaving it idle at 0/0
                // (an invisible dead row) and let the caller surface the failure.
                await Store.removeJob(jobId);
                return { error: true };
            }
        }

        // --- post-add droplist actions ---------------------------------------
        // Curator-page parity with the queue applet's Pause/Remove row buttons
        // (ui/popup_queue.js). Keyed by curatorId — the button knows the page's
        // curator, not the job id — and routed through the SAME serialized Store
        // writers the applet uses, so this is a second caller, not a second
        // implementation. Both re-read the job inside the mutation, so a stale
        // menu (the job changed or vanished from another window while the
        // droplist was open) degrades to a null no-op instead of acting blind.

        // Flip the queued job's pause intent (paused ↔ pending — 'running' is
        // never stored; it's derived from the live drain lease). Returns
        // { kind: 'paused' | 'resumed' }, or null when no job is queued.
        async togglePause(id) {
            let outcome = null;
            await this.store.mutateQueue((queue) => {
                const idx = queue.findIndex(j => j.curatorId === id);
                if (idx < 0) return null;
                const resuming = queue[idx].status === 'paused';
                outcome = { kind: resuming ? 'resumed' : 'paused' };
                queue[idx] = Object.assign({}, queue[idx], { status: resuming ? 'pending' : 'paused' });
                return queue;
            });
            return outcome;
        }

        // Drop the queued job. Goes through Store.removeJob (not a raw queue
        // filter) so the per-job cursor key dies with the job. Returns
        // { kind: 'removed' }, or null when no job is queued.
        async remove(id) {
            const job = (await this.store.getQueue()).find(j => j.curatorId === id);
            if (!job) return null;
            await this.store.removeJob(job.id);
            return { kind: 'removed' };
        }
    }

    window.ILAP.Curator.EnqueueService = EnqueueService;
})();
