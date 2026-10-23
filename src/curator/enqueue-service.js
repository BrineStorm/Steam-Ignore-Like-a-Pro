// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.Curator = window.ILAP.Curator || {};

    // Staging and resolving a curator ignore job, with the queue store and the
    // enumerator injected. No DOM: curator/main.js does the page side.
    class EnqueueService {
        constructor({ store, enumerator, maxJobs }) {
            this.store = store;
            this.enumerator = enumerator;
            this.maxJobs = maxJobs;
        }

        // Add a job for what a pick of `filter` lacks (ILAP_Filters.filterToAdd):
        // with one review type queued, the other one goes in as a job of its own,
        // pending behind it. { kind:'added'|'full', jobId?, name?, filter? }, or
        // null when the queue covers the pick already. `filter` is the added job's.
        async stage(id, name, filter) {
            const Filters = window.ILAP_Filters;
            let outcome = null;
            await this.store.mutateQueue((queue) => {
                const adding = Filters.filterToAdd(Filters.coveredTypes(queue, id), filter);
                if (!adding) return null;
                if (this.store.cappedCount(queue) >= this.maxJobs) { outcome = { kind: 'full' }; return null; }
                const jobId = 'job_' + id + '_' + Date.now();
                outcome = { kind: 'added', jobId, name, filter: adding };
                queue.push({
                    id: jobId,
                    type: this.store.JOB_TYPE.CURATOR,
                    curatorId: id,
                    curatorName: name,
                    filter: adding,
                    appids: [],   // resolved by resolve()
                    total: 0,     // drain progress lives in the per-job cursor key
                    status: 'enumerating',
                    addedAt: Date.now()
                });
                return queue;
            });
            return outcome;
        }

        // Fill a staged job's appids (from the retention cache when fresh) and make
        // it drainable. { ok:true }; { error:true } when no list could be built and
        // the job was dropped; undefined when the user removed it meanwhile.
        async resolve(id, jobId, name, filter) {
            const Enum = this.enumerator, Store = this.store;
            try {
                let apps;
                // A run that stopped short. The cache only ever holds complete
                // runs (below), so a cache hit is never partial.
                let partial = false;
                const cache = await Store.getCache(id);
                if (cache && Store.isFresh(cache, Date.now())) {
                    apps = cache.apps;
                } else {
                    const result = await Enum.enumerate(id);
                    partial = !!result.partial;
                    // A run that failed part-way is NOT cached: the retention
                    // cache is keyed by curator alone, so a truncated list would
                    // be served for the whole TTL and every re-add within it
                    // would silently inherit the same short job. The job at hand
                    // still runs on what was read — the user asked for it, and a
                    // partial pass is what the next enumeration will finish.
                    if (!result.partial) {
                        await Store.putCache(id, { total: result.total, name, apps: result.apps });
                    }
                    apps = result.apps;
                }

                // Bail if the user removed the job while we were enumerating.
                if (!(await Store.getQueue()).some(j => j.id === jobId)) return;

                const appids = Enum.filterAppids(apps, filter);
                // Nothing parsed (a markup change reads as 0 rows) or nothing under
                // this filter: drop the job rather than leave an empty row.
                if (appids.length === 0) {
                    await Store.removeJob(jobId);
                    return { error: true };
                }
                // A new list starts at 0. Safe here: this id has had no list until
                // now, so no drainer has advanced its cursor.
                await Store.setCursor(jobId, 0);
                // A pause made while enumerating survives.
                await Store.updateJob(jobId, (j) => ({
                    appids, total: appids.length,
                    status: j.status === 'paused' ? 'paused' : 'pending'
                }));
                // `partial` only when it is true: the complete case keeps the
                // plain { ok: true } this has always answered with.
                return partial ? { ok: true, partial: true } : { ok: true };
            } catch (e) {
                // Never drain a half-resolved list: drop the job, the caller reports it.
                await Store.removeJob(jobId);
                return { error: true };
            }
        }

        // The cross on a queued row of the curator droplist: this curator's job
        // of `filter` leaves the queue, through Store.removeJob so its progress
        // keys go with it. { kind: 'removed' }, or null when it is gone already
        // (removed from another window while the menu was open).
        async removeQueued(id, filter) {
            const jobs = window.ILAP_Filters.curatorJobs(await this.store.getQueue(), id)
                .filter(j => j.filter === filter);
            for (const j of jobs) await this.store.removeJob(j.id);
            return jobs.length ? { kind: 'removed' } : null;
        }
    }

    window.ILAP.Curator.EnqueueService = EnqueueService;
})();
