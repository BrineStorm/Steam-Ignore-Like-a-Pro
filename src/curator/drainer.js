// SPDX-License-Identifier: GPL-3.0-or-later
//
// DISCLAIMER: This drainer issues bulk ignore actions to Steam on the user's
// behalf. Provided "as is", without warranty. Use at your own risk; you are
// responsible for your own account and for respecting Steam's Terms of Service.
(function() {
    'use strict';

    // Curator queue drainer. Runs in every store tab and, on Chromium, in the
    // service worker (src/background.js); all of them share one lease/handoff
    // protocol. With an empty queue it is idle after the boot read.
    //
    // Safety contract:
    //  - one POST at a time, each after a slot from the shared rate gate;
    //  - exactly one drainer per job (per-job lease + handoff);
    //  - the cursor moves only past a confirmed POST, a dedupe skip or a drop,
    //    so an interrupted POST is retried at most once, and the dedupe against
    //    dynamicstore/userdata makes that retry harmless.

    window.ILAP = window.ILAP || {};
    window.ILAP.Curator = window.ILAP.Curator || {};

    const REASON = 0;              // same as a manual default ignore
    const HEARTBEAT_MS = 3000;     // renew the lease well within its 8 s TTL
    const MAX_FAILS = 3;           // give up on a single appid after N failed POSTs
    const RETRY_TICK_MS = 9000;    // standby poll: steal an expired lease / pick up work
    // A failed POST the login probe blames on the session parks this drainer,
    // so the standby tick cannot turn a dead session into a retry loop.
    const DEAD_SESSION_PARK_MS = 60000;
    // userdata lags a fresh ignore, and a remove=1, by seconds (steam-net.js).
    // An undo job does not trust "not in the set" for a game ignored this
    // recently; it POSTs remove=1 instead. The same lag keeps a read this soon
    // after any POST out of the total, and makes an ignore entry distrust "on
    // the list" for a game rolled back since this long before the read
    // (_readPredatesUndo).
    const USERDATA_LAG_MS = window.ILAP.SteamNet.USERDATA_LAG_MS;
    // Floor between two passes that reach the network: each costs a userdata GET
    // the gate does not pace. Kicks inside it are deferred, never dropped.
    const MIN_PASS_GAP_MS = 2000;
    // How long the oldest pending swipe may wait behind a curator or droplist-undo
    // pass before the pass steps aside for it (_preemptedBy). Each hand-off costs
    // two userdata GETs (the swipe pass, then the resumed one), so at most two
    // per this long.
    const SWIPE_WAIT_MS = 30000;

    // An MI entry carries its swipe's reason (0 Default, 2 Played Elsewhere).
    const miReason = (meta) => (meta && Number.isFinite(meta.reason) ? meta.reason : REASON);

    // What each job type does where the loop POSTs, lands or drops an entry.
    // Lease, cursor, gate and retries are shared. `entry` is _entryAt's;
    // `ignored` the pass's userdata, appid -> reason.
    //   satisfied(ignored, entry)         already as the entry wants it: no POST (dedupe)
    //   staleRead(d, entry, readAt)       the read may predate the change `satisfied`
    //                                     would undo, so it is not trusted for a dedupe
    //   onDeduped(d, entry)               what a dedupe skip records
    //   superseded(d, entry)              a later user intent replaced it: skipped
    //   landedReason(entry)               the game's reason once the POST lands, null = not ignored
    //   post(d, entry)                    the POST for one entry
    //   onLanded(d, job, entry, prev)     Steam accepted it; runs before the cursor moves.
    //                                     `prev`: the reason before it, null = was not ignored
    //   droppedLogEntry(job, appid, meta) the log record of a drop, or null
    //   onDropped(d, appid)               what the tabs are told about a drop
    //   cancellable                       entries can be taken back before their POST

    // An ignore distrusts "on the list" for a game rolled back shortly before
    // the read: userdata lags a remove=1 as it lags an ignore.
    const ignoreReadIsStale = (d, e, readAt) => d._readPredatesUndo(e.appid, readAt);

    // Both rollbacks, the droplist undo and the solo un-ignore (gesture, badge
    // click): the game comes off the list.
    const UNDO_POLICY = {
        satisfied: (ignored, e) => !ignored.has(e.appid),
        // "Not on the list" is not trusted for an ignore too fresh to show.
        staleRead: async (d, e) => Date.now() - (await d.log.lastIgnoredAt(e.appid)) < USERDATA_LAG_MS,
        // Marked undone, so a stale entry can't keep eating later undo budgets.
        onDeduped: (d, e) => d.log.markUndone(e.appid, e.entryTs),
        // Re-ignored after the rollback was asked for: the later intent wins.
        superseded: (d, e) => d.log.wasReIgnoredAfter(e.appid, e.entryTs),
        landedReason: () => null,
        post: (d, e) => d.api.unignore(e.appid),
        async onLanded(d, job, e) {
            await d.log.markUndone(e.appid, e.entryTs);
            // Only on a landed POST: a dedupe skip rolled nothing back.
            await d.stats.dropCount();
            await d.store.signalUnignored(e.appid);
        },
        // A failed rollback stays undoable, so it leaves no skipped record.
        droppedLogEntry: () => null,
        // Nothing to un-badge (the game stays ignored); the user is told instead.
        async onDropped(d) {
            await d.store.signalUndoFailed('failed');
        },
        cancellable: false,
    };

    const CURATOR_POLICY = {
        // Any reason will do: a curator list never overrides the user's own.
        satisfied: (ignored, e) => ignored.has(e.appid),
        staleRead: ignoreReadIsStale,
        onDeduped: async () => {},
        superseded: async () => false,
        landedReason: () => REASON,
        post: (d, e) => d.api.ignore(e.appid, REASON),
        async onLanded(d, job, e) {
            await d.log.append({ appid: e.appid, source: 'curator', curatorId: job.curatorId });
            await d.stats.bumpCount();
        },
        droppedLogEntry: (job, appid) => ({ appid, source: 'curator', curatorId: job.curatorId }),
        async onDropped() {},
        cancellable: false,
    };

    const MI_POLICY = {
        // A swipe sets its reason: on the list with the other one, Steam takes
        // the same POST as a change of reason (verified live, both ways).
        satisfied: (ignored, e) => ignored.get(e.appid) === miReason(e.meta),
        staleRead: ignoreReadIsStale,
        onDeduped: async () => {},
        superseded: async () => false,
        landedReason: (e) => miReason(e.meta),
        post: (d, e) => d.api.ignore(e.appid, miReason(e.meta)),
        // Counted and logged only now that the POST landed. A change of reason
        // is shown but neither counted (the list did not grow) nor logged: Undo
        // takes games off the list and has nothing to do with it. `prev` is null
        // whenever the read cannot be trusted for it — a failed read, or one that
        // may predate a rollback of the game — so a re-ignore never passes for a
        // change; a real change of reason then lands as a plain ignore, counted
        // and undoable.
        async onLanded(d, job, e, prev) {
            const name = e.meta ? e.meta.name : '';
            if (prev !== null) {
                await d.stats.saveHistory(name, miReason(e.meta));
                return;
            }
            await d.stats.save(name, miReason(e.meta));
            await d.log.append({ appid: e.appid, name, source: 'mi' });
        },
        droppedLogEntry: (job, appid, meta) => ({ appid, name: meta ? meta.name : '', source: 'mi' }),
        // The swipe's optimistic badge now lies: drop it, and say why.
        async onDropped(d, appid) {
            await d.store.signalUnignored(appid, 'failed');
        },
        cancellable: true,
    };

    // What a POST's result means for the entry (_handleResult): LANDED or DROPPED
    // move on, RETRY sends the same entry again, STOP ends the pass with the
    // cursor kept. _drainJob returns STOP, or nothing when the job left the pass.
    const VERDICT = Object.freeze({ LANDED: 'landed', DROPPED: 'dropped', RETRY: 'retry', STOP: 'stop' });

    const policiesFor = (T) => Object.freeze({
        [T.CURATOR]: CURATOR_POLICY,
        [T.MI]: MI_POLICY,
        [T.UNDO]: UNDO_POLICY,
        [T.MIUNDO]: UNDO_POLICY,
    });

    // Meant to run and carries a list. 'paused' is user intent, 'enumerating' a
    // filter switch re-resolving the list; 'running' is a legacy stored value.
    const liveStatus = (j) => j.status === 'running' || j.status === 'pending';
    const runnable = (j) => liveStatus(j) && Array.isArray(j.appids);

    const isFn = (f) => typeof f === 'function';
    const hasFns = (obj, names) => !!obj && names.every(n => isFn(obj[n]));

    // Every dependency is required: a missing gate, probe or log would not fail,
    // it would silently switch a safety check or a record off.
    function checkDeps(deps) {
        const need = (ok, what) => {
            if (!ok) throw new TypeError(`[ILAP] CuratorQueueDrainer needs deps.${what}`);
        };
        need(isFn(deps.probeLogin), 'probeLogin');
        need(!!deps.ownerId, 'ownerId');
        need(!!deps.store, 'store');
        need(hasFns(deps.lease, ['acquireLock', 'renewLock', 'holdsLock', 'releaseLock']), 'lease');
        need(hasFns(deps.api, ['ignore', 'unignore']), 'api');
        need(hasFns(deps.gate, ['reserve', 'reportRateLimited', 'stopped', 'lastSlotAt']), 'gate');
        need(isFn(deps.fetchUserdata), 'fetchUserdata');
        need(hasFns(deps.log, ['append', 'markUndone', 'lastIgnoredAt', 'lastUndoneAt', 'wasReIgnoredAfter']), 'log');
        need(hasFns(deps.stats, ['save', 'saveHistory', 'bumpCount', 'dropCount', 'recordTotal']), 'stats');
    }

    class CuratorQueueDrainer {
        constructor(deps) {
            checkDeps(deps);
            this.store = deps.store;
            this.lease = deps.lease;
            this.api = deps.api;                       // { ignore(appid, reason), unignore(appid) }
            this.gate = deps.gate;                     // { reserve(), reportRateLimited(ms), stopped(), lastSlotAt() }
            // Called, not captured: checkDeps only asks that `stopped` IS a
            // function, so a host handing over an object's method (rather than
            // the arrow both hosts pass today) would lose its receiver and throw
            // on the first stop check — the one call that decides whether a pass
            // may send at all.
            this.stopped = () => this.gate.stopped();
            this.fetchUserdata = deps.fetchUserdata;   // () => Promise<Map<appid, reason>|null>, strict
            this.probeLogin = deps.probeLogin;         // () => Promise<true|false|null>
            this.log = deps.log;                       // IgnoreLog.drainerHooks()
            // The popup's numbers, one write chain per host:
            //   save(name, reason)         MI ignores only: counted + Last Ignored
            //   saveHistory(name, reason)  MI changes of reason: shown, not counted
            //   bumpCount()                curator ignores, total only
            //   dropCount()                confirmed rollbacks, total only
            //   recordTotal(size)          Steam's ignore-list size from the pass's read
            this.stats = deps.stats;
            this.ownerId = deps.ownerId;               // this host's lease identity
            this.policies = policiesFor(this.store.JOB_TYPE);
            // 0 disables the standby interval: the SW retries with an alarm.
            this.standbyMs = deps.standbyMs === undefined ? RETRY_TICK_MS : deps.standbyMs;
            // How a pass deferred by MIN_PASS_GAP_MS re-enters its host.
            this.rekick = deps.rekick || (() => this.kick());
            this.draining = false;
            this._timer = null;
            // -Infinity so a fake clock at 0 isn't read as "a pass just ran".
            this._lastWorkAt = -Infinity;
            this._rekickTimer = null;
            // In memory: a re-login always comes with a fresh page and drainer.
            this._parkedUntil = 0;
        }

        // The host decides what wakes a pass: its storage listener calls this
        // (the tab host below, background.js). The standby interval is armed by
        // drain() only while a job exists.
        kick() { this.drain().catch(() => {}); }

        _policyOf(job) { return this.policies[this.store.jobType(job)]; }

        // Re-run a kick the pass gap swallowed; one timer answers for all of them.
        _armRekick(ms) {
            if (this._rekickTimer) return;
            this._rekickTimer = setTimeout(() => { this._rekickTimer = null; this.rekick(); }, ms);
        }

        // Standby retry: steals a lease orphaned by a closed holder and retries a
        // gate-stopped pass. Ticks only while a job exists.
        _syncStandbyTimer(hasWork) {
            if (!this.standbyMs) return;
            if (hasWork && !this._timer) {
                this._timer = setInterval(() => this.kick(), this.standbyMs);
            } else if (!hasWork && this._timer) {
                clearInterval(this._timer);
                this._timer = null;
            }
        }

        // Gesture jobs first: they are live user actions. Of the two, the rollback
        // first: it is the later intent, and it is the one whose wait shows (a
        // dimmed badge). A pass runs its job to the end, so `_preemptedBy` is what
        // makes this priority reach a gesture made mid-drain.
        async _pickJob(queue) {
            const ready = [];
            for (const j of queue) if (await this._drainable(j)) ready.push(j);
            const { JOB_TYPE, jobType, jobTraits } = this.store;
            return ready.find(j => jobType(j) === JOB_TYPE.MIUNDO)
                || ready.find(j => jobTraits(j).gesture)
                || ready[0] || null;
        }

        // Progress lives in the cursor key; the record's `cursor` field is a
        // legacy value from before that key existed.
        async _cursorOf(job) {
            const keyCursor = await this.store.getCursor(job.id);
            return keyCursor != null ? keyCursor : (job.cursor || 0);
        }

        // Meant to run, of a known type, and something left to do.
        async _drainable(job) {
            return !!this.store.jobTraits(job) && runnable(job)
                && (await this._cursorOf(job)) < job.appids.length;
        }

        // A gesture made mid-pass ends the pass, so the next one picks it; this
        // job resumes from its cursor afterwards. A solo un-ignore preempts at
        // once. A swipe preempts a curator or droplist-undo pass only once it has
        // waited SWIPE_WAIT_MS: its badge is already painted, and each hand-off
        // costs userdata GETs. Without the hand-off, on a host with no other
        // drainer free (Firefox with one store tab), a swipe would wait out the
        // whole pass, which the swiping itself slows to ACTIVE_GAP.
        async _preemptedBy(queue, job) {
            const { JOB_TYPE, jobType, jobTraits } = this.store;
            if (jobType(job) === JOB_TYPE.MIUNDO) return false;
            const rollback = queue.find(j => jobType(j) === JOB_TYPE.MIUNDO);
            if (rollback && await this._drainable(rollback)) return true;
            if (jobTraits(job).gesture) return false;
            const swipes = queue.find(j => jobType(j) === JOB_TYPE.MI);
            return !!swipes && await this._waitedTooLong(swipes);
        }

        // Has the oldest undrained entry of this gesture job been queued for
        // SWIPE_WAIT_MS? Its meta `ts` is when that entry was first queued; a
        // record without one counts from the job's `addedAt`. Cancelled entries
        // are passed over: they send nothing, so handing over for one would cost
        // a userdata GET for no POST.
        async _waitedTooLong(job) {
            if (!(await this._drainable(job))) return false;
            const metas = job.meta || {};
            for (let i = await this._cursorOf(job); i < job.appids.length; i++) {
                const meta = metas[String(job.appids[i])];
                if (meta && meta.cancelled) continue;
                const since = meta && Number.isFinite(meta.ts) ? meta.ts : (job.addedAt || 0);
                return Date.now() - since >= SWIPE_WAIT_MS;
            }
            return false;
        }

        // For host schedulers (the SW's alarm): is there a job to pick up?
        async hasDrainableWork(queue) {
            return !!(await this._pickJob(queue));
        }

        // A live job whose cursor already sits at the end: a pass died between its
        // last cursor write and the removal. The picker skips it, so the pass that
        // finds nothing to drain removes it.
        // Returns how many it removed, so the caller can re-sync the standby
        // timer against a queue this just emptied instead of leaving it armed
        // for one more tick.
        async _collectDrained(queue) {
            let removed = 0;
            for (const j of queue) {
                if (!runnable(j) || !this.store.jobTraits(j)) continue;
                const cursor = await this._cursorOf(j);
                if (cursor < j.appids.length) continue;
                if (await this.store.removeIfDrained(j.id, cursor)) {
                    await this.store.signalCompleted();
                    removed += 1;
                }
            }
            return removed;
        }

        // A cancel that landed while the POST was in flight was told it cancelled
        // (the cursor had not moved yet), but the ignore did land. Checked after
        // the cursor moved, so later cancels are refused; the correction is a real
        // rollback with the gesture's own time. Not where the POST only
        // changed a reason (`prev`): the game was on the list before the swipe,
        // and nothing rolls a change of reason back.
        async _compensateCancelled(job, appid, prev) {
            if (prev !== null) return;
            const after = (await this.store.getQueue()).find(j => j.id === job.id);
            const meta = after && after.meta ? after.meta[appid] : null;
            if (meta && meta.cancelled) await this.store.enqueueMiUndo({ appid });
        }

        // Step over an entry that will never be performed. `why`: 'unavailable'
        // (region-locked, counted in the job row's skip line) or 'failed' (every
        // retry refused). The log record is the one trace a drop leaves;
        // `skipped` keeps it out of every undo. The caller moves the cursor.
        async _dropEntry(cur, appid, meta, why) {
            const policy = this._policyOf(cur);
            if (why === 'unavailable') await this.store.bumpSkipped(cur.id);
            const entry = policy.droppedLogEntry(cur, appid, meta);
            if (entry) await this.log.append(Object.assign(entry, { skipped: why }));
            await policy.onDropped(this, appid);
        }

        // Resolving does not mean a pass ran: not while one is running, while
        // parked, or inside MIN_PASS_GAP_MS (that kick returns through `rekick`).
        async drain() {
            if (this.draining || Date.now() < this._parkedUntil) return;
            const wait = MIN_PASS_GAP_MS - (Date.now() - this._lastWorkAt);
            if (wait > 0) { this._armRekick(wait); return; }
            this.draining = true;
            try {
                while (true) {
                    const queue = await this.store.getQueue();
                    this._syncStandbyTimer(queue.length > 0);
                    const job = await this._pickJob(queue);
                    if (!job) {
                        // The standby timer above was synced against the queue as
                        // it was READ; a job collected here is one it does not
                        // know about yet, and the interval would idle-kick once
                        // more before noticing.
                        if (await this._collectDrained(queue)) {
                            this._syncStandbyTimer((await this.store.getQueue()).length > 0);
                        }
                        break;
                    }
                    // The gate's stop verdict, asked before the lease and the
                    // userdata GET. Re-enabling the master kicks via onChanged;
                    // other stops are re-asked by the standby tick or SW alarm.
                    if (await this.stopped()) break;
                    const got = await this.lease.acquireLock(job.curatorId, this.ownerId);
                    if (!got) break;   // another drainer owns this job → stay standby
                    this._lastWorkAt = Date.now();
                    let result;
                    try {
                        result = await this._drainJob(job);
                    } finally {
                        await this.lease.releaseLock(job.curatorId, this.ownerId);
                    }
                    // Still drainable, so re-picking would busy-loop: wait for a kick.
                    if (result === VERDICT.STOP) break;
                }
            } finally {
                this.draining = false;
            }
        }

        // One entry of `cur` at `cursor`, with what the loop decides by.
        _entryAt(cur, cursor) {
            const appid = String(cur.appids[cursor]);
            const meta = cur.meta ? cur.meta[appid] : null;
            return {
                appid, meta,
                policy: this._policyOf(cur),
                isUndo: this.store.jobTraits(cur).undo,
                // "Last user intent wins" boundary: the droplist undo job's static
                // snapshot, or a solo gesture's own time.
                entryTs: (meta && meta.ts) || cur.snapshotTs || 0,
            };
        }

        // Why this entry needs no POST, or null.
        async _skipReason(entry, ignored, readAt) {
            const { meta, policy } = entry;
            // Taken back before it was sent (Store.cancelMiEntry).
            if (policy.cancellable && meta && meta.cancelled) return 'cancelled';
            // Already in the state the entry wants — unless the change it would
            // undo is too fresh for userdata to show: for an undo the ignore, for
            // an ignore a rollback of the game.
            if (policy.satisfied(ignored, entry) && !(await policy.staleRead(this, entry, readAt))) {
                await policy.onDeduped(this, entry);
                return 'dedupe';
            }
            if (await policy.superseded(this, entry)) return 'reignored';
            return null;
        }

        // A read made at `readAt` may still list a game rolled back shortly
        // before it (or since): userdata lags a remove=1 as it lags an ignore.
        // Seen through the log, so a rollback without a log entry is not.
        async _readPredatesUndo(appid, readAt) {
            const undoneAt = await this.log.lastUndoneAt(appid);
            return undoneAt > 0 && undoneAt > readAt - USERDATA_LAG_MS;
        }

        // The game's reason before the entry's POST, null = not on the list, or
        // not knowable from a read that may predate a rollback of it.
        async _prevReason(appid, ignored, readAt) {
            if (!ignored.has(appid)) return null;
            return (await this._readPredatesUndo(appid, readAt)) ? null : ignored.get(appid);
        }

        // The entry's VERDICT after its POST. `prev`: _prevReason's, before it.
        async _handleResult(cur, entry, res, ignored, attempt, prev) {
            const { appid, meta, policy } = entry;
            if (res && res.ok) {
                const next = policy.landedReason(entry);
                if (next === null) ignored.delete(appid);
                else ignored.set(appid, next);
                await policy.onLanded(this, cur, entry, prev);
                return VERDICT.LANDED;
            }
            if (res && res.rateLimited) {
                // Account throttling, not this appid: back every source off.
                await this.gate.reportRateLimited(res.retryAfterMs);
                return VERDICT.STOP;
            }
            if (res && res.unavailable) {
                // A permanent per-appid refusal: no retries to spend.
                await this._dropEntry(cur, appid, meta, 'unavailable');
                return VERDICT.DROPPED;
            }
            // A dead session fails every POST while the gate's cached login check
            // still passes; without this probe MAX_FAILS would walk the whole job.
            if ((await this.probeLogin()) !== true) {
                this._parkedUntil = Date.now() + DEAD_SESSION_PARK_MS;
                return VERDICT.STOP;
            }
            if (attempt < MAX_FAILS) return VERDICT.RETRY;
            await this._dropEntry(cur, appid, meta, 'failed');
            return VERDICT.DROPPED;
        }

        async _drainJob(job) {
            const isUndoJob = this.store.jobTraits(job).undo;
            // A curator job survives a failed userdata read (no dedupe, every POST
            // fires). An undo job must not: its dedupe is inverted, so an empty set
            // would skip the whole job with no requests.
            const readAt = Date.now();
            const userdata = await this.fetchUserdata().catch(() => null);
            if (isUndoJob && !userdata) return VERDICT.STOP;
            // A logged-out read is also an empty set: confirm the session first.
            if (isUndoJob && userdata.size === 0
                && (await this.probeLogin()) !== true) return VERDICT.STOP;
            // The read already made is Steam's own total, free: keep it for the
            // popup. An empty set is also what a signed-out read returns, so it
            // counts only where the session was just confirmed above. A read this
            // soon after a POST from any source may not show it while the counter
            // already does: the last snapshot plus the counter stays right then.
            if (userdata && (userdata.size > 0 || isUndoJob)
                && readAt - (await this.gate.lastSlotAt()) >= USERDATA_LAG_MS) {
                await this.stats.recordTotal(userdata.size);
            }
            const ignored = userdata || new Map();
            let lastBeat = Date.now();
            let fails = 0;

            while (true) {
                const queue = await this.store.getQueue();
                const cur = queue.find(j => j.id === job.id);
                if (!cur || !liveStatus(cur)) return;
                if (await this._preemptedBy(queue, cur)) return;
                if (!(await this.lease.holdsLock(job.curatorId, this.ownerId))) return;

                // On every path, not only after a POST: a long run of dedupe skips
                // would otherwise outlive the lease TTL.
                if (Date.now() - lastBeat > HEARTBEAT_MS) {
                    await this.lease.renewLock(job.curatorId, this.ownerId);
                    lastBeat = Date.now();
                }

                const cursor = await this._cursorOf(cur);
                if (cursor >= cur.appids.length) {
                    // Kept if a gesture appended meanwhile: loop on and drain it.
                    if (!(await this.store.removeIfDrained(job.id, cursor))) continue;
                    await this.store.signalCompleted();
                    return;
                }

                const entry = this._entryAt(cur, cursor);
                // `snapshot`: a queue read since which no network wait happened, so
                // the cursor write need not read the queue again. After a POST it
                // must: a remove can land during the request.
                const advance = async (snapshot) => {
                    await this.store.setCursor(job.id, cursor + 1, snapshot);
                    fails = 0;
                };

                // Skips are not paced by the gate: a mostly-ignored list runs
                // through them back to back.
                if (await this._skipReason(entry, ignored, readAt)) {
                    // What the cursor write must not do is outlive its job. A
                    // Remove landing between the queue read and setCursor takes
                    // the job AND its cursor key; the stale snapshot still lists
                    // the job, so setCursor puts the key back. For a job whose id
                    // is REUSED — the two gesture jobs, fixed at `job_mi` and
                    // `job_mi_undo` — the next one of its kind then mounts already
                    // past its own end: nothing is sent, and removeIfDrained
                    // clears it with none of removeJob's pulses, so the badge
                    // stays (or stays pale) with nothing said. Curator and
                    // droplist-undo ids carry a Date.now(), so the same race there
                    // only leaks a key nobody reads.
                    //
                    // So re-read for a gesture job, and for any undo pass: its
                    // markUndone reads every log chunk and writes one back, which
                    // is the widest window of the three. What keeps the snapshot
                    // is the curator run — hundreds of dedupe skips back to back,
                    // the case the snapshot was introduced for.
                    const reusedId = this.store.jobTraits(cur).gesture;
                    await advance(entry.isUndo || reusedId ? undefined : queue);
                    continue;
                }

                // Rollbacks spend the same budget: same endpoint. A stop verdict
                // leaves the cursor where it is. A gesture job is the user's own
                // swipe, so it keeps the normal gap while they browse.
                const slot = await this.gate.reserve({ gesture: !!this.store.jobTraits(cur).gesture });
                if (!slot.ok) return VERDICT.STOP;

                // The wait can be long: re-check pause/remove, a cancel of this very
                // entry, and the lease before the POST.
                const freshQueue = await this.store.getQueue();
                const fresh = freshQueue.find(j => j.id === job.id);
                if (!fresh || !liveStatus(fresh)) return;
                if (entry.policy.cancellable && fresh.meta && fresh.meta[entry.appid]
                    && fresh.meta[entry.appid].cancelled) {
                    await advance(freshQueue);
                    continue;
                }
                if (!(await this.lease.holdsLock(job.curatorId, this.ownerId))) return;

                // The POST and its handling can outlast the lease on their own (a
                // 10 s fetch deadline, an appdetails read on a 400, a login probe,
                // against LEASE_MS): renew on a timer meanwhile, or a standby
                // drainer takes the lease and sends this same entry again. A renewal
                // still in flight is awaited, so its write cannot land after the
                // pass has released the lease and put it back. `prev` is read
                // before the timer starts: a throw between the two would leave it
                // renewing the lease for good.
                const prev = await this._prevReason(entry.appid, ignored, readAt);
                let renewing = Promise.resolve();
                const beat = setInterval(() => {
                    renewing = this.lease.renewLock(job.curatorId, this.ownerId).catch(() => {});
                }, HEARTBEAT_MS);
                let verdict;
                try {
                    const res = await entry.policy.post(this, entry);
                    verdict = await this._handleResult(cur, entry, res, ignored, fails + 1, prev);
                } finally {
                    clearInterval(beat);
                    await renewing;
                }
                if (verdict === VERDICT.STOP) return VERDICT.STOP;
                if (verdict === VERDICT.RETRY) {
                    fails += 1;
                    continue;
                }
                await advance();
                if (verdict === VERDICT.LANDED && entry.policy.cancellable) {
                    await this._compensateCancelled(job, entry.appid, prev);
                }
            }
        }
    }

    window.ILAP.Curator.CuratorQueueDrainer = CuratorQueueDrainer;

    // Tab host. The service worker builds its own drainer (src/background.js),
    // where utils.js and its POST are absent.
    if (window.ILAP.apiIgnoreGame) {
        const I = window.ILAP;
        const Store = I.Curator.Store;
        // 400 classification wraps the POST here, not inside apiIgnoreGame: EQ and
        // DQ share that function and neither retries nor skips a failed appid.
        const drainer = new CuratorQueueDrainer({
            ownerId: I.newOwnerId('d_'),
            store: Store,
            lease: I.Curator.Lease,
            api: {
                ignore: async (appid, reason) =>
                    I.classifyRefusal(appid, await I.apiIgnoreGame(appid, reason)),
                unignore: async (appid) =>
                    I.classifyRefusal(appid, await I.apiUnignoreGame(appid))
            },
            gate: {
                reserve: (opts) => I.IgnoreGate.reserve(opts),
                reportRateLimited: (ms) => I.IgnoreGate.reportRateLimited(ms),
                stopped: () => I.IgnoreGate.stopVerdict(),
                lastSlotAt: () => I.IgnoreGate.lastSlotAt()
            },
            fetchUserdata: () => I.fetchIgnoredAppsStrict(),
            probeLogin: () => I.SteamAuth.probeLogin(),
            stats: {
                save: (name, reason) => I.saveStats(name, I.StatsLogic.miSourceLabel(reason)),
                saveHistory: (name, reason) => I.saveHistory(name, I.StatsLogic.miSourceLabel(reason)),
                bumpCount: () => I.bumpIgnoredCount(),
                dropCount: () => I.dropIgnoredCount(),
                recordTotal: (size) => I.recordIgnoredTotal(size),
            },
            log: I.IgnoreLog.drainerHooks()
        });
        I.Curator.drainer = drainer;
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            const touched = changes[Store.QUEUE_KEY]
                || changes[I.Settings.KEYS.MASTER]   // re-enabling the master resumes a gate-stopped drain
                || Object.keys(changes).some(k => k.indexOf(I.Curator.Lease.LOCK_PREFIX) === 0);
            if (touched) drainer.kick();
        });
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => drainer.kick());
        } else {
            drainer.kick();
        }
    }
})();
