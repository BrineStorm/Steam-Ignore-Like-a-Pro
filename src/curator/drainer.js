// SPDX-License-Identifier: GPL-3.0-or-later
//
// DISCLAIMER: This drainer issues bulk ignore actions to Steam on the user's
// behalf. Provided "as is", without warranty. Use at your own risk; you are
// responsible for your own account and for respecting Steam's Terms of Service.
(function() {
    'use strict';

    // Curator queue drainer. Runs in every store tab (Phase 2) and — Chromium
    // only — in the background service worker (src/background.js), which joins
    // the same per-job lease/handoff protocol as just another drainer (Phase 3).
    // The ignore POST does NOT need a page context: it needs only the
    // Steam_Language cookie, which any Steam visit sets. (An earlier header
    // claimed Akamai 400s the POST outside a content-script context — that was
    // disproven by direct A/B probing and is exactly backwards: draining runs
    // wherever the cookie jar is, a tab is just one of the hosts.) In a tab it
    // boots on every store page; with an empty queue it is fully idle after the
    // one boot read (the standby interval only ticks while a job exists;
    // onChanged wakes it).
    //
    // Safety contract:
    //  - serial POSTs only, ~300–800 ms jittered gap, NEVER parallel;
    //  - exactly one tab drains a job (per-job lease lock + handoff);
    //  - cursor advances ONLY after a confirmed ignore (or a userdata-dedupe
    //    skip), so an interrupted POST is at worst retried once and made
    //    idempotent by the dedupe;
    //  - drain-time dedupe against dynamicstore/userdata → rgIgnoredApps.

    window.ILAP = window.ILAP || {};
    window.ILAP.Curator = window.ILAP.Curator || {};

    const REASON = 0;              // same as a manual default ignore
    // Inter-request pacing now lives in the shared IgnoreGate (window.ILAP.IgnoreGate,
    // injected here as deps.gate): one governor budgets the AGGREGATE ignore rate
    // across the drainer, EQ, DQ and every tab, so per-source jitter here would only
    // double-pace. The gate also owns the defensive floor and the master/dead-session stop.
    const HEARTBEAT_MS = 3000;     // renew the lease well within its 8 s TTL
    const MAX_FAILS = 3;           // give up on a single appid after N failed POSTs
    const RETRY_TICK_MS = 9000;    // standby poll: steal an expired lease / pick up work
    // How long a drainer sits out after a POST failure that a login probe blamed
    // on the session (or on the network being down). Without it the standby tick
    // would re-POST every RETRY_TICK_MS for as long as the tab is open — a hot
    // retry loop against Steam is exactly what this extension is built not to do.
    // One minute is short enough that a re-login resumes on its own.
    const DEAD_SESSION_PARK_MS = 60000;
    // rgIgnoredApps (Steam's userdata) lags a fresh ignore POST by a few
    // seconds. An undo job's inverse dedupe reads "appid absent from the set"
    // as "already rolled back" — but for an appid ignored within this window
    // the set is not yet authoritative, so the skip is refused and the remove
    // POST fires instead (idempotent on a not-ignored appid). Comfortably above
    // the observed lag (DQ confirms an ignore within ~4 s of the POST).
    const UNDO_FRESH_MS = 15000;

    const uuid = () => window.ILAP.newOwnerId('d_');

    // Job-type predicates. Direction is a property of the JOB (see the twin-job
    // note in curator/store.js): 'undo' is the droplist rollback, 'miundo' the
    // solo un-ignore gesture — both POST remove=1 and both need the undo pass
    // policy (strict userdata, live probe on an empty set, INVERTED dedupe,
    // "last user intent wins"). 'mi' and 'miundo' are the two gesture jobs and
    // share the drainer's foreground priority.
    const isUndoType = (type) => type === 'undo' || type === 'miundo';
    const isForeground = (type) => type === 'mi' || type === 'miundo';

    // Half of "is this job drainable": it is MEANT to run and carries a list.
    // Anything else is 'paused' (user intent) or 'enumerating' (a filter switch
    // re-resolving the list). Says nothing about progress — that half needs the
    // job's cursor, which is a storage read, so it lives in `_drainable` below.
    const runnable = (j) =>
        (j.status === 'running' || j.status === 'pending')
        && Array.isArray(j.appids);

    class CuratorQueueDrainer {
        constructor(deps) {
            this.store = deps.store;
            this.api = deps.api;                       // { ignore(appid, reason), unignore(appid) }
            this.gate = deps.gate;                     // { reserve() } — aggregate rate governor
            // Cheap pre-pass stop check (the gate's own master/session verdict).
            // Optional: stubs and partial builds fall back to "never stopped",
            // which only costs the pass the gate would have refused anyway.
            this.stopped = (deps.gate && deps.gate.stopped) || (async () => null);
            this.fetchUserdata = deps.fetchUserdata;   // () => Promise<Set<string>>
            // Undo log hooks: append on every confirmed curator ignore; markUndone /
            // lastIgnoredAt / wasReIgnoredAfter for undo jobs. Optional so the drainer
            // still works (units, partial builds) without the log module.
            this.log = deps.log || null;
            // Last-Ignored stats hook (name, reason) — written by the drainer only
            // for type:'mi' jobs, so a deferred manual swipe still updates the
            // popup's "Last Ignored" when its POST lands (curator/undo drains
            // deliberately never touch it). Optional: partial builds / the SW host
            // that can't reach StatsManager pass null and the MI ignore is still
            // logged (undoable) — just not counted into Last Ignored.
            this.saveStats = deps.saveStats || null;
            // Total-only stats hook () — the curator counterpart of saveStats,
            // written for type:'curator' jobs alone. A curator ignore has no name
            // to show and comes in job-sized batches, so it counts into the total
            // and stays out of the 20-entry history (see StatsLogic.countState).
            // MI does NOT go through here: its saveStats already increments the
            // same counter. Optional, like saveStats.
            this.bumpCount = deps.bumpCount || null;
            // Its mirror () — the total counts ignores that are still standing,
            // so a CONFIRMED rollback (any undo type, whatever ignored the game:
            // curator, MI, EQ or DQ) takes one back out of it. The history is
            // left alone, the same way bumpCount leaves it alone. Optional too.
            this.dropCount = deps.dropCount || null;
            // Live login probe (SteamAuth.probeLogin) — consulted only by undo
            // jobs when userdata comes back EMPTY (see _drainJob). Defaults to
            // "confirmed" so stubs/partial builds keep the old behaviour.
            this.probeLogin = deps.probeLogin || (async () => true);
            this.ownerId = deps.ownerId || uuid();
            // Standby retry period; 0 disables the interval entirely (the SW
            // host schedules chrome.alarms instead — a setInterval would both
            // die with the worker and, while ticking, keep it alive artificially).
            this.standbyMs = deps.standbyMs === undefined ? RETRY_TICK_MS : deps.standbyMs;
            this.draining = false;
            this._timer = null;
            // Set when a failed POST was blamed on the session (see _drainJob);
            // in-memory on purpose — a fresh page load means a fresh drainer, and
            // a re-login always goes through one.
            this._parkedUntil = 0;
        }

        start() {
            this._onChange = (changes, area) => {
                if (area !== 'local') return;
                const touched = changes.ilap_curator_queue
                    || changes.ilap_master_enabled   // re-enabling the master resumes a gate-stopped drain
                    || Object.keys(changes).some(k => k.indexOf('ilap_curator_lock_') === 0);
                if (touched) this._kick();
            };
            chrome.storage.onChanged.addListener(this._onChange);
            // The standby retry interval is armed by drain() only while the queue
            // holds a job (see _syncStandbyTimer) — with a permanently empty queue
            // every store tab would otherwise pay one storage read per tick
            // forever, while onChanged already catches new jobs the moment they
            // are staged.
            this._kick();
        }

        _kick() { this.drain().catch(() => {}); }

        // Standby retry: lets a tab steal a lease orphaned by a closed holder,
        // and retries a gate-stopped pass. Only worth ticking while a job exists.
        _syncStandbyTimer(hasWork) {
            if (!this.standbyMs) return;
            if (hasWork && !this._timer) {
                this._timer = setInterval(() => this._kick(), this.standbyMs);
            } else if (!hasWork && this._timer) {
                clearInterval(this._timer);
                this._timer = null;
            }
        }

        // The two GESTURE jobs are picked FIRST: an MI ignore and a solo
        // un-ignore are live user actions and must clear ahead of background
        // curator/undo work.
        //
        // Between the two, the ROLLBACK goes first. They cannot share a bucket
        // and be fair: the bucket resolves by array position, so whichever job
        // happens to sit earlier is looked at first — "whichever the user did
        // last" is not something position can express. Given that, un-ignore is
        // the right winner twice over: a rollback is by construction the later
        // intent (you can only take back a game you already swiped), and it is
        // the one leaving a VISIBLE provisional mark on the page while it waits
        // — an MI ignore's badge is painted the moment the swipe lands, so its
        // wait shows nothing. The reverse starvation is also far cheaper: you do
        // not gesture hundreds of rollbacks.
        //
        // Order alone would only settle which job a pass STARTS on, and a pass
        // runs its job to the end — see `_preemptedBy`, which is what makes this
        // priority mean anything for a gesture made mid-drain.
        async _pickJob(queue) {
            const ready = [];
            for (const j of queue) if (await this._drainable(j)) ready.push(j);
            return ready.find(j => j.type === 'miundo')
                || ready.find(j => isForeground(j.type))
                || ready[0] || null;
        }

        // A job's real drain progress. The cursor lives in a key of its OWN (the
        // partitioning note in curator/store.js) — the `cursor` FIELD on the queue
        // record is a legacy pre-cursor-key value that no build has written since,
        // so reading it alone reports 0 for every job the drainer has ever
        // touched. The same read the drain loop takes for the job it is on, and
        // the reason the two predicates below are async at all.
        async _cursorOf(job) {
            const keyCursor = await this.store.getCursor(job.id);
            return keyCursor != null ? keyCursor : (job.cursor || 0);
        }

        // The whole question: meant to run, and something left to do.
        async _drainable(job) {
            return runnable(job) && (await this._cursorOf(job)) < job.appids.length;
        }

        // Hand the drain over to a solo un-ignore gestured while this pass was
        // already running. Without it `_pickJob`'s priority is only consulted
        // BETWEEN passes, so the rollback waited out whatever was draining: a
        // 200-entry MI backlog at ~0.6 s a POST is minutes, a curator job is
        // hours — and all of it spent on a badge dimmed as "rolling back",
        // which is precisely the wait the priority exists to prevent.
        // The queue here is the read the loop already takes, and the one extra
        // storage read is spent only when a rollback job is actually there (its
        // id is fixed, so there is at most one). Returning ends the pass;
        // `drain()` releases the lease on the way out, picks the rollback, and
        // comes back to this job afterwards — it resumes from its cursor, having
        // lost nothing but the userdata GET at the top of the next pass.
        //
        // Only the ROLLBACK preempts, deliberately. Letting an MI swipe cut into
        // a curator job would pay that GET once per swipe, and swipes are the
        // frequent direction — while the swipe's own badge is already painted
        // and its wait invisible.
        async _preemptedBy(queue, job) {
            if (job.type === 'miundo') return false;
            const rollback = queue.find(j => j.type === 'miundo');
            return !!rollback && await this._drainable(rollback);
        }

        // Public probe for host schedulers (the SW's alarm re-arm): does the
        // queue hold a job this drainer could pick up?
        async hasDrainableWork(queue) {
            return !!(await this._pickJob(queue));
        }

        // A job with a live status whose cursor already sits at the end: a
        // completion that did not finish. `_drainJob` drops the job the moment it
        // sees that state, but the pass can die in the window between the last
        // setCursor and the next loop top — a stolen lease, a closed tab, a killed
        // worker — and while the picker was blind to progress the leftover was
        // collected by simply being picked again. A picker that only takes real
        // work would never look at it, and it would sit there for good: 100 % in
        // the queue applet, the standby tick armed forever, the SW re-arming its
        // alarm for nothing. So the pass that finds nothing to drain collects it.
        // `removeIfDrained` re-checks emptiness inside the queue mutation (a
        // gesture may have appended meanwhile) and takes no lease, being a
        // serialized queue write like every other one here.
        async _collectDrained(queue) {
            for (const j of queue) {
                if (!runnable(j)) continue;
                const cursor = await this._cursorOf(j);
                if (cursor < j.appids.length) continue;
                if (await this.store.removeIfDrained(j.id, cursor)) {
                    await this.store.signalCompleted();
                }
            }
        }

        // An entry the drain is stepping over WITHOUT performing it (a permanent
        // per-appid refusal, or every retry failed). The two job types that show
        // the user something need opposite corrections:
        //  - MI badged the game optimistically at swipe time and that badge now
        //    lies → drop it, tagged 'failed' so the swiping tab can say why;
        //  - undo has nothing to un-badge (the game stays ignored, which is what
        //    its badge already says) — but the rollback the user asked for will
        //    never happen, so pulse that instead of ending as a silent "done".
        // Both signals are optional deps (stubs / partial builds skip them).
        async _reportDropped(job, appid) {
            if (job.type === 'mi') {
                if (this.store.signalUnignored) await this.store.signalUnignored(appid, 'failed');
            } else if (isUndoType(job.type)) {
                // Both rollback types report the same way — and for the solo
                // gesture this pulse doubles as "drop the pending mark", since
                // the badge it left dimmed has to go back to looking ignored.
                if (this.store.signalUndoFailed) await this.store.signalUndoFailed('failed');
            }
        }

        // The one cancel window the cursor cannot describe. `Store.cancelMiEntry`
        // answers "was this swipe still pending?" from the cursor — but the cursor
        // only advances once the POST has RETURNED, so a gesture landing while the
        // request is in flight is told it cancelled an ignore that was by then
        // already sent. The tab drops the badge, the user believes the swipe never
        // happened, and Steam has the game ignored: silent, and the opposite of
        // what they asked for. A slow POST is all it takes.
        // Checked AFTER the cursor moved, which is what closes the window rather
        // than narrowing it: a cancel arriving any later reads the advanced cursor,
        // is refused, and the tab queues the rollback itself.
        // The correction is a real rollback, not a repainted badge — the ignore
        // did land, and stays counted and logged exactly as it happened. The new
        // entry carries the gesture's own `ts`, so "last intent wins" still points
        // the right way, and the confirmed un-ignore clears the badge everywhere
        // through the usual pulse.
        async _compensateCancelled(job, appid) {
            if (!this.store.enqueueMiUndo) return;
            const after = (await this.store.getQueue()).find(j => j.id === job.id);
            const meta = after && after.meta ? after.meta[appid] : null;
            if (meta && meta.cancelled) await this.store.enqueueMiUndo({ appid });
        }

        // Step over an entry that will never be performed, leaving the honest
        // record. The two callers differ only in WHY: 'unavailable' (a permanent
        // per-appid refusal, classified from a 400) and 'failed' (every retry
        // refused) — and 'unavailable' additionally counts into the job row's
        // skip line, whose label names the region lock and so cannot speak for
        // the other case.
        //
        // The log entry is what survives a dropped entry: the per-job skip
        // counter dies with the job and the live push card needs a listening tab
        // (the SW route has none by design). It costs no extra volume — a game
        // that had landed would have been appended here anyway — and `skipped`
        // keeps it inert for every undo selector. Undo jobs are excluded on
        // purpose: a rollback that failed must stay LIVE in the log so the next
        // "undo the last N" picks it up again.
        async _dropEntry(cur, cursor, appid, miMeta, why) {
            if (why === 'unavailable') await this.store.bumpSkipped(cur.id);
            if (!isUndoType(cur.type) && this.log) {
                await this.log.append(cur.type === 'mi'
                    ? { appid, name: miMeta ? miMeta.name : '', source: 'mi', skipped: why }
                    : { appid, source: 'curator', curatorId: cur.curatorId, skipped: why });
            }
            await this._reportDropped(cur, appid);
            await this.store.setCursor(cur.id, cursor + 1);
        }

        async drain() {
            if (this.draining || Date.now() < this._parkedUntil) return;
            this.draining = true;
            try {
                while (true) {
                    const queue = await this.store.getQueue();
                    this._syncStandbyTimer(queue.length > 0);
                    const job = await this._pickJob(queue);
                    // Nothing to drain — but the queue can still hold a job that
                    // finished without being removed (see _collectDrained).
                    if (!job) {
                        await this._collectDrained(queue);
                        break;
                    }
                    // The gate refuses every slot while the master toggle is off
                    // or the session is dead — but that verdict lands AFTER
                    // _drainJob has taken a lease and spent a userdata GET, and
                    // the SW re-arms its retry alarm for as long as drainable
                    // work exists. A disabled extension therefore kept paying a
                    // network read per tab per standby tick, forever. Ask the
                    // same verdict up front instead: re-enabling the master
                    // writes storage and onChanged kicks us, and the stops that
                    // announce nothing (a logout, an outage) are re-asked by the
                    // standby tick — or, in the SW, by its retry alarm.
                    if (await this.stopped()) break;
                    const got = await this.store.acquireLock(job.curatorId, this.ownerId);
                    if (!got) break;   // another tab owns this job → we stay standby
                    let result;
                    try {
                        result = await this._drainJob(job);
                    } finally {
                        await this.store.releaseLock(job.curatorId, this.ownerId);
                    }
                    // The gate said stop (master off / no session), or a 429
                    // backoff was just reported: the job is still drainable, so
                    // re-picking it would busy-loop. Break the pass and wait for
                    // the next kick (a queue/lock/master change, or the retry
                    // tick) to resume.
                    if (result === 'stop') break;
                }
            } finally {
                this.draining = false;
            }
        }

        async _drainJob(job) {
            // No stored 'running' status: the UI derives "running" from the live
            // lease. The drainer's only queue-array write is the final removeJob,
            // so it can never clobber a concurrent pause/remove from the applet.
            const isUndoJob = isUndoType(job.type);
            // Curator jobs tolerate a failed userdata read: an empty set only
            // disables the dedupe (every POST fires — safe). An undo job must
            // NOT fall back to empty: its skip direction is inverted, so
            // "nothing in the set" would skip-burn the whole job to completion
            // with zero requests. Strict read (null on failure) → stop the pass;
            // the standby tick / next kick retries with fresh userdata.
            const userdata = await this.fetchUserdata().catch(() => null);
            if (isUndoJob && !userdata) return 'stop';
            // An EMPTY set is also exactly what a logged-out userdata read
            // returns (200 + default arrays), and the inverse-skip path never
            // reaches the gate's dead-session check — confirm the session live
            // before trusting "nothing is ignored". (The legit empty case — the
            // user manually rolled back everything — passes the probe and the
            // job completes via skips.)
            if (isUndoJob && userdata.size === 0
                && (await this.probeLogin()) !== true) return 'stop';
            const ignored = userdata || new Set();
            let lastBeat = Date.now();
            let fails = 0;

            while (true) {
                const queue = await this.store.getQueue();
                const cur = queue.find(j => j.id === job.id);
                if (!cur) return;                       // removed from the queue
                // Anything but a drainable status stops this pass: 'paused' (user
                // intent) or 'enumerating' (filter switch re-resolving the list).
                // 'running' is a legacy stored value from the pre-cursor-key model.
                if (cur.status !== 'pending' && cur.status !== 'running') return;
                // A rollback gestured since this pass started takes over.
                if (await this._preemptedBy(queue, cur)) return;
                if (!(await this.store.holdsLock(job.curatorId, this.ownerId))) return; // lost lease

                // Renew the lease on EVERY loop path, not just after a POST: a
                // long run of dedupe-skips (typical re-run over a mostly-ignored
                // list) would otherwise advance the cursor past the 8 s TTL with
                // no heartbeat, letting a standby tab steal the lock mid-drain.
                if (Date.now() - lastBeat > HEARTBEAT_MS) {
                    await this.store.renewLock(job.curatorId, this.ownerId);
                    lastBeat = Date.now();
                }

                const cursor = await this._cursorOf(cur);
                if (cursor >= cur.appids.length) {
                    // Finished: drop the job entirely (no lingering "done" record) and
                    // emit a completion pulse so the widget blinks once. removeIfDrained
                    // re-checks emptiness inside the queue mutation, so an MI swipe that
                    // appended in the window between the snapshot above and here keeps
                    // the job alive instead of being wiped — loop back to drain it.
                    if (!(await this.store.removeIfDrained(job.id, cursor))) continue;
                    await this.store.signalCompleted();
                    return;
                }

                const isUndo = isUndoType(cur.type);
                const isMi = cur.type === 'mi';
                const appid = String(cur.appids[cursor]);
                // MI entries carry their own name + ignore reason (a swipe can be
                // reason 0 "Default" or 2 "Played Elsewhere"); everything else
                // ignores with the default reason.
                const miMeta = isMi && cur.meta ? cur.meta[appid] : null;
                const miReason = miMeta && Number.isFinite(miMeta.reason) ? miMeta.reason : REASON;

                // The swipe was taken back before it was ever sent (Store
                // .cancelMiEntry): step over it silently. Nothing to report —
                // the gesture already un-badged it, and an ignore that never
                // happened has nothing to log, count or roll back.
                if (isMi && miMeta && miMeta.cancelled) {
                    await this.store.setCursor(job.id, cursor + 1);
                    fails = 0;
                    continue;
                }
                // "Last user intent wins" boundary. The droplist undo job is a
                // one-shot STATIC snapshot, so one job-level ts is right for it.
                // The solo-un-ignore job auto-fills for as long as it lives, so a
                // job-level ts would be the moment the FIRST gesture created it —
                // a game ignored after that but un-ignored by a later gesture
                // would look "re-ignored after the snapshot" and be skipped. Its
                // entries therefore carry their own gesture time in `meta`.
                const entryTs = (cur.meta && cur.meta[appid] && cur.meta[appid].ts)
                    || cur.snapshotTs || 0;

                // Dedupe against the live ignore state — inverted for undo jobs:
                // a curator job skips an appid that's ALREADY ignored; an undo job
                // skips one that's already NOT ignored (rolled back manually, or
                // never landed). Count it as done, no request, no slot. The skip
                // still marks the log entries undone (userdata is trusted here —
                // see the strict read above), so a stale "already rolled back"
                // appid can't inflate "of N" and eat later undo budgets forever.
                if (isUndo ? !ignored.has(appid) : ignored.has(appid)) {
                    // …but userdata LAGS a fresh ignore POST. For an undo job an
                    // appid ignored within UNDO_FRESH_MS may simply not be in the
                    // set yet: trusting the skip there would markUndone it with no
                    // remove POST, stranding the game ignored and burning its log
                    // entry out of the undoable pool. Only trust the skip once the
                    // ignore is old enough that the set is authoritative; otherwise
                    // fall through to the POST (remove=1 is idempotent). Curator
                    // jobs never enter this branch (isUndo false → not fresh).
                    const freshIgnore = isUndo && this.log
                        && Date.now() - (await this.log.lastIgnoredAt(appid)) < UNDO_FRESH_MS;
                    if (!freshIgnore) {
                        if (isUndo && this.log) {
                            await this.log.markUndone(appid, entryTs);
                        }
                        await this.store.setCursor(job.id, cursor + 1);
                        fails = 0;
                        continue;
                    }
                }

                // Undo "last user intent wins" rule: an appid RE-ignored after the
                // undo job's snapshot was a deliberate later action — skip it, and
                // don't mark its log entries undone (they weren't).
                if (isUndo && this.log
                    && await this.log.wasReIgnoredAfter(appid, entryTs)) {
                    await this.store.setCursor(job.id, cursor + 1);
                    fails = 0;
                    continue;
                }

                // Reserve an aggregate rate slot before every POST — un-ignores
                // hit the same endpoint as ignores, so they draw from the same
                // budget. A stop verdict (master off / dead session) ends the pass
                // WITHOUT advancing the cursor — so a logged-out drain can't
                // silently burn the whole job (audit #2), and a disabled extension
                // emits no ignores (audit #1).
                const slot = await this.gate.reserve();
                if (!slot.ok) return 'stop';

                // The reservation can wait out several paced slots; a pause or
                // remove landing during that wait must stop BEFORE the POST (the
                // status check at the top of the loop ran before the wait).
                const fresh = (await this.store.getQueue()).find(j => j.id === job.id);
                if (!fresh || (fresh.status !== 'pending' && fresh.status !== 'running')) return;
                // A cancel landing during that same wait is the race the whole
                // cancel path exists for: this entry is the one the gesture was
                // aimed at, and it has NOT been posted yet. Re-check on the
                // fresh record, not the snapshot taken before the wait.
                if (isMi && fresh.meta && fresh.meta[appid] && fresh.meta[appid].cancelled) {
                    await this.store.setCursor(job.id, cursor + 1);
                    fails = 0;
                    continue;
                }
                // The lease can be stolen during the same wait (e.g. this tab was
                // backgrounded and its heartbeat lapsed): the single-drainer
                // invariant needs a live lease at POST time, not just at loop top.
                if (!(await this.store.holdsLock(job.curatorId, this.ownerId))) return;

                const res = isUndo
                    ? await this.api.unignore(appid)
                    : await this.api.ignore(appid, isMi ? miReason : REASON);
                if (res && res.ok) {
                    if (isUndo) {
                        ignored.delete(appid);
                        // Mark the rolled-back log entries so a later undo can't
                        // re-undo them (and the re-stage warning can see them).
                        if (this.log) await this.log.markUndone(appid, entryTs);
                        // …and take the ignore back out of the popup's total —
                        // only here, on a landed remove=1 POST: a dedupe skip
                        // above rolled nothing back (the game was already not
                        // ignored, so its decrement, if it was ever ours, was
                        // taken the first time round). Accepted residual: an appid
                        // sitting in BOTH gesture and droplist rollback jobs can
                        // decrement twice when userdata still shows it ignored as
                        // the second pass reads it (the same lag double-fires
                        // markUndone, harmlessly, via the idempotent POST here) —
                        // one unit off a floored cosmetic counter, in a window the
                        // gate's pacing makes rare.
                        if (this.dropCount) await this.dropCount();
                        // Clear this game's on-page IGNORED badge in every MI tab
                        // (per-appid pulse; the badge otherwise lingers and lies).
                        if (this.store.signalUnignored) await this.store.signalUnignored(appid);
                    } else if (isMi) {
                        ignored.add(appid);
                        // Truthful at drain time: only now that the POST landed do
                        // we count it into Last Ignored and the undo log (source
                        // 'mi', name resolved at swipe time). saveStats is gated
                        // strictly to MI — curator/undo drains never touch it.
                        const name = miMeta ? miMeta.name : '';
                        if (this.saveStats) await this.saveStats(name, miReason);
                        if (this.log) await this.log.append({ appid, name, source: 'mi' });
                    } else {
                        ignored.add(appid);
                        // Every drained curator ignore lands in the undo log
                        // (appid-only — enumeration never captures names) and in
                        // the popup's total. Both only now that the POST landed:
                        // a skipped or refused appid was never ignored.
                        if (this.log) await this.log.append({
                            appid, source: 'curator', curatorId: job.curatorId
                        });
                        if (this.bumpCount) await this.bumpCount();
                    }
                    await this.store.setCursor(job.id, cursor + 1);
                    if (isMi) await this._compensateCancelled(job, appid);
                    fails = 0;
                } else if (res && res.rateLimited) {
                    // 429: the server is throttling the ACCOUNT, not this appid —
                    // charging it against fails would skip innocent games. Push
                    // the shared gate into backoff and end the pass; the standby
                    // tick / next kick retries, and reserve() waits the penalty out.
                    await this.gate.reportRateLimited(res.retryAfterMs);
                    return 'stop';
                } else if (res && res.unavailable) {
                    // The api layer classified this 400 as a PERMANENT per-appid
                    // refusal (no store object in the account's region), not a
                    // systemic failure: retrying is pointless, so skip it now —
                    // no MAX_FAILS burn — and count it honestly instead of
                    // letting the job end as a silent "done". A skipped appid
                    // was never ignored, so an undo job neither logs nor marks
                    // anything for it.
                    await this._dropEntry(cur, cursor, appid, miMeta, 'unavailable');
                    fails = 0;
                } else {
                    // Before charging this appid for the failure, make sure the
                    // failure is even about the appid. A session that dies mid-pass
                    // 400s EVERY POST while `gate.reserve()` keeps granting slots:
                    // its own login check is cheap on purpose (a signed-in store
                    // header is trusted, a confirmed probe is cached for a minute),
                    // so it lags the session by up to that much — MAX_FAILS would
                    // then walk the entire job three wasted slots at a time and
                    // end as a silent "done" with nothing ignored. The appdetails
                    // classifier above can't catch that: it fires only on a
                    // region-locked appid. A live login probe can, and the same
                    // answer covers a network outage. Stop the pass with the
                    // cursor untouched, and sit out DEAD_SESSION_PARK_MS so the
                    // standby tick doesn't turn this into a retry loop. (In the
                    // SW the ilap_sw_halt breaker still counts the failure at the
                    // api boundary — the two are complementary: it catches a
                    // stale sid / missing Steam_Language, where the session
                    // itself is perfectly alive and this probe says so.)
                    if ((await this.probeLogin()) !== true) {
                        this._parkedUntil = Date.now() + DEAD_SESSION_PARK_MS;
                        return 'stop';
                    }
                    // Don't advance on failure (cursor only moves on confirmed
                    // ignore); retry a few times, then skip so one bad appid can't
                    // wedge the whole job.
                    fails += 1;
                    if (fails >= MAX_FAILS) {
                        // Same disposition as the unavailable skip above, for an
                        // entry that failed every retry instead. It does NOT
                        // count into the job row's skip line — that label names
                        // the region lock — but it leaves the same durable log
                        // record, which is the only trace a drop leaves at all.
                        await this._dropEntry(cur, cursor, appid, miMeta, 'failed');
                        fails = 0;
                    }
                }
                // No local sleep — the gate.reserve() above already paced this pass.
            }
        }
    }

    window.ILAP.Curator.CuratorQueueDrainer = CuratorQueueDrainer;

    // Boot only when the storage model + rate gate are present (both load before
    // this script).
    if (window.ILAP.Curator.Store && window.ILAP.apiIgnoreGame
        && window.ILAP.apiUnignoreGame && window.ILAP.IgnoreGate) {
        // Cache the sessionid for the SW drainer (src/background.js): under the
        // storage-only permission set the SW cannot read document.cookie. Written
        // at page boot rather than enqueue time so a re-login refreshes it, and a
        // store-page visit doubles as the recovery action for a halted SW route:
        // ilap_sw_halt (set by the SW after consecutive failed POSTs) is cleared
        // here. Write only on change — every store page runs this, and a
        // same-value write would wake the SW via onChanged for nothing.
        const sid = window.ILAP.getSessionID();
        if (sid) {
            chrome.storage.local.get({ ilap_sw_sid: null, ilap_sw_halt: false }, (d) => {
                if (d.ilap_sw_sid !== sid || d.ilap_sw_halt) {
                    chrome.storage.local.set({ ilap_sw_sid: sid, ilap_sw_halt: false });
                }
            });
        }
        const Log = window.ILAP.IgnoreLog;
        // 400-classification at the api boundary (the drainer only reads the
        // verdict). The rule itself is world-agnostic and lives in steam-net.js
        // beside the probe it uses; the worker wraps its own POST with the same
        // call. What is specific here: the wrap sits in this adapter and
        // deliberately NOT inside apiIgnoreGame itself — MI/EQ/DQ share that
        // function and none of them retries or halts on a failed appid, so they
        // have no use for the extra GET.
        const classifyRefusal = (appid, res) =>
            window.ILAP.classifyRefusal(appid, res);
        const drainer = new CuratorQueueDrainer({
            store: window.ILAP.Curator.Store,
            api: {
                ignore: async (appid, reason) =>
                    classifyRefusal(appid, await window.ILAP.apiIgnoreGame(appid, reason)),
                unignore: async (appid) =>
                    classifyRefusal(appid, await window.ILAP.apiUnignoreGame(appid))
            },
            gate: {
                reserve: () => window.ILAP.IgnoreGate.reserve(),
                reportRateLimited: (ms) => window.ILAP.IgnoreGate.reportRateLimited(ms),
                stopped: () => window.ILAP.IgnoreGate.stopVerdict()
            },
            // Strict (null on failure) — _drainJob falls back to the lenient
            // empty set itself for curator jobs and STOPS for undo jobs.
            fetchUserdata: () => window.ILAP.fetchIgnoredAppsStrict(),
            probeLogin: () => window.ILAP.SteamAuth.probeLogin(),
            // Last-Ignored stats for drained MI ignores only (reason → the same
            // human label the old instant MI path used, mapped by the store that
            // owns the reason). saveStats lives in utils.js, present in the
            // content-script world.
            saveStats: window.ILAP.saveStats
                ? (name, reason) => window.ILAP.saveStats(
                    name, window.ILAP.Curator.Store.miSourceLabel(reason))
                : null,
            // Total-only counterpart for drained curator ignores, and its mirror
            // for confirmed rollbacks (same module).
            bumpCount: window.ILAP.bumpIgnoredCount || null,
            dropCount: window.ILAP.dropIgnoredCount || null,
            log: Log ? {
                append: (entry) => Log.append(entry),
                markUndone: (appid, ts) => Log.markUndone(appid, ts),
                lastIgnoredAt: async (appid) =>
                    Log.lastIgnoredAt(await Log.getLog(), appid),
                wasReIgnoredAfter: async (appid, ts) =>
                    Log.reIgnoredAfter(await Log.getLog(), appid, ts)
            } : null
        });
        window.ILAP.Curator.drainer = drainer;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => drainer.start());
        } else {
            drainer.start();
        }
    }
})();
