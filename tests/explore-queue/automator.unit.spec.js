const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ExploreAutomator session-marking as a Node unit — no browser. Audit
// finding #5: processedSession.add() used to precede _performIgnore with
// no un-mark on a gate stop / failed POST, so after a re-enable the game was
// silently skipped for the rest of the session. Contract now: the appid stays
// marked only when the ignore actually landed.

function loadAutomatorClass() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'explore-queue', 'automator.js'), 'utf8');
    const sandbox = {
        window: { ILAP: { Explore: {} } },
        console,
        setTimeout, clearTimeout,
        Promise, Object, Set, TypeError,
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.Explore.AutomatorClass;
}

// Deps wired so _executeLogic always decides SHOULD_IGNORE; the per-test knobs
// are the gate verdict and the ignore-API result (ignoreRes overrides the
// plain ok/fail shape when a test needs the rateLimited flavour).
function makeAutomator(Automator, { gateOk, ignoreOk, ignoreRes }) {
    const calls = { ignores: 0, toastRemoved: 0, statsSaved: [], rateReports: [] };
    const a = new Automator({
        settings: {},
        ui: {
            clearStartPrompt: () => {},
            applyVisuals: () => {},
            removeToast: () => { calls.toastRemoved++; },
        },
        api: { ignore: async () => { calls.ignores++; return ignoreRes || { ok: ignoreOk }; } },
        gate: {
            reserve: async () => ({ ok: gateOk }),
            reportRateLimited: async (ms) => { calls.rateReports.push(ms); },
        },
        stats: { save: (name) => { calls.statsSaved.push(name); } },
        navGuard: { resetState: () => {} },
        nameExtractor: { get: () => 'Test Game' },
        context: { getGameContainer: () => null, getNextButton: () => null },
        analyzer: { getState: () => 'NEGATIVE' },
        decisionEngine: { decide: () => 'SHOULD_IGNORE' },
    });
    return { a, calls };
}

test.describe('ExploreAutomator (unit)', () => {

    test('a gate stop leaves the appid UN-marked (retryable after re-enable)', async () => {
        const Automator = loadAutomatorClass();
        const { a, calls } = makeAutomator(Automator, { gateOk: false, ignoreOk: true });
        await a._executeLogic('123');
        expect(a.processedSession.has('123')).toBe(false);
        expect(calls.ignores).toBe(0);       // stop verdict → no POST
        expect(calls.toastRemoved).toBe(1);  // teardown, not a silent no-op
    });

    test('a failed ignore POST leaves the appid UN-marked', async () => {
        const Automator = loadAutomatorClass();
        const { a, calls } = makeAutomator(Automator, { gateOk: true, ignoreOk: false });
        await a._executeLogic('123');
        expect(a.processedSession.has('123')).toBe(false);
        expect(calls.ignores).toBe(1);
        expect(calls.statsSaved).toEqual([]); // nothing recorded for a non-ignore
    });

    test('a rate-limited POST (429) reports to the shared gate and leaves the appid UN-marked', async () => {
        const Automator = loadAutomatorClass();
        const { a, calls } = makeAutomator(Automator, {
            gateOk: true,
            ignoreRes: { ok: false, rateLimited: true, retryAfterMs: 12000 },
        });
        await a._executeLogic('123');
        expect(a.processedSession.has('123')).toBe(false); // retryable later
        expect(calls.rateReports).toEqual([12000]);        // backoff escalated for everyone
        expect(calls.statsSaved).toEqual([]);
    });

    test('a confirmed ignore keeps the appid marked (session dedupe intact)', async () => {
        const Automator = loadAutomatorClass();
        const { a, calls } = makeAutomator(Automator, { gateOk: true, ignoreOk: true });
        await a._executeLogic('123');
        expect(a.processedSession.has('123')).toBe(true);
        expect(calls.ignores).toBe(1);
        expect(calls.statsSaved).toEqual(['Test Game']);
    });
});
