// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.Curator = window.ILAP.Curator || {};

    // Staging and resolving a curator ignore job, with the queue store and the
    // enumerator injected. No DOM: curator/main.js does the page side.

    // A curator job older than this with no list has most likely lost its reader,
    // to a closed tab. A live reader held up by a long 429 penalty may get a second
    // one, which costs reads and no job (_settled, resolve's write).
    const ORPHAN_AGE_MS = 10 * 60 * 1000;

    class EnqueueService {
        constructor({ store, cache, enumerator, filters, maxJobs }) {
            this.store = store;
            this.cache = cache;     // curator/cache.js
            this.enumerator = enumerator;
            this.filters = filters; // curator/filters.js
            this.maxJobs = maxJobs;
        }

        // Add a job for what a pick of `filter` lacks (ILAP_Filters.filterToAdd):
        // with one review type queued, the other one goes in as a job of its own,
        // pending behind it. { kind:'added'|'full', jobId?, name?, filter? }, or
        // null when the queue covers the pick already or `filter` is none of the
        // menu's (a row's value is page-writable). `filter` is the added job's.
        async stage(id, name, filter) {
            const Filters = this.filters;
            if (!Filters.FILTERS.some(f => f.value === filter)) return null;
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
                    // The list comes with resolve(), under its own key.
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
            const Enum = this.enumerator, Store = this.store, Cache = this.cache;
            try {
                let apps;
                // A run that stopped short. The cache only ever holds complete
                // runs (below), so a cache hit is never partial.
                let partial = false;
                const cached = await Cache.get(id);
                if (cached && Cache.isFresh(cached, Date.now())) {
                    apps = cached.apps;
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
                        await Cache.put(id, { total: result.total, name, apps: result.apps });
                    }
                    apps = result.apps;
                }

                if (await this._settled(jobId)) return;

                const appids = Enum.filterAppids(apps, filter);
                // Nothing parsed (a markup change reads as 0 rows) or nothing under
                // this filter: drop the job rather than leave an empty row.
                if (appids.length === 0) {
                    await Store.removeJob(jobId);
                    return { error: true };
                }
                // A pause made while enumerating survives. The list is stored in
                // the same write (Store.getList), and the check is made again inside it.
                await Store.updateJob(jobId, (j) => (Store.hasList(j) ? null : {
                    total: appids.length,
                    status: j.status === 'paused' ? 'paused' : 'pending'
                }), appids);
                // `partial` only when it is true: the complete case keeps the
                // plain { ok: true } this has always answered with.
                return partial ? { ok: true, partial: true } : { ok: true };
            } catch (e) {
                if (await this._settled(jobId)) return;
                // Never drain a half-resolved list: drop the job, the caller reports it.
                await Store.removeJob(jobId);
                return { error: true };
            }
        }

        // No read of this one's can matter any more: the user removed the job while
        // it ran, or another tab's read got there first (adoptOrphans) and its list
        // stands, as a drainer may be walking it.
        async _settled(jobId) {
            const job = (await this.store.getQueue()).find(j => j.id === jobId);
            return !job || this.store.hasList(job);
        }

        // A curator job whose staging tab went away inside its read has no list,
        // and only resolve() gives it one. Any store tab takes such a job over.
        // `mayRead()` says whether Steam may be asked now. Resolves to each
        // resolve()'s answer.
        async adoptOrphans(mayRead) {
            const store = this.store;
            const now = Date.now();
            const orphans = (await store.getQueue()).filter(j => store.jobType(j) === store.JOB_TYPE.CURATOR
                && !store.hasList(j) && now - (j.addedAt || 0) >= ORPHAN_AGE_MS);
            if (!orphans.length || !(await mayRead())) return [];
            const answers = [];
            for (const j of orphans) {
                answers.push({ name: j.curatorName, res: await this.resolve(j.curatorId, j.id, j.curatorName, j.filter) });
            }
            return answers;
        }

        // The cross on a queued row of the curator droplist: this curator's job
        // of `filter` leaves the queue, through Store.removeJob so its progress
        // keys go with it. { kind: 'removed' }, or null when it is gone already
        // (removed from another window while the menu was open).
        async removeQueued(id, filter) {
            const jobs = this.filters.curatorJobs(await this.store.getQueue(), id)
                .filter(j => j.filter === filter);
            for (const j of jobs) await this.store.removeJob(j.id);
            return jobs.length ? { kind: 'removed' } : null;
        }
    }

    window.ILAP.Curator.EnqueueService = EnqueueService;
})();
