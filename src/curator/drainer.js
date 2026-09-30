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
    // userdata lags a fresh ignore by seconds. An undo job does not trust "not
    // in the set" for a game ignored this recently; it POSTs remove=1 instead.
    const UNDO_FRESH_MS = 15000;
    // Floor between two passes that reach the network: each costs a userdata GET
    // the gate does not pace. Kicks inside it are deferred, never dropped.
    const MIN_PASS_GAP_MS = 2000;

    // An MI entry carries its swipe's reason (0 Default, 2 Played Elsewhere).
    const miReason = (meta) => (meta && Number.isFinite(meta.reason) ? meta.reason : REASON);

    // What each job type does where the loop POSTs, lands or drops an entry.
    // Lease, cursor, dedupe direction, gate and retries are shared.
    //   post(d, appid, meta)                     the POST for one entry
    //   onLanded(d, job, appid, meta, entryTs)   Steam accepted it; runs before the cursor moves
    //   droppedLogEntry(job, appid, meta)        the log record of a drop, or null
    //   onDropped(d, appid)                      what the tabs are told about a drop
    //   cancellable                              entries can be taken back before their POST
    const UNDO_POLICY = {
        post: (d, appid) => d.api.unignore(appid),
        async onLanded(d, job, appid, meta, entryTs) {
            await d.log.markUndone(appid, entryTs);
            // Only on a landed POST: a dedupe skip rolled nothing back.
            await d.dropCount();
            await d.store.signalUnignored(appid);
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
        post: (d, appid) => d.api.ignore(appid, REASON),
        async onLanded(d, job, appid) {
            await d.log.append({ appid, source: 'curator', curatorId: job.curatorId });
            await d.bumpCount();
        },
        droppedLogEntry: (job, appid) => ({ appid, source: 'curator', curatorId: job.curatorId }),
        async onDropped() {},
        cancellable: false,
    };

    const MI_POLICY = {
        post: (d, appid, meta) => d.api.ignore(appid, miReason(meta)),
        // Counted and logged only now that the POST landed.
        async onLanded(d, job, appid, meta) {
            const name = meta ? meta.name : '';
            await d.saveStats(name, miReason(meta));
            await d.log.append({ appid, name, source: 'mi' });
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
        need(hasFns(deps.gate, ['reserve', 'reportRateLimited', 'stopped']), 'gate');
        need(isFn(deps.fetchUserdata), 'fetchUserdata');
        need(hasFns(deps.log, ['append', 'markUndone', 'lastIgnoredAt', 'wasReIgnoredAfter']), 'log');
        need(isFn(deps.saveStats), 'saveStats');
        need(isFn(deps.bumpCount), 'bumpCount');
        need(isFn(deps.dropCount), 'dropCount');
    }

    class CuratorQueueDrainer {
        constructor(deps) {
            checkDeps(deps);
            this.store = deps.store;
            this.lease = deps.lease;
            this.api = deps.api;                       // { ignore(appid, reason), unignore(appid) }
            this.gate = deps.gate;                     // { reserve(), reportRateLimited(ms), stopped() }
            // Called, not captured: checkDeps only asks that `stopped` IS a
            // function, so a host handing over an object's method (rather than
            // the arrow both hosts pass today) would lose its receiver and throw
            // on the first stop check — the one call that decides whether a pass
            // may send at all.
            this.stopped = () => this.gate.stopped();
            this.fetchUserdata = deps.fetchUserdata;   // () => Promise<Set<string>|null>, strict
            this.probeLogin = deps.probeLogin;         // () => Promise<true|false|null>
            this.log = deps.log;                       // IgnoreLog.drainerHooks()
            this.saveStats = deps.saveStats;           // (name, reason): MI ignores only
            this.bumpCount = deps.bumpCount;           // (): curator ignores, total only
            this.dropCount = deps.dropCount;           // (): confirmed rollbacks, total only
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

        // A solo un-ignore gestured mid-pass ends the pass, so the next one picks
        // it; this job resumes from its cursor afterwards. Only the rollback
        // preempts: an MI swipe would cost a userdata GET per swipe, and its
        // badge is already painted.
        async _preemptedBy(queue, job) {
            const { JOB_TYPE, jobType } = this.store;
            if (jobType(job) === JOB_TYPE.MIUNDO) return false;
            const rollback = queue.find(j => jobType(j) === JOB_TYPE.MIUNDO);
            return !!rollback && await this._drainable(rollback);
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
        // rollback carrying the gesture's own time.
        async _compensateCancelled(job, appid) {
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

        // Why this entry needs no POST, or null. A deduped rollback is marked
        // undone here, so a stale entry can't keep eating later undo budgets.
        async _skipReason(entry, ignored) {
            const { appid, meta, policy, isUndo, entryTs } = entry;
            // Taken back before it was sent (Store.cancelMiEntry).
            if (policy.cancellable && meta && meta.cancelled) return 'cancelled';
            // Already in the state the job wants: ignored, or for an undo job not
            // ignored — unless the ignore is too fresh for userdata to show it.
            if (isUndo ? !ignored.has(appid) : ignored.has(appid)) {
                const freshIgnore = isUndo
                    && Date.now() - (await this.log.lastIgnoredAt(appid)) < UNDO_FRESH_MS;
                if (!freshIgnore) {
                    if (isUndo) await this.log.markUndone(appid, entryTs);
                    return 'dedupe';
                }
            }
            // Re-ignored after the rollback was asked for: the later intent wins.
            if (isUndo && await this.log.wasReIgnoredAfter(appid, entryTs)) return 'reignored';
            return null;
        }

        // The entry's VERDICT after its POST.
        async _handleResult(cur, entry, res, ignored, attempt) {
            const { appid, meta, policy, isUndo, entryTs } = entry;
            if (res && res.ok) {
                if (isUndo) ignored.delete(appid);
                else ignored.add(appid);
                await policy.onLanded(this, cur, appid, meta, entryTs);
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
            const userdata = await this.fetchUserdata().catch(() => null);
            if (isUndoJob && !userdata) return VERDICT.STOP;
            // A logged-out read is also an empty set: confirm the session first.
            if (isUndoJob && userdata.size === 0
                && (await this.probeLogin()) !== true) return VERDICT.STOP;
            const ignored = userdata || new Set();
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
                if (await this._skipReason(entry, ignored)) {
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
                // leaves the cursor where it is.
                const slot = await this.gate.reserve();
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
                // pass has released the lease and put it back.
                let renewing = Promise.resolve();
                const beat = setInterval(() => {
                    renewing = this.lease.renewLock(job.curatorId, this.ownerId).catch(() => {});
                }, HEARTBEAT_MS);
                let verdict;
                try {
                    const res = await entry.policy.post(this, entry.appid, entry.meta);
                    verdict = await this._handleResult(cur, entry, res, ignored, fails + 1);
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
                    await this._compensateCancelled(job, entry.appid);
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
                reserve: () => I.IgnoreGate.reserve(),
                reportRateLimited: (ms) => I.IgnoreGate.reportRateLimited(ms),
                stopped: () => I.IgnoreGate.stopVerdict()
            },
            fetchUserdata: () => I.fetchIgnoredAppsStrict(),
            probeLogin: () => I.SteamAuth.probeLogin(),
            saveStats: (name, reason) => I.saveStats(name, I.StatsLogic.miSourceLabel(reason)),
            bumpCount: () => I.bumpIgnoredCount(),
            dropCount: () => I.dropIgnoredCount(),
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
