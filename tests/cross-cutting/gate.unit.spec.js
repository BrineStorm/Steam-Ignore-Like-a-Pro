const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Aggregate ignore-rate governor (src/gate.js) as a Node unit — no browser. The
// pacing is pure math (nextSlot) plus a serialized claim over an async
// chrome.storage stub. Guards the contract the drainer / EQ / DQ rely on:
//   - the two STOP verdicts (master off, no session) resolve without a slot;
//   - a granted reservation advances the shared timestamp monotonically by at
//     least MIN_GAP, so stacked sources stay ≥ MIN_GAP apart;
//   - a reported 429 escalates a shared penalty (nextPenalty) that the next
//     reservation waits out, so every source backs off together.

function loadGate(initial) {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'gate.js'), 'utf8');
    const clone = (v) => JSON.parse(JSON.stringify(v));
    let data = clone(initial || {});
    const local = {
        // Supports chrome.storage's defaults-OBJECT query form ({ key: default }),
        // which is the only shape gate.js uses.
        get: (query, cb) => setTimeout(() => {
            const out = {};
            if (query && typeof query === 'object' && !Array.isArray(query)) {
                for (const k of Object.keys(query)) out[k] = (k in data) ? clone(data[k]) : query[k];
            } else {
                for (const k of (Array.isArray(query) ? query : [query])) if (k in data) out[k] = clone(data[k]);
            }
            cb(out);
        }, 0),
        set: (obj, cb) => setTimeout(() => {
            for (const k of Object.keys(obj)) data[k] = clone(obj[k]);
            if (cb) cb();
        }, 0),
    };
    const sandbox = { window: {}, chrome: { storage: { local } }, setTimeout, Date, Math, JSON };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return { Gate: sandbox.window.ILAP.IgnoreGate, ILAP: sandbox.window.ILAP, data: () => data };
}

test.describe('ignore-rate gate (unit)', () => {

    test('nextSlot: at least one gap past the last slot, never in the past', () => {
        const { Gate } = loadGate();
        // Fresh (lastAt 0) → clamps to now.
        expect(Gate.nextSlot(0, 1000, 500)).toBe(1000);
        // Recent last slot in the future → last + gap.
        expect(Gate.nextSlot(1000, 900, 500)).toBe(1500);
        // Stale last slot in the past → now wins.
        expect(Gate.nextSlot(100, 5000, 500)).toBe(5000);
    });

    test('nextSlot: an implausibly-future last slot (clock skew) is clamped to now', () => {
        const { Gate } = loadGate();
        const now = 1000000;
        // Beyond MAX_AHEAD = skew/corruption → treated as now, not waited out.
        expect(Gate.nextSlot(now + Gate.MAX_AHEAD + 1, now, 500)).toBe(now + 500);
        expect(Gate.nextSlot(now + 3600000, now, 500)).toBe(now + 500);
        // A legitimately-queued near-future slot (within MAX_AHEAD) is respected.
        expect(Gate.nextSlot(now + 2000, now, 500)).toBe(now + 2500);
    });

    test('nextPenalty: escalates while warm, resets after a quiet spell, honours Retry-After', () => {
        const { Gate } = loadGate();
        const now = 1000000;
        // First 429 → base backoff, level 1.
        const p1 = Gate.nextPenalty(null, now, 0);
        expect(p1).toEqual({ until: now + Gate.PENALTY_BASE, level: 1 });
        // Another 429 shortly after the penalty's end (within PENALTY_DECAY) → doubled.
        const t2 = p1.until + 1000;
        const p2 = Gate.nextPenalty(p1, t2, 0);
        expect(p2).toEqual({ until: t2 + 2 * Gate.PENALTY_BASE, level: 2 });
        // The backoff is hard-capped at PENALTY_MAX no matter the level.
        expect(Gate.nextPenalty({ until: t2, level: 20 }, t2, 0).until - t2).toBe(Gate.PENALTY_MAX);
        // A quiet spell (past PENALTY_DECAY) resets the escalation.
        const t3 = p2.until + Gate.PENALTY_DECAY + 1;
        expect(Gate.nextPenalty(p2, t3, 0).level).toBe(1);
        // A server Retry-After larger than the backoff wins — capped at PENALTY_MAX.
        expect(Gate.nextPenalty(null, now, 60000).until).toBe(now + 60000);
        expect(Gate.nextPenalty(null, now, Gate.PENALTY_MAX * 2).until).toBe(now + Gate.PENALTY_MAX);
        // A corrupt (implausibly-future) stored penalty is treated as absent.
        expect(Gate.nextPenalty({ until: now + Gate.PENALTY_MAX + 1, level: 5 }, now, 0).level).toBe(1);
    });

    test('reportRateLimited escalates the shared penalty across consecutive reports', async () => {
        const { Gate, data } = loadGate({});
        const start = Date.now();
        await Gate.reportRateLimited(0);
        await Gate.reportRateLimited(0);
        const p = data().ilap_ignore_gate_penalty;
        expect(p.level).toBe(2);
        expect(p.until).toBeGreaterThanOrEqual(start + 2 * Gate.PENALTY_BASE);
    });

    test('reserve honours an active penalty: the granted slot lands past penalty.until', async () => {
        const until = Date.now() + 400;
        const { Gate, ILAP, data } = loadGate({
            ilap_master_enabled: true,
            ilap_ignore_gate_penalty: { until, level: 1 },
        });
        ILAP.getSessionID = () => 'sess';
        const r = await Gate.reserve();
        expect(r).toEqual({ ok: true });
        expect(data().ilap_ignore_gate).toBeGreaterThanOrEqual(until); // slot folded past the penalty
        expect(Date.now()).toBeGreaterThanOrEqual(until);              // and the wait actually happened
    });

    test('a corrupt far-future penalty is ignored, not waited out', async () => {
        const { Gate, ILAP } = loadGate({
            ilap_master_enabled: true,
            ilap_ignore_gate_penalty: { until: Date.now() + 3600000, level: 3 },
        });
        ILAP.getSessionID = () => 'sess';
        const r = await Gate.reserve(); // must resolve promptly, not in an hour
        expect(r).toEqual({ ok: true });
    });

    test('reserve STOPS (no slot) when the master toggle is off', async () => {
        const { Gate, ILAP } = loadGate({ ilap_master_enabled: false });
        ILAP.getSessionID = () => 'sess';
        const r = await Gate.reserve();
        expect(r).toEqual({ ok: false, reason: 'disabled' });
    });

    test('reserve STOPS (no slot) when there is no sessionid', async () => {
        const { Gate, ILAP } = loadGate({ ilap_master_enabled: true });
        ILAP.getSessionID = () => null;
        const r = await Gate.reserve();
        expect(r).toEqual({ ok: false, reason: 'no-session' });
    });

    test('a granted reservation records the slot and returns ok', async () => {
        const { Gate, ILAP, data } = loadGate({});
        ILAP.getSessionID = () => 'sess';
        const r = await Gate.reserve();
        expect(r).toEqual({ ok: true });
        expect(typeof data().ilap_ignore_gate).toBe('number');
        expect(data().ilap_ignore_gate).toBeGreaterThanOrEqual(Date.now() - 50);
    });

    test('consecutive reservations advance the shared slot by >= MIN_GAP', async () => {
        const { Gate, ILAP, data } = loadGate({});
        ILAP.getSessionID = () => 'sess';
        await Gate.reserve();
        const first = data().ilap_ignore_gate;
        await Gate.reserve();
        const second = data().ilap_ignore_gate;
        expect(second - first).toBeGreaterThanOrEqual(Gate.MIN_GAP);
    });

    test('concurrent reservations serialize: three fired at once each get a distinct paced slot', async () => {
        // This is the whole point of the claim chain: same-context sources firing
        // at the same instant must NOT all read lastAt=0 and grab the same slot.
        // If serialized, slot3 ≥ now + 2·MIN_GAP; if they raced, the final stored
        // slot would stay ≈now.
        const { Gate, ILAP, data } = loadGate({});
        ILAP.getSessionID = () => 'sess';
        const start = Date.now();
        const results = await Promise.all([Gate.reserve(), Gate.reserve(), Gate.reserve()]);
        expect(results.every(r => r.ok)).toBe(true);
        expect(data().ilap_ignore_gate).toBeGreaterThanOrEqual(start + 2 * Gate.MIN_GAP);
    });

    test('a master flip during the pacing wait stops the reservation (no late ignore)', async () => {
        // The wait can span seconds when sources stack; the stop conditions are
        // re-checked AFTER the sleep, so a user who disabled the extension while
        // a slot was pending must not see one more ignore fire.
        const { Gate, ILAP, data } = loadGate({
            ilap_master_enabled: true,
            ilap_ignore_gate: Date.now() + 800, // forces a >0 wait
        });
        ILAP.getSessionID = () => 'sess';
        setTimeout(() => { data().ilap_master_enabled = false; }, 300);
        const r = await Gate.reserve();
        expect(r).toEqual({ ok: false, reason: 'disabled' });
    });

    test('a session death during the pacing wait stops the reservation', async () => {
        const { Gate, ILAP } = loadGate({
            ilap_master_enabled: true,
            ilap_ignore_gate: Date.now() + 800, // forces a >0 wait
        });
        let sid = 'sess';
        ILAP.getSessionID = () => sid;
        setTimeout(() => { sid = null; }, 300);
        const r = await Gate.reserve();
        expect(r).toEqual({ ok: false, reason: 'no-session' });
    });

    test('the claim chain survives a throwing reservation (one failure cannot wedge the gate)', async () => {
        // chain = claim.then(ok, err) must swallow a rejected claim so the next
        // reservation still runs. Make the session lookup throw once, then recover.
        const { Gate, ILAP } = loadGate({});
        let calls = 0;
        ILAP.getSessionID = () => { calls++; if (calls === 1) throw new Error('boom'); return 'sess'; };
        await expect(Gate.reserve()).rejects.toThrow('boom');
        const r = await Gate.reserve();   // chain not wedged → this resolves normally
        expect(r).toEqual({ ok: true });
    });
});
