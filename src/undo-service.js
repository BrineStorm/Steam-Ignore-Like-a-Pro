// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Headless staging for undo jobs — the "un-ignore the last X" counterpart of
    // the curator EnqueueService. An undo job is a STATIC snapshot of appids
    // taken from ilap_ignore_log at staging time: ignores performed after the
    // snapshot are newer log entries the job never sees, so a user who keeps
    // ignoring while an undo drains creates no moving target. It rides the
    // existing curator queue (same 3-job cap, lease/handoff, Pause/Remove,
    // cursor keys); the drainer branches on `type: 'undo'` to POST remove=1.
    // Store + log are injected so the outcome branching unit-tests with stubs.

    window.ILAP = window.ILAP || {};

    // Pseudo curator id — keys the drain lease (`ilap_curator_lock_undo`) and
    // can never collide with a real curator's numeric id.
    const UNDO_ID = 'undo';

    class UndoService {
        constructor({ store, log, maxJobs }) {
            this.store = store;   // curator Store (queue + cursor writers)
            this.log = log;       // IgnoreLog (getLog + pure selectors)
            this.maxJobs = maxJobs;
        }

        // Undo the last `n` extension ignores (unique appids, newest first).
        stageLastN(n) {
            return this._stage((log) => this.log.snapshotLastN(log, n));
        }

        // Undo the extension ignores of the last `windowMs` (e.g. 6 h, 2 d).
        stageSince(windowMs) {
            return this._stage((log) => this.log.snapshotSince(log, Date.now() - windowMs));
        }

        // Outcomes the UI reacts to:
        //   { kind:'added', total }  — job staged, drainer will pick it up;
        //   { kind:'empty' }         — nothing undoable in the requested scope;
        //   { kind:'exists' }        — an undo job is already queued (one at a time);
        //   { kind:'full' }          — queue at the job cap.
        async _stage(snapshot) {
            const appids = snapshot(await this.log.getLog());
            if (appids.length === 0) return { kind: 'empty' };
            const snapshotTs = Date.now();

            let outcome = null;
            await this.store.mutateQueue((queue) => {
                if (queue.some(j => j.type === 'undo')) { outcome = { kind: 'exists' }; return null; }
                if (queue.length >= this.maxJobs) { outcome = { kind: 'full' }; return null; }
                outcome = { kind: 'added', total: appids.length };
                queue.push({
                    id: 'job_undo_' + snapshotTs,
                    type: 'undo',
                    curatorId: UNDO_ID,
                    curatorName: '',
                    appids,
                    total: appids.length,
                    status: 'pending',
                    snapshotTs,          // the "last user intent wins" boundary
                    addedAt: snapshotTs
                });
                return queue;
            });
            return outcome;
        }
    }

    window.ILAP.UndoService = UndoService;
    window.ILAP.UndoService.UNDO_ID = UNDO_ID;
})();
