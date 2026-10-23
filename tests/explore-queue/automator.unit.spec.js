const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadSettingsSchema } = require('../_settings-schema.js');

// ExploreAutomator as a Node unit — no browser. Two contracts live here:
//
// 1. Session marking. Audit finding #5: processedSession.add() used to precede
//    _performIgnore with no un-mark on a gate stop / failed POST, so after a
//    re-enable the game was silently skipped for the rest of the session.
//    Contract now: the appid stays marked only when the ignore actually landed.
// 2. The pending-advance handle and what may re-enter run(). One scheduled Next
//    click at a time, cancellable by Stop; and the master-change listener revives
//    this page only on a real queue-toggle transition.
// 3. What the user decides. Run waits for the one-time automation notice, and
//    an advance nobody clicked waits for the sale's queue reward to be earned.

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
// plain ok/fail shape when a test needs the rateLimited flavour), the sale-reward
// verdict and the notice's answer.
function makeAutomator(Automator, { gateOk, ignoreOk, ignoreRes, reserve, ignore, reward, confirm, wishlisted }) {
    const calls = { ignores: 0, toastRemoved: 0, visualsCleared: 0, statsSaved: [], rateReports: [],
        locked: 0, lockPending: [], intents: [], runIds: [], openRuns: new Set(), closedRuns: [],
        prompts: 0, visuals: [] };
    const a = new Automator({
        settings: { read: async () => ({}), subscribe: () => {}, disableQueue: async () => {} },
        ui: {
            clearStartPrompt: () => {},
            applyVisuals: (type) => { calls.visuals.push(type); },
            removeToast: () => { calls.toastRemoved++; },
            clearVisuals: () => { calls.visualsCleared++; },
            showAdvanceLock: (btn, pending) => { calls.locked++; calls.lockPending.push(pending); },
            clearAdvanceLock: () => {}, showIgnoredToast: () => {},
            showStartPrompt: () => { calls.prompts++; }, updateRunButtonMode: () => {},
        },
        api: { ignore: async () => { calls.ignores++; return ignore ? ignore() : (ignoreRes || { ok: ignoreOk }); } },
        gate: {
            reserve: reserve || (async () => ({ ok: gateOk })),
            reportRateLimited: async (ms) => { calls.rateReports.push(ms); },
        },
        stats: { save: (name) => { calls.statsSaved.push(name); } },   // (name, appid)
        navGuard: {
            resetState: () => {}, authorizeNextStep: () => {}, consumeAuthorization: () => false,
            getActiveAppid: () => null, getUserIntent: () => ({}), setActiveAppid: () => {},
            setIntent: (type, appid, run) => { calls.intents.push(type); calls.runIds.push(run); },
        },
        nameExtractor: { get: () => 'Test Game' },
        context: {
            getGameContainer: () => null, getNextButton: () => null,
            getAppID: () => null, isQueuePage: () => false,
        },
        analyzer: { getState: () => 'NEGATIVE' },
        decisionEngine: { decide: () => 'SHOULD_IGNORE' },
        reward: {
            check: reward || (async () => 'allowed'),
            STATUS: { ALLOWED: 'allowed', PENDING: 'pending', UNKNOWN: 'unknown' },
        },
        notice: { confirmOnce: confirm || (async () => true) },
        // RunLedger over an in-memory set: a run id is live from open() to close().
        runs: {
            open: async () => {
                const id = 'run' + (calls.openRuns.size + calls.closedRuns.length + 1);
                calls.openRuns.add(id);
                return id;
            },
            isLive: async (id) => calls.openRuns.has(id),
            close: async (id) => { calls.openRuns.delete(id); calls.closedRuns.push(id); },
        },
        wishlist: { has: wishlisted || (async () => false) },
    });
    return { a, calls };
}

test.describe('ExploreAutomator (unit)', () => {

    test('a missing or incomplete collaborator refuses construction, naming it', async () => {
        const Automator = loadAutomatorClass();
        const { a } = makeAutomator(Automator, { gateOk: true, ignoreOk: true });
        const deps = () => ({
            settings: a.settings, ui: a.ui, api: a.api, gate: a.gate, stats: a.stats,
            navGuard: a.nav, nameExtractor: a.nameExtractor, context: a.context,
            analyzer: a.analyzer, decisionEngine: a.decisionEngine, reward: a.reward, notice: a.notice,
            runs: a.runs, wishlist: a.wishlist,
        });
        expect(() => new Automator(deps())).not.toThrow();
        for (const name of ['ui', 'navGuard', 'context', 'analyzer', 'decisionEngine', 'gate', 'reward', 'notice',
            'runs', 'wishlist']) {
            const broken = Object.assign(deps(), { [name]: {} });
            expect(() => new Automator(broken), name).toThrow(`needs deps.${name}`);
        }
        // The verdicts are compared against the dependency's own STATUS.
        const noStatus = Object.assign(deps(), { reward: { check: a.reward.check } });
        expect(() => new Automator(noStatus)).toThrow('needs deps.reward.STATUS');
    });

    test('a gate stop leaves the appid UN-marked (retryable after re-enable)', async () => {
        const Automator = loadAutomatorClass();
        const { a, calls } = makeAutomator(Automator, { gateOk: false, ignoreOk: true });
        await a._executeLogic('123');
        expect(a.processedSession.has('123')).toBe(false);
        expect(calls.ignores).toBe(0);       // stop verdict → no POST
        expect(calls.toastRemoved).toBe(1);  // teardown, not a silent no-op
    });

    test('a wishlisted game is never ignored: no slot, no POST, its own mark', async () => {
        const Automator = loadAutomatorClass();
        let reserved = 0;
        const { a, calls } = makeAutomator(Automator, {
            reserve: async () => { reserved++; return { ok: true }; }, ignoreOk: true,
            wishlisted: async () => true,
        });
        await a._executeLogic('123');
        expect(reserved).toBe(0);
        expect(calls.ignores).toBe(0);
        expect(calls.visuals).toEqual(['WISHLIST']);
        expect(a.processedSession.has('123')).toBe(false);
    });

    test('a failed wishlist read is a failed ignore: no POST, no mark', async () => {
        const Automator = loadAutomatorClass();
        const { a, calls } = makeAutomator(Automator, { gateOk: true, ignoreOk: true, wishlisted: async () => null });
        await a._executeLogic('123');
        expect(calls.ignores).toBe(0);
        expect(calls.visuals).toEqual([]);
        expect(a.processedSession.has('123')).toBe(false);
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

    test('a throw after the POST releases the in-flight latch and leaves the appid retryable', async () => {
        // Nothing awaits _executeLogic, so a throw that skipped the latch reset
        // would stop every later run() on this page at `_inFlight === appid`.
        const Automator = loadAutomatorClass();
        const { a, calls } = makeAutomator(Automator, { gateOk: true, ignoreOk: true });
        a.nameExtractor.get = () => { throw new URIError('URI malformed'); };
        const warned = [];
        const realWarn = console.warn;
        console.warn = (...args) => warned.push(args.join(' '));
        try {
            await a._executeLogic('123');   // resolves: nothing upstream would catch it
        } finally {
            console.warn = realWarn;
        }
        expect(calls.ignores).toBe(1);
        expect(a._inFlight).toBe(null);
        expect(a.processedSession.has('123')).toBe(false);
        expect(warned.some(w => w.includes('EQ ignore failed'))).toBe(true);
    });

    test('a stop during the gate wait sends no ignore and schedules no advance', async () => {
        // The gate checks only the global master: the queue toggle or the toast's
        // Stop landing while reserve() waits must still win.
        const Automator = loadAutomatorClass();
        let release;
        const { a, calls } = makeAutomator(Automator, {
            ignoreOk: true,
            reserve: () => new Promise(r => { release = () => r({ ok: true }); }),
        });
        let scheduled = 0;
        a._scheduleNextClick = () => { scheduled++; };

        const pending = a._executeLogic('123');
        // The wishlist read comes first: wait until reserve() is waiting.
        while (!release) await Promise.resolve();
        a._stopAutomation();
        release();
        await pending;

        expect(calls.ignores).toBe(0);
        expect(scheduled).toBe(0);
        expect(a.processedSession.has('123')).toBe(false);
    });

    test('a stop during the ignore POST keeps the ignore but schedules no advance', async () => {
        const Automator = loadAutomatorClass();
        let release;
        const { a, calls } = makeAutomator(Automator, {
            gateOk: true,
            ignore: () => new Promise(r => { release = () => r({ ok: true }); }),
        });
        a.currentSettings = { autoNext: true, globalOn: true, queueOn: true };
        a.context.getNextButton = () => ({ click: () => {} });
        let scheduled = 0;
        a._scheduleNextClick = () => { scheduled++; };

        const pending = a._executeLogic('123');
        await new Promise(r => setTimeout(r, 0));
        a._stopAutomation();
        release();
        await pending;

        expect(calls.ignores).toBe(1);
        expect(calls.statsSaved).toEqual(['Test Game']);   // it landed
        expect(a.processedSession.has('123')).toBe(true);
        expect(scheduled).toBe(0);
    });

    test('a revive during the gate wait runs the page again once the wait ends', async () => {
        // Off then on inside one wait: the revive's run() meets the in-flight game,
        // and the stopped ignore un-marks it afterwards. Without a second run() the
        // page would stay blank until a reload.
        const Automator = loadAutomatorClass();
        let release;
        const { a } = makeAutomator(Automator, {
            ignoreOk: true,
            reserve: () => new Promise(r => { release = () => r({ ok: true }); }),
        });
        Object.assign(a.context, {
            isQueuePage: () => true,
            getAppID: () => '123',
            getNextButton: () => ({ dataset: {}, addEventListener: () => {} }),
        });
        const realRun = a.run.bind(a);
        let runs = 0;
        a.run = () => { runs++; return realRun(); };

        const pending = a._executeLogic('123');
        await Promise.resolve();
        a._stopAutomation();
        await a.run();            // the revive, while the ignore waits
        expect(runs).toBe(1);
        release();
        await pending;

        expect(runs).toBe(2);
        expect(a.processedSession.has('123')).toBe(false);
    });

    // ---- what the user decides ------------------------------------------

    // An autoNext page with a Next button, its advance recorded instead of clicked.
    function makeAdvancing(Automator, opts) {
        const made = makeAutomator(Automator, Object.assign({ gateOk: true, ignoreOk: true }, opts));
        made.a.currentSettings = { autoNext: true, globalOn: true, queueOn: true };
        made.a.context.getNextButton = () => ({ click: () => {} });
        made.calls.scheduled = 0;
        made.a._scheduleNextClick = () => { made.calls.scheduled++; };
        return made;
    }

    test('auto-advance goes ahead once the sale reward is earned', async () => {
        const Automator = loadAutomatorClass();
        const { a, calls } = makeAdvancing(Automator, { reward: async () => 'allowed' });
        await a._executeLogic('123');
        expect(calls.ignores).toBe(1);
        expect(calls.scheduled).toBe(1);
        expect(calls.locked).toBe(0);
    });

    for (const verdict of ['pending', 'unknown']) {
        test(`a '${verdict}' sale reward keeps the ignore but leaves Next to the user`, async () => {
            const Automator = loadAutomatorClass();
            const { a, calls } = makeAdvancing(Automator, { reward: async () => verdict });
            await a._executeLogic('123');
            expect(calls.ignores).toBe(1);
            expect(a.processedSession.has('123')).toBe(true);   // the ignore stands
            expect(calls.scheduled).toBe(0);
            expect(calls.locked).toBe(1);                        // and the user is told
            expect(calls.lockPending).toEqual([verdict === 'pending']);   // which reason
        });
    }

    test('a throwing sale-reward check reads as unreadable: the ignore stands, Next is the user\'s', async () => {
        // The POST has landed by then: a throw must not un-mark the game.
        const Automator = loadAutomatorClass();
        const { a, calls } = makeAdvancing(Automator, {
            reward: async () => { throw new Error('Extension context invalidated.'); },
        });
        await a._executeLogic('123');
        expect(calls.ignores).toBe(1);
        expect(a.processedSession.has('123')).toBe(true);
        expect(calls.scheduled).toBe(0);
        expect(calls.lockPending).toEqual([false]);
    });

    test('without auto-advance the sale reward is never asked', async () => {
        const Automator = loadAutomatorClass();
        let asked = 0;
        const { a, calls } = makeAdvancing(Automator, { reward: async () => { asked++; return 'pending'; } });
        a.currentSettings.autoNext = false;
        await a._executeLogic('123');
        expect(calls.ignores).toBe(1);
        expect(asked).toBe(0);
        expect(calls.locked).toBe(0);
    });

    test('a stop during the sale-reward check schedules no advance', async () => {
        const Automator = loadAutomatorClass();
        let release;
        const { a, calls } = makeAdvancing(Automator, {
            reward: () => new Promise(r => { release = () => r('allowed'); }),
        });
        const pending = a._executeLogic('123');
        await new Promise(r => setTimeout(r, 0));
        a._stopAutomation();
        release();
        await pending;
        expect(calls.ignores).toBe(1);
        expect(calls.scheduled).toBe(0);
        expect(calls.locked).toBe(0);
    });

    test('Run starts nothing when the automation notice is dismissed', async () => {
        const Automator = loadAutomatorClass();
        const { a, calls } = makeAutomator(Automator, { gateOk: true, ignoreOk: true, confirm: async () => false });
        await a._startRun();
        expect(calls.intents).toEqual([]);
        expect(calls.ignores).toBe(0);
    });

    test('Run starts nothing when a switch goes off while the notice is open', async () => {
        const Automator = loadAutomatorClass();
        let answer;
        const { a, calls } = makeAutomator(Automator, {
            gateOk: true, ignoreOk: true,
            confirm: () => new Promise(r => { answer = r; }),
        });
        const pending = a._startRun();
        a._stopAutomation();       // the queue toggle or the master, meanwhile
        answer(true);
        await pending;
        expect(calls.intents).toEqual([]);
        expect(calls.ignores).toBe(0);
        expect(calls.openRuns.size).toBe(0);
    });

    // ---- the run behind the intent ---------------------------------------
    // The ACTIVE intent rides in sessionStorage, which the Steam page can write.
    // What it cannot write is the ledger: only a real Run click opens a run.

    // A queue page whose sessionStorage claims an ACTIVE run on this very page.
    function makeReloaded(Automator, run) {
        const made = makeAutomator(Automator, { gateOk: true, ignoreOk: true });
        made.a.settings.read = async () => ({ globalOn: true, queueOn: true });
        Object.assign(made.a.context, {
            isQueuePage: () => true,
            getAppID: () => '123',
            getNextButton: () => ({ dataset: {}, addEventListener: () => {} }),
        });
        Object.assign(made.a.nav, {
            getUserIntent: () => ({ wantsActive: true, run }),
            getActiveAppid: () => '123',   // a same-page reload: no nav token needed
        });
        return made;
    }
    const settle = () => new Promise(r => setTimeout(r, 0));

    test('Run opens a run and hands its id to the intent; a stop closes it', async () => {
        const Automator = loadAutomatorClass();
        const { a, calls } = makeAutomator(Automator, { gateOk: true, ignoreOk: true });
        a.context.getAppID = () => '123';
        await a._startRun();
        expect(calls.intents).toEqual(['ACTIVE']);
        expect(calls.runIds).toEqual(['run1']);
        expect([...calls.openRuns]).toEqual(['run1']);

        a.nav.getUserIntent = () => ({ wantsActive: true, run: 'run1' });
        a._stopAutomation();
        await settle();
        expect(calls.closedRuns).toEqual(['run1']);
        expect(calls.openRuns.size).toBe(0);
    });

    test('an ACTIVE intent with no open run behind it starts nothing and asks again', async () => {
        // What a page script that wrote the intent itself gets, and what a run
        // stopped in another way gets after a reload.
        const Automator = loadAutomatorClass();
        const { a, calls } = makeReloaded(Automator, 'written-by-the-page');
        await a.run();
        await settle();
        expect(calls.ignores).toBe(0);
        expect(calls.prompts).toBe(1);
    });

    test('an open run continues on the reload of its page', async () => {
        const Automator = loadAutomatorClass();
        const { a, calls } = makeReloaded(Automator, 'run7');
        calls.openRuns.add('run7');
        await a.run();
        await settle();
        expect(calls.ignores).toBe(1);
        expect(calls.prompts).toBe(0);
    });

    test('a stop while the ledger is read sends no ignore', async () => {
        // The queue toggle going off: the gate checks only the global master,
        // so this check is the one that stops the pass.
        const Automator = loadAutomatorClass();
        const { a, calls } = makeReloaded(Automator, 'run7');
        calls.openRuns.add('run7');
        let release;
        a.runs.isLive = () => new Promise(r => { release = () => r(true); });
        const pending = a.run();
        await settle();
        a._stopAutomation();
        release();
        await pending;
        await settle();
        expect(calls.ignores).toBe(0);
    });

    test('a stop while Run opens its run closes that run', async () => {
        const Automator = loadAutomatorClass();
        const { a, calls } = makeAutomator(Automator, { gateOk: true, ignoreOk: true });
        let release;
        const open = a.runs.open;
        a.runs.open = () => new Promise(r => { release = () => r(open()); });
        const pending = a._startRun();
        await settle();
        a._stopAutomation();
        release();
        await pending;
        expect(calls.intents).toEqual([]);
        expect(calls.openRuns.size).toBe(0);
        expect(calls.closedRuns).toEqual(['run1']);
    });

    test('a second Run click while the first waits starts one run, not two', async () => {
        const Automator = loadAutomatorClass();
        let answer;
        let asked = 0;
        const { a, calls } = makeAutomator(Automator, {
            gateOk: true, ignoreOk: true,
            confirm: () => { asked++; return new Promise(r => { answer = r; }); },
        });
        const first = a._startRun();
        const second = a._startRun();
        answer(true);
        await Promise.all([first, second]);
        await new Promise(r => setTimeout(r, 0));   // the ignore it set off
        expect(asked).toBe(1);
        expect(calls.intents).toEqual(['ACTIVE']);
        expect(calls.ignores).toBe(1);
    });

    // ---- the pending-advance handle -------------------------------------
    // Only ONE Next click may be in flight, so Stop can actually stop: it clears
    // this.nextTimeoutId, and a leaked earlier handle would outlive it. Stacking
    // two takes same-document re-entry (_handleMasterChange → run()) — an EQ
    // advance is a full document load and takes any pending timer with it.

    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    test('a second scheduled advance replaces the first (one click, not two)', async () => {
        const Automator = loadAutomatorClass();
        const { a } = makeAutomator(Automator, { gateOk: true, ignoreOk: true });
        let clicks = 0;
        const btn = { click: () => { clicks++; } };

        a._scheduleNextClick(btn, 20);
        a._scheduleNextClick(btn, 20);
        await wait(120);

        expect(clicks).toBe(1);
    });

    test('Stop cancels the advance even after a re-schedule (no click survives)', async () => {
        const Automator = loadAutomatorClass();
        const { a } = makeAutomator(Automator, { gateOk: true, ignoreOk: true });
        let clicks = 0;
        const btn = { click: () => { clicks++; } };

        a._scheduleNextClick(btn, 20);
        a._scheduleNextClick(btn, 20);
        a._stopAutomation();
        await wait(120);

        expect(clicks).toBe(0);
    });

    // ---- what may re-enter run() ----------------------------------------
    // The revive is keyed on a real queue-toggle transition. onChanged also fires
    // for a write that leaves the value alone, and the global master coming back
    // is deliberately NOT a revive-in-place (it waits for a fresh ?queue= entry).

    function makeMasterAutomator(Automator, currentSettings) {
        const { a, calls } = makeAutomator(Automator, { gateOk: true, ignoreOk: true });
        calls.runs = 0;
        a.run = async () => { calls.runs++; };
        a.currentSettings = currentSettings;
        return { a, calls };
    }

    test('the queue toggle returning (false → true) revives this page', async () => {
        const Automator = loadAutomatorClass();
        const { a, calls } = makeMasterAutomator(Automator,
            { queueOn: false, globalOn: true });

        a._handleMasterChange({ queueOn: { was: false, now: true } });

        expect(calls.runs).toBe(1);
    });

    test('an unchanged-value write of the queue toggle revives nothing', async () => {
        const Automator = loadAutomatorClass();
        const { a, calls } = makeMasterAutomator(Automator,
            { queueOn: true, globalOn: true });

        a._handleMasterChange({ queueOn: { was: true, now: true } });

        expect(calls.runs).toBe(0);
    });

    test('the global master riding along in the same write revives nothing', async () => {
        const Automator = loadAutomatorClass();
        const { a, calls } = makeMasterAutomator(Automator,
            { queueOn: false, globalOn: false });

        a._handleMasterChange({
            queueOn: { was: false, now: true },
            globalOn: { was: false, now: true },
        });

        expect(calls.runs).toBe(0);
    });

    test('a page the global master left stays quiet, whatever order the switches come back in', async () => {
        // global off → queue off → global on → queue on. The last write is the queue
        // toggle's own false → true, but the page was already left at the first.
        const Automator = loadAutomatorClass();
        const { a, calls } = makeMasterAutomator(Automator,
            { queueOn: true, globalOn: true });

        a._handleMasterChange({ globalOn: { was: true, now: false } });
        a._handleMasterChange({ queueOn: { was: true, now: false } });
        a._handleMasterChange({ globalOn: { was: false, now: true } });
        a._handleMasterChange({ queueOn: { was: false, now: true } });

        expect(calls.runs).toBe(0);
    });

    test('a write that merely restates the global master does not veto the queue toggle', async () => {
        // A settings reset or migration writes both keys at once. The global master
        // was on all along (true → true), so only the queue toggle actually returned.
        const Automator = loadAutomatorClass();
        const { a, calls } = makeMasterAutomator(Automator,
            { queueOn: false, globalOn: true });

        a._handleMasterChange({
            queueOn: { was: false, now: true },
            globalOn: { was: true, now: true },
        });

        expect(calls.runs).toBe(1);
    });

    // ---- what may reach the listener at all ------------------------------
    // QueueSettings reads chrome.storage.local. The automator caches whatever
    // arrives straight into currentSettings, the mode among it, and that feeds
    // decisionEngine.decide(): a value from an area nothing else reads would put
    // EQ in 'all' mode while local storage still says 'bad'. Same
    // never-mass-ignore-on-unexpected-input posture as the classify() fail-safe.

    function loadQueueSettings() {
        const src = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', ...p), 'utf8');
        const listeners = [];
        const sandbox = {
            window: {},
            chrome: { storage: { onChanged: { addListener: (fn) => listeners.push(fn) } } },
        };
        vm.createContext(sandbox);
        loadSettingsSchema(sandbox);
        vm.runInContext(src('queue-common', 'steam-palette.js'), sandbox);
        vm.runInContext(src('explore-queue', 'utils.js'), sandbox);
        const ILAP = sandbox.window.ILAP;
        return { settings: new ILAP.Explore.QueueSettings(ILAP.Settings), listeners };
    }

    test('only LOCAL changes reach the settings subscriber', () => {
        const { settings, listeners } = loadQueueSettings();
        const seen = [];
        settings.subscribe((change) => { seen.push(change); });

        const fire = (area) => listeners[0]({ ilap_q_mode: { oldValue: 'bad', newValue: 'all' } }, area);

        fire('sync');
        fire('session');
        fire('managed');
        expect(seen).toEqual([]);   // no other area may set the ignore mode

        fire('local');
        expect(seen).toHaveLength(1);
        expect(seen[0].mode).toBe('all');
    });

    test('a storage change reads as the automator\'s own terms, switches as transitions', () => {
        const { settings } = loadQueueSettings();
        // An absent old value is the default: on.
        expect(settings.toChange({ ilap_q_master: { newValue: false } }))
            .toEqual({ queueOn: { was: true, now: false } });
        expect(settings.toChange({ ilap_master_enabled: { oldValue: false, newValue: true } }))
            .toEqual({ globalOn: { was: false, now: true } });
        // A removed mode falls back to the default; a removed auto-next is off.
        expect(settings.toChange({ ilap_q_mode: { oldValue: 'all' }, ilap_q_next: { oldValue: true } }))
            .toEqual({ mode: 'bad', autoNext: false });
        // Nothing the Queue Helper reads: no callback at all.
        expect(settings.toChange({ ilap_curator_queue: { newValue: [] } })).toBe(null);
    });

    test('the queue toggle going off leaves the verdict drawn, so resuming on an ignored card keeps it', async () => {
        // run() returns early on an already-processed appid and would not repaint an
        // outline the teardown had stripped. The queue toggle pauses; it does not leave.
        const Automator = loadAutomatorClass();
        const { a, calls } = makeMasterAutomator(Automator,
            { queueOn: true, globalOn: true });

        a._handleMasterChange({ queueOn: { was: true, now: false } });

        expect(calls.toastRemoved).toBe(1);
        expect(calls.visualsCleared).toBe(0);
    });

    test('the global master going off still tears the page down', async () => {
        const Automator = loadAutomatorClass();
        const { a, calls } = makeMasterAutomator(Automator,
            { queueOn: true, globalOn: true });
        const btn = { click: () => { calls.runs = -1; } };
        a._scheduleNextClick(btn, 20);

        a._handleMasterChange({ globalOn: { was: true, now: false } });
        await wait(120);

        expect(calls.toastRemoved).toBe(1);
        expect(calls.visualsCleared).toBe(1);
        expect(calls.runs).toBe(0);   // the pending advance never fired
    });

    test('kick() absorbs a pass that throws — nothing awaits it', async () => {
        // run() opens with a storage read, and on a content script an extension
        // update has already replaced leaves that read throwing for good. Four
        // call sites fire a pass without awaiting it (boot, the URL poller, a
        // master flip, a re-run after a flight), so the rejection has nowhere to
        // go but the console. kick() is the one entry point that absorbs it.
        const Automator = loadAutomatorClass();
        const { a } = makeAutomator(Automator, { gateOk: true, ignoreOk: true });
        a.settings.read = async () => { throw new Error('Extension context invalidated'); };
        a.context = Object.assign({}, a.context, {
            isQueuePage: () => true,
            getNextButton: () => ({ dataset: {}, addEventListener: () => {} }),
            getAppID: () => '440',
        });

        // run() itself still rejects — it stays awaitable for these units.
        await expect(a.run()).rejects.toThrow('Extension context invalidated');

        const leaked = [];
        const onUnhandled = (e) => leaked.push(e);
        // The automator's console is this one (same object in its sandbox), so
        // the absorber's own line is captured rather than printed — and asserted,
        // because absorbing is not the same as swallowing.
        const warned = [];
        const realWarn = console.warn;
        console.warn = (...args) => warned.push(args.join(' '));
        process.on('unhandledRejection', onUnhandled);
        try {
            a.kick();
            await new Promise((r) => setTimeout(r, 50));
        } finally {
            process.off('unhandledRejection', onUnhandled);
            console.warn = realWarn;
        }
        expect(leaked.map(String)).toEqual([]);
        expect(warned.filter((w) => w.includes('EQ pass failed'))).toHaveLength(1);
    });

    test('RunLedger: a run is live from open() to close(), and an id it never gave is not', async () => {
        const src = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', ...p), 'utf8');
        const data = {};
        const sandbox = {
            window: {}, Date, Promise, Object,
            chrome: { storage: { local: {
                get: (query, cb) => {
                    const out = {};
                    for (const [k, dflt] of Object.entries(query)) out[k] = k in data ? JSON.parse(data[k]) : dflt;
                    setTimeout(() => cb(out), 0);
                },
                set: (obj, cb) => {
                    for (const [k, v] of Object.entries(obj)) data[k] = JSON.stringify(v);
                    setTimeout(cb, 0);
                },
            } } },
        };
        vm.createContext(sandbox);
        loadSettingsSchema(sandbox);
        vm.runInContext(src('escape.js'), sandbox);
        vm.runInContext(src('queue-common', 'steam-palette.js'), sandbox);
        vm.runInContext(src('explore-queue', 'utils.js'), sandbox);
        const runs = new sandbox.window.ILAP.Explore.RunLedger();

        const id = await runs.open();
        expect(await runs.isLive(id)).toBe(true);
        for (const forged of ['eq_forged', '', null, undefined, '__proto__', 'constructor']) {
            expect(await runs.isLive(forged), String(forged)).toBe(false);
        }
        // A second tab's run is its own entry.
        const other = await runs.open();
        await runs.close(id);
        expect(await runs.isLive(id)).toBe(false);
        expect(await runs.isLive(other)).toBe(true);

        // An entry past the TTL, or stamped in the future, is not a live run,
        // and the next write drops it.
        const stored = JSON.parse(data.ilap_queue_runs);
        stored.old = Date.now() - 25 * 3600 * 1000;
        stored.ahead = Date.now() + 3600 * 1000;
        data.ilap_queue_runs = JSON.stringify(stored);
        expect(await runs.isLive('old')).toBe(false);
        expect(await runs.isLive('ahead')).toBe(false);
        await runs.close(other);
        expect(JSON.parse(data.ilap_queue_runs)).toEqual({});
    });
});
