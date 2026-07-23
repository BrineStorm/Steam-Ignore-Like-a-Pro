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
    // rgIgnoredApps (Steam's userdata) lags a fresh ignore POST by a few
    // seconds. An undo job's inverse dedupe reads "appid absent from the set"
    // as "already rolled back" — but for an appid ignored within this window
    // the set is not yet authoritative, so the skip is refused and the remove
    // POST fires instead (idempotent on a not-ignored appid). Comfortably above
    // the observed lag (DQ confirms an ignore within ~4 s of the POST).
    const UNDO_FRESH_MS = 15000;

    const uuid = () => window.ILAP.newOwnerId('d_');

    class CuratorQueueDrainer {
        constructor(deps) {
            this.store = deps.store;
            this.api = deps.api;                       // { ignore(appid, reason), unignore(appid) }
            this.gate = deps.gate;                     // { reserve() } — aggregate rate governor
            this.fetchUserdata = deps.fetchUserdata;   // () => Promise<Set<string>>
            // Undo log hooks: append on every confirmed curator ignore; markUndone /
            // lastIgnoredAt / wasReIgnoredAfter for undo jobs. Optional so the drainer
            // still works (units, partial builds) without the log module.
            this.log = deps.log || null;
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

        // A job is drainable if it's meant to run and still has work left.
        _pickJob(queue) {
            return queue.find(j =>
                (j.status === 'running' || j.status === 'pending')
                && Array.isArray(j.appids)
                && (j.cursor || 0) < j.appids.length
            ) || null;
        }

        // Public probe for host schedulers (the SW's alarm re-arm): does the
        // queue hold a job this drainer could pick up?
        hasDrainableWork(queue) {
            return !!this._pickJob(queue);
        }

        async drain() {
            if (this.draining) return;
            this.draining = true;
            try {
                while (true) {
                    const queue = await this.store.getQueue();
                    this._syncStandbyTimer(queue.length > 0);
                    const job = this._pickJob(queue);
                    if (!job) break;
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
            const isUndoJob = job.type === 'undo';
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
                const cur = (await this.store.getQueue()).find(j => j.id === job.id);
                if (!cur) return;                       // removed from the queue
                // Anything but a drainable status stops this pass: 'paused' (user
                // intent) or 'enumerating' (filter switch re-resolving the list).
                // 'running' is a legacy stored value from the pre-cursor-key model.
                if (cur.status !== 'pending' && cur.status !== 'running') return;
                if (!(await this.store.holdsLock(job.curatorId, this.ownerId))) return; // lost lease

                // Renew the lease on EVERY loop path, not just after a POST: a
                // long run of dedupe-skips (typical re-run over a mostly-ignored
                // list) would otherwise advance the cursor past the 8 s TTL with
                // no heartbeat, letting a standby tab steal the lock mid-drain.
                if (Date.now() - lastBeat > HEARTBEAT_MS) {
                    await this.store.renewLock(job.curatorId, this.ownerId);
                    lastBeat = Date.now();
                }

                const keyCursor = await this.store.getCursor(job.id);
                // Legacy records (pre-cursor-key) kept the cursor inline.
                const cursor = keyCursor != null ? keyCursor : (cur.cursor || 0);
                if (cursor >= cur.appids.length) {
                    // Finished: drop the job entirely (no lingering "done" record) and
                    // emit a completion pulse so the widget blinks once.
                    await this.store.removeJob(job.id);
                    await this.store.signalCompleted();
                    return;
                }

                const isUndo = cur.type === 'undo';
                const appid = String(cur.appids[cursor]);

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
                            await this.log.markUndone(appid, cur.snapshotTs || 0);
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
                    && await this.log.wasReIgnoredAfter(appid, cur.snapshotTs || 0)) {
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
                // The lease can be stolen during the same wait (e.g. this tab was
                // backgrounded and its heartbeat lapsed): the single-drainer
                // invariant needs a live lease at POST time, not just at loop top.
                if (!(await this.store.holdsLock(job.curatorId, this.ownerId))) return;

                const res = isUndo
                    ? await this.api.unignore(appid)
                    : await this.api.ignore(appid, REASON);
                if (res && res.ok) {
                    if (isUndo) {
                        ignored.delete(appid);
                        // Mark the rolled-back log entries so a later undo can't
                        // re-undo them (and the re-stage warning can see them).
                        if (this.log) await this.log.markUndone(appid, cur.snapshotTs || 0);
                    } else {
                        ignored.add(appid);
                        // Every drained ignore lands in the undo log (appid-only —
                        // enumeration never captures names).
                        if (this.log) await this.log.append({
                            appid, source: 'curator', curatorId: job.curatorId
                        });
                    }
                    await this.store.setCursor(job.id, cursor + 1);
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
                    // anything for it, and a curator job's log entry carries the
                    // `skipped` marker that keeps it out of every undo selector.
                    await this.store.bumpSkipped(job.id);
                    if (!isUndo && this.log) await this.log.append({
                        appid, source: 'curator', curatorId: job.curatorId,
                        skipped: 'unavailable'
                    });
                    await this.store.setCursor(job.id, cursor + 1);
                    fails = 0;
                } else {
                    // Don't advance on failure (cursor only moves on confirmed
                    // ignore); retry a few times, then skip so one bad appid can't
                    // wedge the whole job.
                    fails += 1;
                    if (fails >= MAX_FAILS) {
                        await this.store.setCursor(job.id, cursor + 1);
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
        // verdict): a refused POST for a region-locked appid is permanent —
        // appdetails `success:false` is the positive evidence (see
        // checkAppUnavailable in utils.js). Gated strictly on HTTP 400: the
        // region-lock ⇔ success:false correlation was established for 400, so a
        // timeout / 5xx / dead-network refusal (status 0) must stay on the
        // systemic MAX_FAILS path — else a transient failure coinciding with a
        // sporadic appdetails success:false would falsely skip a live appid in
        // one attempt. Deliberately NOT inside apiIgnoreGame itself: MI/EQ/DQ
        // share that function and none of them retries or halts on a failed
        // appid, so they have no use for the extra GET. Probe failures /
        // available verdicts leave the result unmarked → systemic path stands.
        const classifyRefusal = async (appid, res) => {
            if (res.status === 400
                && (await window.ILAP.checkAppUnavailable(appid)) === true) {
                res.unavailable = true;
            }
            return res;
        };
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
                reportRateLimited: (ms) => window.ILAP.IgnoreGate.reportRateLimited(ms)
            },
            // Strict (null on failure) — _drainJob falls back to the lenient
            // empty set itself for curator jobs and STOPS for undo jobs.
            fetchUserdata: () => window.ILAP.fetchIgnoredAppsStrict(),
            probeLogin: () => window.ILAP.SteamAuth.probeLogin(),
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
