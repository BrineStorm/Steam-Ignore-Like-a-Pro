// SPDX-License-Identifier: GPL-3.0-or-later
//
// DISCLAIMER: This drainer issues bulk ignore actions to Steam on the user's
// behalf. Provided "as is", without warranty. Use at your own risk; you are
// responsible for your own account and for respecting Steam's Terms of Service.
(function() {
    'use strict';

    // Curator queue drainer. Runs in every store tab (curator/drainer-host.js) and,
    // on Chromium, in the service worker (src/background.js); all of them share one
    // lease/handoff protocol. With an empty queue it is idle after the boot read.
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
    // How often a long pass reads the account again. A built-in list runs for
    // over an hour, and a game wishlisted meanwhile must still be spared.
    const REREAD_MS = 10 * 60 * 1000;

    // An MI entry keeps its swipe's reason (0 Default, 2 Played Elsewhere).
    const miReason = (meta) => (meta && Number.isFinite(meta.reason) ? meta.reason : REASON);
    // An MI entry that came from a bundle with no free job slot
    // (Store.stageBundle) or from an AI game a page loaded while browsing
    // (manual-ignore/ai-browse.js): an automated ignore like a bundle job's.
    const automatedMi = (meta) => !!(meta && (meta.bundle || meta.auto));

    // What each job type does where the loop POSTs, lands or drops an entry.
    // Lease, cursor, gate and retries are shared. `entry` is _entryAt's;
    // `ignored` the pass's userdata, appid -> reason.
    //   satisfied(ignored, entry)         already as the entry wants it: no POST (dedupe)
    //   staleRead(d, entry, readAt)       the read may predate the change `satisfied`
    //                                     would undo, so it is not trusted for a dedupe
    //   onDeduped(d, entry)               what a dedupe skip records
    //   superseded(d, entry, readAt)      a later user intent replaced it: skipped
    //   landedReason(entry)               the game's reason once the POST lands, null = not ignored,
    //                                     undefined = the entry is no game (a creator)
    //   post(d, entry)                    the POST for one entry
    //   onLanded(d, job, entry, prev)     Steam accepted it; runs before the cursor moves.
    //                                     `prev`: the reason before it, null = was not ignored
    //   droppedLogEntry(job, appid, meta) the log record of a drop, or null
    //   onDropped(d, appid, meta, why)    what a drop leaves: the tabs told, a mark kept.
    //                                     `why` 'unavailable' or 'failed', as the log says
    //   onFinished(d, job)                the job ran to its end and was removed
    //   cancellable                       entries can be taken back before their POST
    //   accountSkip(ignored, entry)       why the account's own lists leave this entry out:
    //                                     'wishlisted' or 'owned' (skipped, counted),
    //                                     'unread' (the pass stops before it), or null
    //   readsUserdata                     the pass starts with a userdata read
    //   needsRead                         with no read, or one that is empty on a dead
    //                                     session, the pass stops: its dedupe is inverted,
    //                                     so "not in the map" would skip every entry
    //   freshCursor                       the cursor write reads the queue again after a
    //                                     skip, in place of the step's snapshot
    //   reconcile(d, entry, now, prev)    or null: what a gesture did to the entry while its
    //                                     POST was out, `now` being its meta after the POST
    //   needsApi                          the method of `api` a host must have to drain it

    // An automated ignore never takes a game the user wishlisted or owns. A read
    // with no wishlist or library cannot tell it safe, so it waits for the next pass.
    // Owned games are already counted for the whole job (_countOwned).
    const sparedByAccount = (ignored, e) => {
        if (!ignored.wishlist || !ignored.owned) return 'unread';
        if (ignored.wishlist.has(e.appid)) return 'wishlisted';
        return ignored.owned.has(e.appid) ? 'owned' : null;
    };
    const noAccountSkip = () => null;

    // An ignore distrusts "on the list" for a game rolled back shortly before
    // the read: userdata lags a remove=1 as it lags an ignore.
    const ignoreReadIsStale = (d, e, readAt) => d._readPredatesUndo(e.appid, readAt);

    // An automated ignore takes the game as it finds it, whatever its reason. A game
    // ignored shortly before the read (or since) may not show in it yet, and the log
    // is the word for it: a POST would replace the user's reason and count it twice.
    const ignoredUnseen = (d, e, readAt) => d._readPredatesIgnore(e.appid, readAt);

    // A rolled-back game is marked undone in the log, and a built-in list that
    // ignored it is no longer all ignored, so the lists menu offers it again.
    const markRolledBack = async (d, e) => d.marks.unmarkPresets(await d.log.markUndone(e.appid, e.entryTs));

    // Both rollbacks, the droplist undo and the solo un-ignore (gesture, badge
    // click): the game comes off the list.
    const UNDO_POLICY = {
        satisfied: (ignored, e) => !ignored.has(e.appid),
        // "Not on the list" is not trusted for an ignore too fresh to show.
        staleRead: async (d, e) => Date.now() - (await d.log.lastIgnoredAt(e.appid)) < USERDATA_LAG_MS,
        // Marked undone, so a stale entry can't keep eating later undo budgets.
        onDeduped: markRolledBack,
        // Re-ignored after the rollback was asked for: the later intent wins.
        superseded: (d, e) => d.log.wasReIgnoredAfter(e.appid, e.entryTs),
        landedReason: () => null,
        post: (d, e) => d.api.unignore(e.appid),
        async onLanded(d, job, e) {
            await markRolledBack(d, e);
            // Only on a landed POST: a dedupe skip rolled nothing back.
            await d.stats.dropCount();
            await d.store.signalUnignored(e.appid);
            // A bundle with this game in it is no longer all ignored.
            await d.marks.unmarkBundlesWith([e.appid]);
        },
        // A failed rollback stays undoable, so it leaves no skipped record.
        droppedLogEntry: () => null,
        // Nothing to un-badge (the game stays ignored); the user is told instead.
        async onDropped(d) {
            await d.store.signalUndoFailed('failed');
        },
        onFinished: (d, job) => d.stats.saveJob(job),
        cancellable: false,
        accountSkip: noAccountSkip,
        readsUserdata: true,
        needsRead: true,
        freshCursor: true,
        reconcile: null,
    };

    const CURATOR_POLICY = {
        // Any reason will do: a curator list never overrides the user's own.
        satisfied: (ignored, e) => ignored.has(e.appid),
        staleRead: ignoreReadIsStale,
        onDeduped: async () => {},
        superseded: ignoredUnseen,
        landedReason: () => REASON,
        post: (d, e) => d.api.ignore(e.appid, REASON),
        async onLanded(d, job, e) {
            await d.log.append({ appid: e.appid, source: 'curator', curatorId: job.curatorId });
            await d.stats.bumpCount();
        },
        droppedLogEntry: (job, appid) => ({ appid, source: 'curator', curatorId: job.curatorId }),
        async onDropped() {},
        // One entry in Last Ignored for the whole list (StatsLogic.jobEntry).
        onFinished: (d, job) => d.stats.saveJob(job),
        cancellable: false,
        accountSkip: sparedByAccount,
        readsUserdata: true,
        needsRead: false,
        freshCursor: false,
        reconcile: null,
    };

    // A bundle drains like a curator's list, with the reason of the gesture that
    // staged it (kept per app in `meta`, as the MI job keeps it).
    // Run to its end, its capsules get the IGNORED badge (DoneMarks.markBundleDone).
    const BUNDLE_POLICY = Object.assign({}, CURATOR_POLICY, {
        landedReason: (e) => miReason(e.meta),
        post: (d, e) => d.api.ignore(e.appid, miReason(e.meta)),
        async onFinished(d, job) {
            await d.marks.markBundleDone(job);
            await d.stats.saveJob(job);
        },
    });

    // A built-in list drains like a curator's. Run to its end, it is marked done
    // so the lists menu stops offering it until a release changes the list.
    const PRESET_POLICY = Object.assign({}, CURATOR_POLICY, {
        async onFinished(d, job) {
            await d.marks.markPresetDone(job);
            await d.stats.saveJob(job);
        },
    });

    const MI_POLICY = {
        // A swipe sets its reason: on the list with the other one, Steam takes
        // the same POST as a change of reason (verified live, both ways). A
        // bundle's app or a game shot while browsing takes any reason, as a
        // bundle job does.
        satisfied: (ignored, e) => (automatedMi(e.meta)
            ? ignored.has(e.appid) : ignored.get(e.appid) === miReason(e.meta)),
        staleRead: ignoreReadIsStale,
        onDeduped: async () => {},
        superseded: async (d, e, readAt) => automatedMi(e.meta) && ignoredUnseen(d, e, readAt),
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
                await d.stats.saveHistory(name, miReason(e.meta), e.appid);
                return;
            }
            await d.stats.save(name, miReason(e.meta), e.appid);
            // The game page's frame says which list or shot ignored it
            // (manual-ignore/list-frame.js). A bundle's app keeps the bundle's id.
            const meta = e.meta || {};
            await d.log.append({ appid: e.appid, name, source: 'mi', auto: meta.auto,
                curatorId: typeof meta.bundle === 'string' ? meta.bundle : undefined });
        },
        droppedLogEntry: (job, appid, meta) => ({ appid, name: meta ? meta.name : '', source: 'mi' }),
        // The swipe's optimistic badge now lies: drop it, and say why. A game
        // shot while browsing is remembered as refused here, in whichever host
        // drains (the SW has no tab), so no page shoots it again for a while.
        async onDropped(d, appid, meta, why) {
            if (meta && meta.auto) await d.marks.markAiRefused(appid, why);
            await d.store.signalUnignored(appid, 'failed');
        },
        onFinished: async () => {},
        cancellable: true,
        // A swipe points at one game on purpose, wishlisted or not. A bundle's
        // app that overflowed into this job and a game shot while browsing
        // are automated ignores.
        accountSkip: (ignored, e) => (automatedMi(e.meta) ? sparedByAccount(ignored, e) : null),
        readsUserdata: true,
        needsRead: false,
        freshCursor: true,
        // Taken back: a real rollback, except where the POST only changed a
        // reason, which nothing rolls back. Given the other reason: it goes out
        // too, and Steam takes the repeat as a change.
        async reconcile(d, e, now, prev) {
            if (now.cancelled) {
                if (prev === null) await d.store.enqueueMiUndo({ appid: e.appid });
            } else if (miReason(now) !== miReason(e.meta)) {
                await d.store.enqueueMi({ appid: e.appid, name: now.name, reason: miReason(now), ts: now.ts });
            }
        },
    };

    // Steam's own creator ignore. An entry is a clan id in `appids`, its meta
    // { name, ignore, ts }. Always sent: Steam takes a repeat as a no-op, and a
    // read could not tell a creator ignored a moment ago anyway. Drained only by
    // a store tab (the host that has `api.creator`).
    const CREATOR_POLICY = {
        satisfied: () => false,
        staleRead: async () => false,
        onDeduped: async () => {},
        superseded: async () => false,
        landedReason: () => undefined,
        post: (d, e) => d.api.creator(e.appid, !!(e.meta && e.meta.ignore)),
        async onLanded(d, job, e) {
            const name = (e.meta && e.meta.name) || '';
            const ignore = !!(e.meta && e.meta.ignore);
            await d.creators.note(e.appid, name, ignore);
            await d.log.append({ creator: e.appid, name, ignore, source: 'creator' });
            await d.stats.saveCreator(name, e.appid, ignore);
        },
        droppedLogEntry: () => null,
        // The link's grey comes from the mirror and the job, so it corrects
        // itself; the user is told why.
        async onDropped(d) {
            await d.creators.signalFailed();
        },
        onFinished: async () => {},
        cancellable: false,
        accountSkip: noAccountSkip,
        // Nothing in the read is a clan id: no GET for a creator pass.
        readsUserdata: false,
        needsRead: false,
        freshCursor: true,
        // Turned the other way while the POST was out: the last gesture goes out too.
        async reconcile(d, e, now) {
            if (!!now.ignore !== !!(e.meta && e.meta.ignore)) {
                await d.store.enqueueCreator({ clanid: e.appid, name: now.name, ignore: !!now.ignore });
            }
        },
        needsApi: 'creator',
    };

    // What a POST's result means for the entry (_handleResult): LANDED or DROPPED
    // move on, RETRY sends the same entry again, STOP ends the pass with the
    // cursor kept. _drainJob returns STOP, or nothing when the job left the pass.
    const VERDICT = Object.freeze({ LANDED: 'landed', DROPPED: 'dropped', RETRY: 'retry', STOP: 'stop' });

    const policiesFor = (T) => Object.freeze({
        [T.CURATOR]: CURATOR_POLICY,
        [T.PRESET]: PRESET_POLICY,
        [T.BUNDLE]: BUNDLE_POLICY,
        [T.MI]: MI_POLICY,
        [T.UNDO]: UNDO_POLICY,
        [T.MIUNDO]: UNDO_POLICY,
        [T.CREATOR]: CREATOR_POLICY,
    });

    // Meant to run and has a list. 'paused' is user intent, 'enumerating' a
    // new job whose list is still being read; 'running' is a legacy stored value.
    const liveStatus = (j) => j.status === 'running' || j.status === 'pending';
    const runnable = (store, j) => liveStatus(j) && store.hasList(j);

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
        need(hasFns(deps.marks, ['markPresetDone', 'unmarkPresets', 'markBundleDone', 'unmarkBundlesWith', 'markAiRefused']), 'marks');
        need(hasFns(deps.lease, ['acquireLock', 'renewLock', 'holdsLock', 'releaseLock']), 'lease');
        need(hasFns(deps.api, ['ignore', 'unignore']), 'api');
        need(hasFns(deps.gate, ['reserve', 'reportRateLimited', 'stopped', 'lastSlotAt', 'quietUntil']), 'gate');
        need(isFn(deps.fetchUserdata), 'fetchUserdata');
        need(hasFns(deps.log, ['append', 'markUndone', 'lastIgnoredAt', 'lastUndoneAt', 'wasReIgnoredAfter']), 'log');
        need(hasFns(deps.stats, ['save', 'saveHistory', 'saveJob', 'bumpCount', 'dropCount', 'recordTotal']), 'stats');
        // A host that drains creator jobs needs where their results go.
        if (deps.api.creator) {
            need(isFn(deps.api.creator), 'api.creator');
            need(hasFns(deps.creators, ['note', 'signalFailed']), 'creators');
            need(isFn(deps.stats.saveCreator), 'stats.saveCreator');
        }
    }

    class CuratorQueueDrainer {
        constructor(deps) {
            checkDeps(deps);
            this.store = deps.store;
            this.marks = deps.marks;                   // DoneMarks: what a finished job leaves behind
            this.lease = deps.lease;
            // { ignore(appid, reason), unignore(appid), creator?(clanid, ignore) }
            this.api = deps.api;
            this.creators = deps.creators || null;     // the creator mirror (src/creators.js), with api.creator
            this.gate = deps.gate;                     // { reserve(), reportRateLimited(ms), stopped(), lastSlotAt(), quietUntil() }
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
            //   save(name, reason, appid)         MI ignores only: counted + Last Ignored
            //   saveHistory(name, reason, appid)  MI changes of reason: shown, not counted
            //   saveJob(job)                      a finished curator/list/bundle/undo job: one entry, not counted
            //   bumpCount()                       curator ignores, total only
            //   dropCount()                       confirmed rollbacks, total only
            //   recordTotal(size)                 Steam's ignore-list size from the pass's read
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
            // No pass before this, whoever kicks: a read failed just now (_readFailed).
            this._notBefore = 0;
            this._rekickTimer = null;
            // In memory: a re-login always comes with a fresh page and drainer.
            this._parkedUntil = 0;
        }

        // The host decides what wakes a pass: its storage listener calls this
        // (drainer-host.js, background.js). The standby interval is armed by
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

        // A solo un-ignore: a gesture that rolls back.
        _isRollbackGesture(job) {
            const traits = this.store.jobTraits(job);
            return !!traits && traits.gesture && traits.undo;
        }

        // Gesture jobs first: they are live user actions. Of them, a rollback
        // first: it is the later intent, and it is the one whose wait shows (a
        // dimmed badge). A pass runs its job to the end, so `_preemptedBy` is what
        // makes this priority reach a gesture made mid-drain.
        async _pickJob(queue) {
            const ready = [];
            for (const j of queue) if (await this._drainable(j)) ready.push(j);
            return ready.find(j => this._isRollbackGesture(j))
                || ready.find(j => this.store.jobTraits(j).gesture)
                || ready[0] || null;
        }

        // Progress lives in the cursor key; the record's `cursor` field is a
        // legacy value from before that key existed.
        async _cursorOf(job) {
            const keyCursor = await this.store.getCursor(job.id);
            return keyCursor != null ? keyCursor : (job.cursor || 0);
        }

        // Meant to run, of a known type this host can send, and something left
        // to do. A job whose POST this host lacks waits for one that has it.
        async _drainable(job) {
            const policy = this._policyOf(job);
            if (!policy || (policy.needsApi && !this.api[policy.needsApi])) return false;
            return runnable(this.store, job)
                && (await this._cursorOf(job)) < this.store.listLength(job);
        }

        // A gesture made mid-pass ends the pass, so the next one picks it; this
        // job resumes from its cursor afterwards. A solo un-ignore preempts at
        // once. A swipe preempts a curator or droplist-undo pass only once it has
        // waited SWIPE_WAIT_MS: its badge is already painted, and each hand-off
        // costs userdata GETs. Without the hand-off, on a host with no other
        // drainer free (Firefox with one store tab), a swipe would wait out the
        // whole pass, which the swiping itself slows to ACTIVE_GAP.
        async _preemptedBy(queue, job) {
            const { jobTraits } = this.store;
            if (this._isRollbackGesture(job)) return false;
            const rollback = queue.find(j => this._isRollbackGesture(j));
            if (rollback && await this._drainable(rollback)) return true;
            if (jobTraits(job).gesture) return false;
            // Every other gesture waits the same way a swipe does.
            for (const j of queue) {
                const traits = jobTraits(j);
                if (traits && traits.gesture && await this._waitedTooLong(j)) return true;
            }
            return false;
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
                if (!runnable(this.store, j) || !this.store.jobTraits(j)) continue;
                const cursor = await this._cursorOf(j);
                if (cursor < this.store.listLength(j)) continue;
                if (await this.store.removeIfDrained(j.id, cursor, j)) {
                    await this._policyOf(j).onFinished(this, j);
                    await this.store.signalCompleted();
                    removed += 1;
                }
            }
            return removed;
        }

        // A gesture that landed while the POST was out rewrote this entry, since
        // the cursor had not moved yet, and was told it took. Checked after the
        // cursor moved, when a later gesture starts an entry of its own. A job
        // made anew under its id has entries of its own, none of them this one.
        async _reconcile(job, entry, prev) {
            const after = (await this.store.getQueue()).find(j => this.store.sameJob(j, job));
            const now = after && after.meta ? after.meta[entry.appid] : null;
            if (now) await entry.policy.reconcile(this, entry, now, prev);
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
            await policy.onDropped(this, appid, meta, why);
        }

        // Resolving does not mean a pass ran: not while one is running, while
        // parked, or inside MIN_PASS_GAP_MS (that kick returns through `rekick`).
        async drain() {
            if (this.draining || Date.now() < this._parkedUntil) return;
            const now = Date.now();
            const wait = Math.max(MIN_PASS_GAP_MS - (now - this._lastWorkAt), this._notBefore - now);
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
                    // Nothing could go out before this (a 429 penalty, a visible
                    // source running): a pass now would only spend its userdata read.
                    const quiet = await this.gate.quietUntil();
                    if (quiet > Date.now()) {
                        this._armRekick(quiet - Date.now());
                        break;
                    }
                    const got = await this.lease.acquireLock(job.curatorId, this.ownerId, job.id);
                    if (!got) break;   // another drainer owns this job → stay standby
                    this._lastWorkAt = Date.now();
                    let result;
                    try {
                        result = await this._drainJob(job);
                    } finally {
                        await this.lease.releaseLock(job.curatorId, this.ownerId);
                    }
                    // Still drainable, so re-picking would busy-loop. The next try is
                    // the standby tick, the worker's alarm, or a kick from elsewhere.
                    if (result === VERDICT.STOP) break;
                }
            } finally {
                this.draining = false;
            }
        }

        // The pass could not read the account, and the next one needs the same read:
        // no sooner than a standby tick, whoever kicks. Another host's release is a
        // kick, so hosts would otherwise take turns at MIN_PASS_GAP_MS.
        _readFailed() {
            this._notBefore = Date.now() + RETRY_TICK_MS;
            return VERDICT.STOP;
        }

        // One entry of `cur` at `cursor` of its list `appids`, with what the loop
        // decides by.
        _entryAt(cur, appids, cursor) {
            const appid = String(appids[cursor]);
            const meta = cur.meta ? cur.meta[appid] : null;
            return {
                appid, meta,
                policy: this._policyOf(cur),
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
            if (await policy.superseded(this, entry, readAt)) return 'reignored';
            return policy.accountSkip(ignored, entry);
        }

        // The count of owned games a curator, list or bundle job shows under its
        // ⚠, from this pass's read: every game of the job in the user's library
        // that is neither on the ignore list nor wishlisted, wherever the cursor
        // is, so the number is there as soon as the job is. The games themselves
        // are skipped when the cursor reaches them. `counted` (job id → list
        // length) counts each job once per pass, and again once its list arrives
        // or grows. A later pass counts anew with its own read. `listOf`: the
        // pass's list reader (_drainJob).
        async _countOwned(queue, ignored, counted, listOf) {
            const { owned, wishlist } = ignored;
            if (!owned || !wishlist) return;
            for (const j of queue) {
                const traits = this.store.jobTraits(j);
                if (!traits || traits.undo || traits.gesture || !this.store.hasList(j)) continue;
                const size = this.store.listLength(j);
                if (counted.get(j.id) === size) continue;
                const appids = await listOf(j);
                if (!appids) continue;
                counted.set(j.id, size);
                const n = appids.map(String)
                    .filter(a => owned.has(a) && !ignored.has(a) && !wishlist.has(a)).length;
                await this.store.setOwned(j.id, n);
            }
        }

        // A read made at `readAt` may still list a game rolled back shortly
        // before it (or since): userdata lags a remove=1 as it lags an ignore.
        // Seen through the log, so a rollback without a log entry is not.
        async _readPredatesUndo(appid, readAt) {
            const undoneAt = await this.log.lastUndoneAt(appid);
            return undoneAt > 0 && undoneAt > readAt - USERDATA_LAG_MS;
        }

        // The same for an ignore: a read made at `readAt` may not list a game
        // ignored shortly before it (or since). Older than that, a game the read
        // does not list came off the list in Steam itself.
        async _readPredatesIgnore(appid, readAt) {
            return (await this.log.lastIgnoredAt(appid)) > readAt - USERDATA_LAG_MS;
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
                else if (next !== undefined) ignored.set(appid, next);
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
            // Steam refused this one entry with a live session (a creator the
            // user follows, the 100-creator limit): retrying would be refused too.
            if (res && res.refused) {
                await this._dropEntry(cur, appid, meta, 'failed');
                return VERDICT.DROPPED;
            }
            if (attempt < MAX_FAILS) return VERDICT.RETRY;
            await this._dropEntry(cur, appid, meta, 'failed');
            return VERDICT.DROPPED;
        }

        // The entry's POST, and the VERDICT its result comes to. Both can outlast the
        // lease on their own (a 10 s fetch deadline, an appdetails read on a 400, a
        // login probe, against LEASE_MS): renew on a timer meanwhile, or a standby
        // drainer takes the lease and sends this same entry again. A renewal still
        // in flight is awaited, so its write cannot land after the pass has released
        // the lease and put it back.
        async _send(job, cur, entry, ignored, attempt, prev) {
            let renewing = Promise.resolve();
            const beat = setInterval(() => {
                renewing = this.lease.renewLock(job.curatorId, this.ownerId, job.id).catch(() => {});
            }, HEARTBEAT_MS);
            try {
                const res = await entry.policy.post(this, entry);
                return await this._handleResult(cur, entry, res, ignored, attempt, prev);
            } finally {
                clearInterval(beat);
                await renewing;
            }
        }

        // The read a pass opens with: the map, null with none to go by, or
        // VERDICT.STOP. A swipe job survives a failed userdata read (no dedupe,
        // every POST fires). A rollback must not (policy.needsRead). An automated
        // ignore stops at its first entry that needs the wishlist and library
        // (_skipReason).
        async _openRead(policy, readAt) {
            const userdata = policy.readsUserdata
                ? await this.fetchUserdata().catch(() => null) : null;
            if (policy.needsRead && !userdata) return this._readFailed();
            // A logged-out read is also an empty set: confirm the session first.
            if (policy.needsRead && userdata.size === 0
                && (await this.probeLogin()) !== true) return this._readFailed();
            // The read already made is Steam's own total, free: keep it for the
            // popup. An empty set is also what a signed-out read returns, so it
            // counts only where the session was just confirmed above. A read this
            // soon after a POST from any source may not show it while the counter
            // already does: the last snapshot plus the counter stays right then.
            if (userdata && (userdata.size > 0 || policy.needsRead)
                && readAt - (await this.gate.lastSlotAt()) >= USERDATA_LAG_MS) {
                await this.stats.recordTotal(userdata.size);
            }
            return userdata;
        }

        async _drainJob(job) {
            // A stored list never changes, so a pass reads each one once. A
            // record's own list is read with the queue on every step: a gesture
            // job grows while it drains.
            const lists = new Map();
            const listOf = async (j) => {
                if (Array.isArray(j.appids)) return j.appids;
                if (!lists.has(j.id)) lists.set(j.id, await this.store.getList(j));
                return lists.get(j.id);
            };
            const jobPolicy = this._policyOf(job);
            let readAt = Date.now();
            const userdata = await this._openRead(jobPolicy, readAt);
            if (userdata === VERDICT.STOP) return VERDICT.STOP;
            let ignored = userdata || new Map();
            let nextReadAt = readAt + REREAD_MS;
            const counted = new Map();
            let lastBeat = Date.now();
            let fails = 0;

            while (true) {
                const queue = await this.store.getQueue();
                const cur = queue.find(j => j.id === job.id);
                // Removed, or removed and made again under its reused id (the
                // gesture jobs): the next pass picks the new one at its own cursor.
                if (!this.store.sameJob(cur, job) || !liveStatus(cur)) return;
                await this._countOwned(queue, ignored, counted, listOf);
                if (await this._preemptedBy(queue, cur)) return;
                if (!(await this.lease.holdsLock(job.curatorId, this.ownerId))) return;

                // On every path, not only after a POST: a long run of dedupe skips
                // would otherwise outlive the lease TTL.
                if (Date.now() - lastBeat > HEARTBEAT_MS) {
                    await this.lease.renewLock(job.curatorId, this.ownerId, job.id);
                    lastBeat = Date.now();
                }

                // A long pass goes by what the account says now. A read that fails
                // leaves the last good one in place, and is not asked again at once.
                // So does an empty one where that would skip every entry left
                // (policy.needsRead): no session is confirmed here, as at the start.
                if (jobPolicy.readsUserdata && Date.now() >= nextReadAt) {
                    const at = Date.now();
                    nextReadAt = at + REREAD_MS;
                    const again = await this.fetchUserdata().catch(() => null);
                    if (again && (again.size > 0 || !jobPolicy.needsRead)) {
                        ignored = again;
                        readAt = at;
                        counted.clear();   // the owned counts go by this read too
                    }
                }

                const cursor = await this._cursorOf(cur);
                const appids = await listOf(cur);
                // A list gone from under its record has nothing left to send.
                if (!appids) {
                    await this.store.removeJob(job.id);
                    return;
                }
                if (cursor >= appids.length) {
                    // Kept if a gesture appended meanwhile: loop on and drain it.
                    if (!(await this.store.removeIfDrained(job.id, cursor, job))) continue;
                    await this._policyOf(cur).onFinished(this, cur);
                    await this.store.signalCompleted();
                    return;
                }

                let entry = this._entryAt(cur, appids, cursor);
                // `snapshot`: a queue read since which no network wait happened, so
                // the cursor write need not read the queue again. After a POST it
                // must: a remove can land during the request.
                const advance = async (snapshot) => {
                    await this.store.setCursor(job.id, cursor + 1, snapshot, job);
                    fails = 0;
                };

                // Skips are not paced by the gate: a mostly-ignored list runs
                // through them back to back.
                const skip = await this._skipReason(entry, ignored, readAt);
                // The cursor stays: the next pass reads userdata again.
                if (skip === 'unread') return this._readFailed();
                if (skip) {
                    if (skip === 'wishlisted') await this.store.bumpWishlisted(cur.id);
                    // What the cursor write must not do is outlive its job. A
                    // Remove landing between the queue read and setCursor takes
                    // the job AND its cursor key; the stale snapshot still lists
                    // the job, so setCursor puts the key back. For a job whose id
                    // is REUSED — the gesture jobs, `job_mi` and the others — one
                    // of its kind made in between then mounts already
                    // past its own end: nothing is sent, and removeIfDrained
                    // clears it with none of removeJob's pulses, so the badge
                    // stays (or stays pale) with nothing said. Curator and
                    // droplist-undo ids include a Date.now(), so the same race there
                    // only leaks a key nobody reads.
                    //
                    // So a gesture job reads the queue again, and so does any undo
                    // pass: its markUndone reads and writes the log between the queue
                    // read and the cursor write (policy.freshCursor). What keeps the
                    // snapshot is the curator run — hundreds of dedupe skips back to
                    // back, the case the snapshot is there for.
                    await advance(entry.policy.freshCursor ? undefined : queue);
                    continue;
                }

                // Rollbacks spend the same budget: same endpoint. A stop verdict
                // leaves the cursor where it is. A gesture job is the user's own
                // swipe, so it keeps the normal gap while they browse.
                const slot = await this.gate.reserve({ gesture: !!this.store.jobTraits(cur).gesture });
                if (!slot.ok) return VERDICT.STOP;

                // The wait can be long: re-check pause/remove, a later intent and the
                // lease before the POST, and go by the entry as a gesture left it (a
                // cancel, another reason or direction).
                const freshQueue = await this.store.getQueue();
                const fresh = freshQueue.find(j => j.id === job.id);
                if (!this.store.sameJob(fresh, job) || !liveStatus(fresh)) return;
                entry = this._entryAt(fresh, appids, cursor);
                if (entry.policy.cancellable && entry.meta && entry.meta.cancelled) {
                    await advance(freshQueue);
                    continue;
                }
                // An ignore of the game that landed from another host during the
                // wait wins over this rollback or automated ignore. The log was read
                // since the queue snapshot, so the cursor write reads the queue
                // again (see the skips).
                if (await entry.policy.superseded(this, entry, readAt)) {
                    await advance();
                    continue;
                }
                if (!(await this.lease.holdsLock(job.curatorId, this.ownerId))) return;

                // `prev` is read before _send's timer starts: a throw between the two
                // would leave it renewing the lease for good.
                const prev = await this._prevReason(entry.appid, ignored, readAt);
                const verdict = await this._send(job, cur, entry, ignored, fails + 1, prev);
                if (verdict === VERDICT.STOP) return VERDICT.STOP;
                if (verdict === VERDICT.RETRY) {
                    fails += 1;
                    continue;
                }
                await advance();
                if (verdict === VERDICT.LANDED && entry.policy.reconcile) {
                    await this._reconcile(job, entry, prev);
                }
            }
        }
    }

    window.ILAP.Curator.CuratorQueueDrainer = CuratorQueueDrainer;
})();
