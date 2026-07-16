// SPDX-License-Identifier: GPL-3.0-or-later
//
// DISCLAIMER: This drainer issues bulk ignore actions to Steam on the user's
// behalf. Provided "as is", without warranty. Use at your own risk; you are
// responsible for your own account and for respecting Steam's Terms of Service.
(function() {
    'use strict';

    // Phase-2 curator queue drainer — Variant A: an opportunistic content-script
    // worker, NO service worker. The ignore POST only succeeds from a live
    // store.steampowered.com content-script context (Akamai 400s it elsewhere),
    // so draining runs in whatever Steam tab happens to be open. Boots on every
    // store page; with an empty queue it is fully idle after the one boot read
    // (the standby interval only ticks while a job exists; onChanged wakes it).
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

    const uuid = () => window.ILAP.newOwnerId('d_');

    class CuratorQueueDrainer {
        constructor(deps) {
            this.store = deps.store;
            this.api = deps.api;                       // { ignore(appid, reason) }
            this.gate = deps.gate;                     // { reserve() } — aggregate rate governor
            this.fetchUserdata = deps.fetchUserdata;   // () => Promise<Set<string>>
            this.ownerId = deps.ownerId || uuid();
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
            if (hasWork && !this._timer) {
                this._timer = setInterval(() => this._kick(), RETRY_TICK_MS);
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
            const ignored = await this.fetchUserdata().catch(() => new Set());
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

                const appid = String(cur.appids[cursor]);
                if (ignored.has(appid)) {
                    // Already ignored (dedupe) — count it as done, no request, no slot.
                    await this.store.setCursor(job.id, cursor + 1);
                    fails = 0;
                    continue;
                }

                // Reserve an aggregate rate slot before every POST. A stop verdict
                // (master off / dead session) ends the pass WITHOUT advancing the
                // cursor — so a logged-out drain can't silently burn the whole job
                // (audit #2), and a disabled extension emits no ignores (audit #1).
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

                const res = await this.api.ignore(appid, REASON);
                if (res && res.ok) {
                    ignored.add(appid);
                    await this.store.setCursor(job.id, cursor + 1);
                    fails = 0;
                } else if (res && res.rateLimited) {
                    // 429: the server is throttling the ACCOUNT, not this appid —
                    // charging it against fails would skip innocent games. Push
                    // the shared gate into backoff and end the pass; the standby
                    // tick / next kick retries, and reserve() waits the penalty out.
                    await this.gate.reportRateLimited(res.retryAfterMs);
                    return 'stop';
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
    if (window.ILAP.Curator.Store && window.ILAP.apiIgnoreGame && window.ILAP.IgnoreGate) {
        const drainer = new CuratorQueueDrainer({
            store: window.ILAP.Curator.Store,
            api: { ignore: (appid, reason) => window.ILAP.apiIgnoreGame(appid, reason) },
            gate: {
                reserve: () => window.ILAP.IgnoreGate.reserve(),
                reportRateLimited: (ms) => window.ILAP.IgnoreGate.reportRateLimited(ms)
            },
            fetchUserdata: () => window.ILAP.fetchIgnoredApps()
        });
        window.ILAP.Curator.drainer = drainer;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => drainer.start());
        } else {
            drainer.start();
        }
    }
})();
