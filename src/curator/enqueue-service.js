// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.Curator = window.ILAP.Curator || {};

    // Headless orchestration for staging + resolving a curator ignore job. All the
    // I/O (queue store, curator enumerator) and the confirm prompt are injected, so
    // the branching that mattered — cache-vs-enumerate, the confirm threshold, the
    // mid-enumeration removal bail, the cursor reset — is unit-testable with plain
    // stubs. No DOM, no window.confirm, no window.ILAP reach-through: the curator
    // page's main.js builds this with real deps and only does DOM + wiring + toasts.
    class EnqueueService {
        constructor({ store, enumerator, maxJobs, confirmThreshold }) {
            this.store = store;
            this.enumerator = enumerator;
            this.maxJobs = maxJobs;
            this.confirmThreshold = confirmThreshold;
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
        // enumerates the curator and caches the result. `confirmFn(count)` gates a
        // large batch; honours removal mid-enumeration.
        async resolve(id, jobId, name, filter, confirmFn) {
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
                if (appids.length > this.confirmThreshold && !confirmFn(appids.length)) {
                    await Store.removeJob(jobId);
                    return;
                }
                // Fresh appid list → progress restarts. The cursor key is reset here,
                // while the job is still 'enumerating' (not drainable), so the drainer
                // can't be advancing it concurrently.
                await Store.setCursor(jobId, 0);
                await Store.updateJob(jobId, {
                    appids, total: appids.length, status: 'pending'
                });
            } catch (e) {
                // Enumeration failed — leave the job idle (0/0) so the user can remove
                // or re-add it; never auto-ignore on a half-resolved list.
                await Store.updateJob(jobId, { status: 'pending', appids: [], total: 0 });
            }
        }
    }

    window.ILAP.Curator.EnqueueService = EnqueueService;
})();
