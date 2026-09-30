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

        // Add a job, or re-target this curator's job to another filter.
        // { kind:'added'|'switched'|'full', jobId?, name?, paused? }, or null when
        // the job already has this filter. `paused` (switched only): the job was
        // paused, and resolve() is to keep it so.
        async stage(id, name, url, filter) {
            let outcome = null;
            let retired = null;
            await this.store.mutateQueue((queue) => {
                const idx = queue.findIndex(j => j.curatorId === id);

                if (idx >= 0) {
                    const prev = queue[idx];
                    if (prev.filter === filter) return null; // already this type — no-op
                    // A new filter is a new appid set: re-resolve from scratch, under
                    // a NEW id. A drainer mid-iteration on the old list then finds
                    // its job gone and stops; with the id kept it would POST an entry
                    // of the old list and write its cursor over the new list's 0.
                    // The drainer's dedupe skips what is already ignored.
                    const jobId = 'job_' + id + '_' + Date.now();
                    retired = prev.id;
                    outcome = {
                        kind: 'switched', jobId, name: prev.curatorName,
                        paused: prev.status === 'paused'
                    };
                    queue[idx] = Object.assign({}, prev, {
                        id: jobId, filter, status: 'enumerating', appids: [], total: 0
                    });
                    return queue;
                }

                if (this.store.cappedCount(queue) >= this.maxJobs) { outcome = { kind: 'full' }; return null; }
                const jobId = 'job_' + id + '_' + Date.now();
                outcome = { kind: 'added', jobId, name };
                queue.push({
                    id: jobId,
                    type: this.store.JOB_TYPE.CURATOR,
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
            // The old list's cursor and skip count, which would otherwise outlive it.
            if (retired) await this.store.dropProgress(retired);
            return outcome;
        }

        // Fill a staged job's appids (from the retention cache when fresh) and make
        // it drainable. { ok:true }; { error:true } when no list could be built and
        // the job was dropped; undefined when the user removed it meanwhile.
        // `keepPaused`: stage() switched a paused job, which stays paused.
        async resolve(id, jobId, name, filter, keepPaused) {
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
                // A new list restarts progress. Safe here: this id has had no list
                // until now (a switch takes a new id), so no drainer has advanced
                // its cursor.
                await Store.setCursor(jobId, 0);
                // A pause survives: one made while enumerating, or one the job
                // carried into a filter switch.
                await Store.updateJob(jobId, (j) => ({
                    appids, total: appids.length,
                    status: (j.status === 'paused' || keepPaused) ? 'paused' : 'pending'
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

        // --- the curator droplist's job actions ------------------------------
        // The applet's Pause/Remove, keyed by curatorId (the page knows its curator,
        // not the job). A stale menu is a null no-op: the job is re-read.

        // paused ↔ pending. { kind: 'paused' | 'resumed' }, or null with no job.
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

        // Through Store.removeJob, so the job's progress keys go with it.
        // { kind: 'removed' }, or null with no job.
        async remove(id) {
            const job = (await this.store.getQueue()).find(j => j.curatorId === id);
            if (!job) return null;
            await this.store.removeJob(job.id);
            return { kind: 'removed' };
        }
    }

    window.ILAP.Curator.EnqueueService = EnqueueService;
})();
