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
    // store page; idle (one storage read) when the queue is empty.
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
    const GAP_MIN = 300;
    const GAP_MAX = 800;
    // Hard lower bound on the inter-request gap. The serial+jittered throttle is
    // the ONLY thing standing between "ignore a 1000-game curator" and a
    // rate-limit / Akamai ban on the user's account. GAP_MIN/MAX above are the
    // intended pacing; GAP_FLOOR is a defensive clamp (applied in jitter()) so a
    // casual edit to those constants can't drop the extension into spam territory
    // without ALSO removing this line. It is a guardrail for honest users and our
    // own future selves — NOT a security control (a determined forker can delete
    // it, just as they could write their own script against the public endpoint).
    const GAP_FLOOR = 250;
    const HEARTBEAT_MS = 3000;     // renew the lease well within its 8 s TTL
    const MAX_FAILS = 3;           // give up on a single appid after N failed POSTs
    const RETRY_TICK_MS = 9000;    // standby poll: steal an expired lease / pick up work
    const USERDATA_URL = 'https://store.steampowered.com/dynamicstore/userdata/';

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const jitter = () => {
        const lo = Math.max(GAP_FLOOR, GAP_MIN);          // never faster than the floor
        const hi = Math.max(lo + 1, GAP_MAX);
        return lo + Math.floor(Math.random() * (hi - lo));
    };
    const uuid = () => 'd_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

    // Read the account's ignored appids once per drain session (READ, not an
    // ignore call). Same source the DQ confirmation uses.
    async function fetchUserdataIgnored() {
        try {
            const res = await fetch(`${USERDATA_URL}?_=${Date.now()}`, {
                credentials: 'include', cache: 'no-store'
            });
            if (!res.ok) return new Set();
            const data = await res.json();
            const ignored = data && data.rgIgnoredApps;
            return new Set(ignored ? Object.keys(ignored).map(String) : []);
        } catch (e) {
            return new Set();
        }
    }

    class CuratorQueueDrainer {
        constructor(deps) {
            this.store = deps.store;
            this.api = deps.api;                       // { ignore(appid, reason) }
            this.fetchUserdata = deps.fetchUserdata;   // () => Promise<Set<string>>
            this.ownerId = deps.ownerId || uuid();
            this.draining = false;
        }

        start() {
            this._onChange = (changes, area) => {
                if (area !== 'local') return;
                const touched = changes.ilap_curator_queue
                    || Object.keys(changes).some(k => k.indexOf('ilap_curator_lock_') === 0);
                if (touched) this._kick();
            };
            chrome.storage.onChanged.addListener(this._onChange);
            // Standby retry: lets a tab steal a lease orphaned by a closed holder.
            this._timer = setInterval(() => this._kick(), RETRY_TICK_MS);
            this._kick();
        }

        _kick() { this.drain().catch(() => {}); }

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
                    const job = this._pickJob(await this.store.getQueue());
                    if (!job) break;
                    const got = await this.store.acquireLock(job.curatorId, this.ownerId);
                    if (!got) break;   // another tab owns this job → we stay standby
                    try {
                        await this._drainJob(job);
                    } finally {
                        await this.store.releaseLock(job.curatorId, this.ownerId);
                    }
                }
            } finally {
                this.draining = false;
            }
        }

        async _drainJob(job) {
            await this.store.updateJob(job.id, { status: 'running' });
            const ignored = await this.fetchUserdata().catch(() => new Set());
            let lastBeat = Date.now();
            let fails = 0;

            while (true) {
                const cur = (await this.store.getQueue()).find(j => j.id === job.id);
                if (!cur) return;                       // removed from the queue
                if (cur.status === 'paused') return;    // user paused
                if (!(await this.store.holdsLock(job.curatorId, this.ownerId))) return; // lost lease

                const cursor = cur.cursor || 0;
                if (cursor >= cur.appids.length) {
                    // Finished: drop the job entirely (no lingering "done" record) and
                    // emit a completion pulse so the widget blinks once.
                    await this.store.removeJob(job.id);
                    await this.store.signalCompleted();
                    return;
                }

                const appid = String(cur.appids[cursor]);
                if (ignored.has(appid)) {
                    // Already ignored (dedupe) — count it as done, no request.
                    await this.store.updateJob(job.id, { cursor: cursor + 1 });
                    fails = 0;
                    continue;
                }

                const ok = await this.api.ignore(appid, REASON);
                if (ok) {
                    ignored.add(appid);
                    await this.store.updateJob(job.id, { cursor: cursor + 1 });
                    fails = 0;
                } else {
                    // Don't advance on failure (cursor only moves on confirmed
                    // ignore); retry a few times, then skip so one bad appid can't
                    // wedge the whole job.
                    fails += 1;
                    if (fails >= MAX_FAILS) {
                        await this.store.updateJob(job.id, { cursor: cursor + 1 });
                        fails = 0;
                    }
                }

                if (Date.now() - lastBeat > HEARTBEAT_MS) {
                    await this.store.renewLock(job.curatorId, this.ownerId);
                    lastBeat = Date.now();
                }
                await sleep(jitter());
            }
        }
    }

    window.ILAP.Curator.CuratorQueueDrainer = CuratorQueueDrainer;
    window.ILAP.Curator.fetchUserdataIgnored = fetchUserdataIgnored;

    // Boot only when the storage model is present (it loads before this script).
    if (window.ILAP.Curator.Store && window.ILAP.apiIgnoreGame) {
        const drainer = new CuratorQueueDrainer({
            store: window.ILAP.Curator.Store,
            api: { ignore: (appid, reason) => window.ILAP.apiIgnoreGame(appid, reason) },
            fetchUserdata: fetchUserdataIgnored
        });
        window.ILAP.Curator.drainer = drainer;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => drainer.start());
        } else {
            drainer.start();
        }
    }
})();
