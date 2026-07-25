// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};

    // === Aggregate ignore-POST rate governor ===
    //
    // The account-ban risk is the AGGREGATE ignore-POST rate to the one Steam
    // account, summed across every ignore SOURCE in every tab/window of the
    // profile — not any single source in isolation. Sources:
    //   - the curator drainer (bulk),
    //   - the Explore-Queue automator,
    //   - the Discovery-Queue click (which makes STEAM's own page JS fire an
    //     ignore POST — confirmed; it does NOT go through
    //     apiIgnoreGame, so this gate cannot be a wrapper over our fetch).
    // Each already throttles itself, but nothing budgeted the SUM, so N DQ tabs +
    // the drainer stacked into N uncoordinated streams.
    //
    // Every source reserves a slot here before emitting an ignore. One shared
    // timestamp in chrome.storage.local paces the aggregate: stacked sources
    // collapse into ~one evenly-spaced stream. This is the constructive fix for
    // audit findings #1 (master toggle vs drainer) and #2 (dead session should
    // stop, not silently burn work) — both are enforced at this one chokepoint.

    const GATE_KEY = 'ilap_ignore_gate';       // last reserved slot (bare epoch-ms number)
    const PENALTY_KEY = 'ilap_ignore_gate_penalty'; // rate-limit backoff ({ until, level })
    const MASTER_KEY = 'ilap_master_enabled';  // global on/off (widget master toggle)
    // Timestamp of the last ignore from a VISIBLE source (EQ / DQ). The background
    // queue drainer yields while this stamp is fresh — visible work wins. (Manual
    // Ignore is no longer a visible ungated source: a swipe now enqueues a
    // top-priority type:'mi' job the drainer sends through this same gate.)
    const FOREGROUND_KEY = 'ilap_ignore_foreground_at';

    // Minimum gap between consecutive ignores across ALL sources. ~500 ms + up to
    // 300 ms jitter → ≤ ~2 ignores/s per profile, matching the single-drainer
    // rate the account already tolerated (>2000/day observed). GAP_FLOOR is the
    // defensive clamp (same rationale as the drainer's old GAP_FLOOR, now removed
    // in favour of this one): a careless edit to MIN_GAP can't drop the whole
    // extension into spam territory without ALSO removing this line. A guardrail
    // for honest users and our future selves — not a security control.
    const MIN_GAP = 500;
    const JITTER = 300;
    const GAP_FLOOR = 350;

    // How long the background drainer yields after the last visible ignore (EQ/DQ).
    // A little over one gap+jitter, so a stream of visible ignores keeps the drainer
    // paused continuously, while a lone one stalls the background only a couple seconds.
    const YIELD_MS = 2500;

    // Rate-limit backoff. When the ignore endpoint answers 429, the reporting
    // source pushes a shared penalty here and every source in every tab goes
    // quiet together (the penalty deadline folds into the next reserved slot).
    // The wait doubles from PENALTY_BASE up to the PENALTY_MAX cap; a server
    // Retry-After is honoured up to the same cap. Consecutive 429s escalate as
    // long as each lands within PENALTY_DECAY of the previous penalty's end; a
    // quiet spell resets the level. Sources that already HOLD a reserved slot
    // still fire it — the penalty gates the NEXT reservation (accepted
    // residual: at most one in-flight ignore per source after a 429).
    const PENALTY_BASE = 5000;
    const PENALTY_MAX = 300000;
    const PENALTY_DECAY = 60000;

    // Legitimate queueing can only push the stored slot a few source-counts ×
    // gap into the future (~seconds), plus up to a full rate-limit penalty
    // (PENALTY_MAX). A slot further ahead than this is clock skew or corruption
    // (manual clock change, resumed VM, a tab with a fast clock) — without the
    // clamp every source would silently wait it out and the extension would
    // look dead until that far-future time.
    const MAX_AHEAD = 30000 + PENALTY_MAX;

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Pure pacing math (unit-tested): the next slot is at least one gap past the
    // last reserved slot, but never in the past; an implausibly-future last slot
    // (beyond MAX_AHEAD) is treated as now.
    function nextSlot(lastAt, now, gap) {
        const last = (lastAt || 0) > now + MAX_AHEAD ? now : (lastAt || 0);
        return Math.max(now, last + gap);
    }
    function nextGap() {
        return Math.max(GAP_FLOOR, MIN_GAP) + Math.floor(Math.random() * JITTER);
    }

    // Pure penalty math (unit-tested): each report escalates the level while
    // the previous penalty is still warm (within PENALTY_DECAY of its end) and
    // resets to level 1 after a quiet spell. An implausibly-future stored
    // penalty (corruption/skew — same rationale as MAX_AHEAD) is treated as
    // absent.
    function nextPenalty(prev, now, retryAfterMs) {
        const p = (prev && typeof prev.until === 'number' && prev.until <= now + PENALTY_MAX)
            ? prev : null;
        const level = (p && now < p.until + PENALTY_DECAY) ? (p.level || 0) + 1 : 1;
        const backoff = Math.min(PENALTY_BASE * Math.pow(2, level - 1), PENALTY_MAX);
        const wait = Math.min(Math.max(backoff, retryAfterMs || 0), PENALTY_MAX);
        return { until: now + wait, level };
    }

    // The active penalty deadline, or 0 — same corruption rule as nextPenalty.
    function penaltyUntil(p, now) {
        if (!p || typeof p.until !== 'number') return 0;
        if (p.until > now + PENALTY_MAX) return 0;
        return p.until;
    }

    // Deliberately duplicated shim — see the world-isolation note in
    // src/curator/store.js (the canonical copy of that decision).
    const get = (query) => new Promise(r => chrome.storage.local.get(query, r));
    const set = (obj) => new Promise(r => chrome.storage.local.set(obj, r));

    // Serialize the claim (read → compute → write of the gate timestamp) WITHIN
    // this context so two same-context sources can't both read the same lastAt and
    // reserve the same slot. Cross-context (other tabs) still races on
    // chrome.storage's lack of CAS — the accepted residual (same class as the
    // stats/queue RMW races): two tabs can occasionally share one slot, but the
    // uncoordinated N-stream stacking collapses into a single paced stream, which
    // is the whole point. The wait (sleep until the slot) happens OUTSIDE this
    // chain, so the chain only serializes the fast claim, not the pacing delay.
    let chain = Promise.resolve();

    // The two STOP conditions, shared by the pre-claim check and the post-wait
    // re-check: 'disabled' (master toggle off), 'no-session' (no sessionid
    // cookie), or null when clear to fire.
    async function stopVerdict() {
        const data = await get({ [MASTER_KEY]: true });
        if (data[MASTER_KEY] === false) return 'disabled';
        const sid = window.ILAP.getSessionID && window.ILAP.getSessionID();
        if (!sid) return 'no-session';
        return null;
    }

    // A source calls this before every ignore. `opts.foreground` marks a VISIBLE
    // source (EQ / DQ) — it stamps foreground activity and never yields. A
    // background caller (the queue drainer, no flag) yields while a foreground
    // ignore is recent, so the aggregate budget goes to what the user is watching.
    // Resolves:
    //   { ok:true }                    once the reserved slot arrives — fire now.
    //   { ok:false, reason:'disabled' }   master toggle off — STOP this pass.
    //   { ok:false, reason:'no-session' } no sessionid cookie — STOP this pass
    //                                     (a dead session must not burn work).
    //   { ok:false, reason:'yield' }      background pass deferring to visible work.
    // Callers treat !ok as "stop the whole pass", not "skip one item".
    function reserve(opts) {
        const foreground = !!(opts && opts.foreground);
        const claim = chain.then(async () => {
            const stop = await stopVerdict();
            if (stop) return { stop };
            const data = await get({ [GATE_KEY]: 0, [PENALTY_KEY]: null, [FOREGROUND_KEY]: 0 });
            const now = Date.now();
            // The background yields to visible work: while the foreground stamp is
            // fresh, the drainer takes no slot (the pass stops and retries on the
            // standby tick / alarm). Visible (foreground) sources never yield.
            if (!foreground && (now - (data[FOREGROUND_KEY] || 0)) < YIELD_MS) {
                return { yield: true };
            }
            // An active rate-limit penalty folds into the slot: the first
            // reservation lands at the penalty's end, later ones queue past it
            // with normal gap spacing.
            const slot = Math.max(
                nextSlot(data[GATE_KEY], now, nextGap()),
                penaltyUntil(data[PENALTY_KEY], now)
            );
            const write = { [GATE_KEY]: slot };
            // A visible source marks activity — the drainer yields to it.
            if (foreground) write[FOREGROUND_KEY] = now;
            await set(write);
            return { slot };
        });
        // Keep the chain alive across a thrown claim so one failure can't wedge
        // every future reservation. The next claim waits only for this claim's
        // storage write, never for the sleep below.
        chain = claim.then(() => {}, () => {});
        return claim.then(async (r) => {
            if (r.stop) return { ok: false, reason: r.stop };
            if (r.yield) return { ok: false, reason: 'yield' };
            const wait = r.slot - Date.now();
            if (wait > 0) {
                await sleep(wait);
                // The wait can span several paced slots when sources stack, so a
                // master flip / logout during it must stop the ignore that was
                // about to fire (the slot stays burned — conservative).
                const stop = await stopVerdict();
                if (stop) return { ok: false, reason: stop };
            }
            return { ok: true };
        });
    }

    // A gated source calls this when the ignore endpoint answered 429: escalate
    // the shared penalty so every source in every tab backs off together.
    // Serialized on the same chain as reserve() so a same-context report/claim
    // can't interleave their read-modify-writes (cross-tab still races — same
    // accepted residual as the slot claim).
    function reportRateLimited(retryAfterMs) {
        const claim = chain.then(async () => {
            const data = await get({ [PENALTY_KEY]: null });
            const p = nextPenalty(data[PENALTY_KEY], Date.now(), retryAfterMs);
            await set({ [PENALTY_KEY]: p });
            return p;
        });
        chain = claim.then(() => {}, () => {});
        return claim;
    }

    window.ILAP.IgnoreGate = {
        reserve, reportRateLimited, nextSlot, nextPenalty, penaltyUntil,
        GATE_KEY, PENALTY_KEY, FOREGROUND_KEY, MIN_GAP, GAP_FLOOR, MAX_AHEAD, YIELD_MS,
        PENALTY_BASE, PENALTY_MAX, PENALTY_DECAY
    };
})();
