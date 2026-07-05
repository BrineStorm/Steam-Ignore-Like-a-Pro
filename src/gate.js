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

    const GATE_KEY = 'ilap_ignore_gate';       // { at } — last reserved slot time
    const MASTER_KEY = 'ilap_master_enabled';  // global on/off (widget master toggle)

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

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Pure pacing math (unit-tested): the next slot is at least one gap past the
    // last reserved slot, but never in the past.
    function nextSlot(lastAt, now, gap) {
        return Math.max(now, (lastAt || 0) + gap);
    }
    function nextGap() {
        return Math.max(GAP_FLOOR, MIN_GAP) + Math.floor(Math.random() * JITTER);
    }

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

    // A source calls this before every ignore. Resolves:
    //   { ok:true }                    once the reserved slot arrives — fire now.
    //   { ok:false, reason:'disabled' }   master toggle off — STOP this pass.
    //   { ok:false, reason:'no-session' } no sessionid cookie — STOP this pass
    //                                     (a dead session must not burn work).
    // Callers treat !ok as "stop the whole pass", not "skip one item".
    function reserve() {
        const claim = chain.then(async () => {
            const data = await get({ [MASTER_KEY]: true, [GATE_KEY]: 0 });
            if (data[MASTER_KEY] === false) return { stop: 'disabled' };
            const sid = window.ILAP.getSessionID && window.ILAP.getSessionID();
            if (!sid) return { stop: 'no-session' };
            const slot = nextSlot(data[GATE_KEY], Date.now(), nextGap());
            await set({ [GATE_KEY]: slot });
            return { slot };
        });
        // Keep the chain alive across a thrown claim so one failure can't wedge
        // every future reservation. The next claim waits only for this claim's
        // storage write, never for the sleep below.
        chain = claim.then(() => {}, () => {});
        return claim.then((r) => {
            if (r.stop) return { ok: false, reason: r.stop };
            const wait = r.slot - Date.now();
            return (wait > 0 ? sleep(wait) : Promise.resolve()).then(() => ({ ok: true }));
        });
    }

    window.ILAP.IgnoreGate = { reserve, nextSlot, GATE_KEY, MIN_GAP, GAP_FLOOR };
})();
