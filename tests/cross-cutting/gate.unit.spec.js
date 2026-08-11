const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Aggregate ignore-rate governor (src/gate.js) as a Node unit — no browser. The
// pacing is pure math (nextSlot) plus a serialized claim over an async
// chrome.storage stub. Guards the contract the drainer / EQ / DQ rely on:
//   - the two STOP verdicts (master off, no session) resolve without a slot —
//     and "no session" means no LIVE session, not a missing sessionid cookie:
//     Steam hands that cookie to anonymous visitors too, so the verdict comes
//     from the store header / a live /account/ probe (stubbed here);
//   - a granted reservation advances the shared timestamp monotonically by at
//     least MIN_GAP, so stacked sources stay ≥ MIN_GAP apart;
//   - a reported 429 escalates a shared penalty (nextPenalty) that the next
//     reservation waits out, so every source backs off together.

function loadGate(initial, opts) {
    opts = opts || {};
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
        // `setThrows` lets a test blow up the write that happens INSIDE the
        // serialized claim — the only part of reserve() the chain still covers.
        set: (obj, cb) => {
            if (opts.setThrows && opts.setThrows()) throw new Error('boom');
            setTimeout(() => {
                for (const k of Object.keys(obj)) data[k] = clone(obj[k]);
                if (cb) cb();
            }, 0);
        },
    };
    const sandbox = { window: {}, chrome: { storage: { local } }, setTimeout, Date, Math, JSON };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    const ILAP = sandbox.window.ILAP;
    // Default world: the TAB, the only one the gate answers for without being
    // configured — utils.js loads before gate.js, so its SteamAuth is there to
    // be read. Stubbed as "signed in", so every test below that only sets
    // getSessionID reads that way, which is what it meant before the probe
    // existed. The login policy behind SteamAuth (header vs cached /account/
    // probe) is exercised by utils.js/steam-net.js own units, not here. Tests
    // that care override ILAP.SteamAuth; the OTHER world (the service worker,
    // which imports no utils.js) arrives through Gate.configure — see its test.
    ILAP.SteamAuth = { hasLiveSession: async () => true };
    return { Gate: ILAP.IgnoreGate, ILAP, data: () => data };
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

    test('penaltyUntil: active deadline, expired/absent → still the stored value or 0, corrupt → 0', () => {
        // Exported for the SW host's wait pre-check (src/background.js): it must
        // see the penalty deadline WITHOUT claiming a slot.
        const { Gate } = loadGate();
        const now = 1000000;
        expect(Gate.penaltyUntil(null, now)).toBe(0);
        expect(Gate.penaltyUntil({ until: now + 5000, level: 1 }, now)).toBe(now + 5000);
        // A corrupt far-future penalty is treated as absent (same rule as reserve).
        expect(Gate.penaltyUntil({ until: now + Gate.PENALTY_MAX + 1, level: 1 }, now)).toBe(0);
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

    test('a sessionid alone is NOT a session: a logged-out probe still stops', async () => {
        // The bug this guards: Steam sets a sessionid cookie for anonymous
        // visitors (it is a CSRF token), so the cookie is present on every store
        // page of a signed-OUT browser. Granting slots on it meant MI swipes,
        // EQ/DQ and the drainer all fired POSTs that could only be refused.
        const { Gate, ILAP } = loadGate({ ilap_master_enabled: true });
        ILAP.getSessionID = () => 'sess';
        ILAP.SteamAuth = { hasLiveSession: async () => false };
        const r = await Gate.reserve();
        expect(r).toEqual({ ok: false, reason: 'no-session' });
    });

    test('a probe that could not be MADE reads as offline, not as a logout', async () => {
        // The distinction exists for src/background.js: a stop it can recover
        // from through a storage write ('disabled' → ilap_master_enabled,
        // 'no-session' → ilap_sw_sid) lets it drop its retry alarm, but nothing
        // writes storage when a network outage ends — so 'offline' must stay
        // tellable apart or a blip strands the SW drain until a store tab opens.
        // Either way no slot is granted: the gate fails closed.
        const { Gate, ILAP } = loadGate({ ilap_master_enabled: true });
        ILAP.getSessionID = () => 'sess';
        ILAP.SteamAuth = { hasLiveSession: async () => null };   // offline / timeout
        expect(await Gate.reserve()).toEqual({ ok: false, reason: 'offline' });
        expect(await Gate.stopVerdict()).toBe('offline');
    });

    test('configure() replaces the session seam outright (the service-worker world)', async () => {
        // The tab is answered by the default (utils.js SteamAuth — one definition
        // of the ignore-side login policy, shared with the Manual-Ignore
        // gestures). The worker imports no utils.js at all: no DOM, no SteamAuth,
        // no cookie to read. It injects its own answer at boot instead
        // (src/background.js — the cached sid folded with the live probe), which
        // replaced an implicit arrangement: the worker used to ASSIGN
        // `ILAP.getSessionID` to satisfy a module that walked a ladder of facade
        // names to discover which world it was running in.
        const { Gate, ILAP } = loadGate({ ilap_master_enabled: true });
        let asked = 0;
        ILAP.getSessionID = () => { throw new Error('the default seam must not be consulted'); };
        ILAP.SteamAuth = { hasLiveSession: async () => { throw new Error('nor this one'); } };

        Gate.configure({ hasSession: async () => { asked++; return true; } });
        expect(await Gate.reserve()).toEqual({ ok: true });
        expect(asked).toBe(1);

        // Same tri-state contract as the default it replaced.
        Gate.configure({ hasSession: async () => null });
        expect(await Gate.stopVerdict()).toBe('offline');
        Gate.configure({ hasSession: async () => false });
        expect(await Gate.stopVerdict()).toBe('no-session');
    });

    test('SteamAuth\'s tri-state passes straight through: null → offline, false → no-session', async () => {
        const off = loadGate({ ilap_master_enabled: true });
        off.ILAP.getSessionID = () => 'sess';
        off.ILAP.SteamAuth = { hasLiveSession: async () => null };
        expect(await off.Gate.reserve()).toEqual({ ok: false, reason: 'offline' });

        const out = loadGate({ ilap_master_enabled: true });
        out.ILAP.getSessionID = () => 'sess';
        out.ILAP.SteamAuth = { hasLiveSession: async () => false };
        expect(await out.Gate.reserve()).toEqual({ ok: false, reason: 'no-session' });
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

    test('a background reservation YIELDS while a foreground ignore is recent', async () => {
        // Visible work (EQ/DQ/MI) has priority: the background queue drainer defers
        // its slot while a foreground ignore is within the yield window.
        const { Gate, ILAP } = loadGate({
            ilap_master_enabled: true,
            ilap_ignore_foreground_at: Date.now(),
        });
        ILAP.getSessionID = () => 'sess';
        const r = await Gate.reserve();               // background (no foreground flag)
        expect(r).toEqual({ ok: false, reason: 'yield' });
    });

    test('a foreground reservation never yields and stamps foreground activity', async () => {
        const { Gate, ILAP, data } = loadGate({
            ilap_master_enabled: true,
            ilap_ignore_foreground_at: Date.now(),    // fresh — a background caller would yield
        });
        ILAP.getSessionID = () => 'sess';
        const before = Date.now();
        const r = await Gate.reserve({ foreground: true });
        expect(r).toEqual({ ok: true });
        expect(data().ilap_ignore_foreground_at).toBeGreaterThanOrEqual(before);
    });

    test('a background reservation proceeds once the foreground window has passed', async () => {
        const { Gate, ILAP } = loadGate({
            ilap_master_enabled: true,
            ilap_ignore_foreground_at: Date.now() - 10000,   // stale (well past YIELD_MS)
        });
        ILAP.getSessionID = () => 'sess';
        const r = await Gate.reserve();
        expect(r).toEqual({ ok: true });
    });

    test('the claim chain survives a throwing claim (one failure cannot wedge the gate)', async () => {
        // chain = run.then(ok, err) must swallow a rejected claim so the next
        // reservation still runs. Blow up the slot WRITE — that is the part
        // still inside the chain now that the stop verdict is asked outside it
        // (a stop check that can cost a live probe must not hold the chain).
        let boom = true;
        const { Gate, ILAP } = loadGate({}, {
            setThrows: () => { const b = boom; boom = false; return b; }
        });
        ILAP.getSessionID = () => 'sess';
        await expect(Gate.reserve()).rejects.toThrow('boom');
        const r = await Gate.reserve();   // chain not wedged → this resolves normally
        expect(r).toEqual({ ok: true });
    });

    test('a throwing stop check leaves the gate usable too (it never touches the chain)', async () => {
        const { Gate, ILAP } = loadGate({});
        let calls = 0;
        ILAP.getSessionID = () => { calls++; if (calls === 1) throw new Error('boom'); return 'sess'; };
        await expect(Gate.reserve()).rejects.toThrow('boom');
        expect(await Gate.reserve()).toEqual({ ok: true });
    });
});
