const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadSettingsSchema } = require('../_settings-schema.js');

// DiscoveryQueueController teardown discipline as Node units — no browser.
//
// What the E2E (master-off.spec.js) can see is the PANEL: after a flip it is
// gone, and after the flip back it is a fresh one — green Start, Keep High Score
// unticked. What it cannot see is the other half of that promise. `ui.mount`
// builds a brand-new checkbox every time, so an unticked box proves nothing on
// its own; the automator's `skipPositive` lives in an object that survives both
// `unmount()` and `stop()`, and if it is left set the user is looking at an
// unticked box while the run it starts keeps the positive games. That flag is
// reachable from no page — the config is stored nowhere and the controller is
// built inside the bootstrap — so it is asserted here instead.
//
// Every collaborator is handed to the constructor, as boot() does in main.js.
// The REAL automator is used (its `setSkipPositive`/`stop` are the code under
// test) with one-line adapters; the UI, registry and insertion strategy are
// fakes — where the panel goes in Steam's modal is InsertionStrategy's business,
// not the controller's. The master switch is the real module over a stubbed
// chrome.storage, so its read-then-follow order is what the controller sees.

function loadController() {
    const src = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', ...p), 'utf8');

    const calls = { mount: 0, unmount: 0, updateState: [], release: 0, find: 0, acquire: 0, refused: [], cleared: 0, checking: [], rewardOpts: [], warned: [] };

    // Stateful like the real panel: mount() is a no-op while one is on screen,
    // and isMounted() is what the controller checks before probing the modal.
    class FakeUI {
        constructor() { this._mounted = false; }
        isMounted() { return this._mounted; }
        mount(point, events) {
            if (this._mounted) return;
            this._mounted = true; calls.mount += 1; calls.events = events;
        }
        unmount() { this._mounted = false; calls.unmount += 1; }
        updateState(running, count) { calls.updateState.push([running, count]); }
        showRefused() {}
        showRewardRefused(pending) { calls.refused.push(pending); }
        clearRewardLock() { calls.cleared += 1; }
        setChecking(on) { calls.checking.push(on); }
    }

    // The controller only asks whether a modal is on screen and hands it to the
    // strategy. The real automator does look inside: it gets an EMPTY dialog, where
    // its slide scan finds nothing — no selector is special-cased.
    const modal = { querySelectorAll: () => [], querySelector: () => null };
    // Counted: this is the expensive half of checkForDialog (the real one walks
    // every <polygon> in the modal), so the tests below assert how often it runs.
    const insertionStrategy = {
        // `canInsert: false` is the modal on screen before its header row has
        // rendered: the probe runs and finds nothing, so nothing mounts.
        find: () => {
            calls.find += 1;
            return state.canInsert === false ? null : { parent: {}, referenceNode: {} };
        }
    };
    const registry = {
        HEARTBEAT_MS: 3000, CAP: 2,
        tryAcquire: async () => { calls.acquire += 1; return true; },
        renew: async () => {},
        release: () => { calls.release += 1; },
    };

    // Flipped by the tests: whether the queue modal is on screen, whether the
    // panel can be placed into it yet, the sale-reward verdict, and the
    // automation notice's answer (a function, so a test can hold it open).
    const state = { modalOpen: true, canInsert: true, reward: 'allowed', confirm: async () => true };
    const store = { ilap_master_enabled: true };
    const changeListeners = [];
    let observerCallback = null;

    const sandbox = {
        window: {
            ILAP: {},
            addEventListener: () => {},
        },
        chrome: {
            storage: {
                local: {
                    // Async like the real one — init() does not await it, so the
                    // tests flush a tick before touching the controller.
                    get: (keys, cb) => setTimeout(() => {
                        const out = {};
                        for (const k of keys) if (k in store) out[k] = store[k];
                        cb(out);
                    }, 0),
                },
                onChanged: { addListener: (fn) => changeListeners.push(fn) },
            },
        },
        document: {
            readyState: 'loading',   // keeps the bootstrap from constructing its own
            body: {},
            querySelector: () => (state.modalOpen ? modal : null),
            head: { appendChild: () => {} },
            getElementById: () => null,
        },
        MutationObserver: class {
            constructor(cb) { observerCallback = cb; }
            observe() {}
            disconnect() {}
        },
        setTimeout, clearTimeout, setInterval, clearInterval,
        console: { warn: (...a) => calls.warned.push(a), log: () => {}, error: () => {} },
        Date, Math, Promise, Object, Array, String, JSON,
    };
    vm.createContext(sandbox);
    // logic.js reads the shared review palette at load time; same ordering note
    // as automator.unit.spec.js.
    vm.runInContext(src('steam-palette.js'), sandbox);
    loadSettingsSchema(sandbox);
    vm.runInContext(src('master-switch.js'), sandbox);   // the real get + onChanged pair
    vm.runInContext(src('discovery-queue', 'logic.js'), sandbox);
    vm.runInContext(src('discovery-queue', 'main.js'), sandbox);

    const ILAP = sandbox.window.ILAP;
    const newController = (over) => new ILAP.Discovery.Controller(Object.assign({
        automator: new ILAP.Discovery.Automator({
            userdata: { fetchIgnored: async () => new Set() },
            stats: { save: () => {} },
            nameExtractor: { get: () => 'Unknown Game' },
            gate: { reserve: async () => ({ ok: true }) },
            reward: { check: async () => 'allowed', STATUS: { ALLOWED: 'allowed', PENDING: 'pending', UNKNOWN: 'unknown' } },
        }),
        ui: new FakeUI(),
        registry,
        insertionStrategy,
        masterSwitch: ILAP.MasterSwitch,
        reward: {
            check: async (opts) => { calls.rewardOpts.push(opts); return state.reward; },
            STATUS: { ALLOWED: 'allowed', PENDING: 'pending', UNKNOWN: 'unknown' },
        },
        notice: { confirmOnce: () => state.confirm() },
        ownerId: 'dq_test',
    }, over));
    return {
        newController, calls, state, store, changeListeners,
        fireChange: (changes) => changeListeners.forEach(fn => fn(changes, 'local')),
        fireMutation: (records) => observerCallback && observerCallback(records),
    };
}

const tick = () => new Promise(r => setTimeout(r, 0));

// A started controller with Keep High Score ticked — the state every test below
// asks the teardown to forget.
async function bootedWithKeepHighScore() {
    const h = loadController();
    const ctl = h.newController();
    ctl.init();
    await tick();

    // What the checkbox's change handler does, verbatim (main.js wires
    // onCheckboxChange straight to it).
    ctl.automator.setSkipPositive(true);
    expect(ctl.automator.config.skipPositive).toBe(true);
    return Object.assign({ ctl }, h);
}

test.describe('DiscoveryQueueController — teardown (unit)', () => {

    test('the global master going off clears Keep High Score with the panel', async () => {
        const { ctl, calls, fireChange } = await bootedWithKeepHighScore();
        const mountsBefore = calls.mount;

        fireChange({ ilap_master_enabled: { newValue: false } });

        expect(calls.unmount).toBe(1);
        expect(ctl.automator.isRunning).toBe(false);
        // The half no page can see: the config must agree with the unticked box
        // the next mount() will draw.
        expect(ctl.automator.config.skipPositive).toBe(false);
        expect(calls.mount).toBe(mountsBefore);   // nothing re-mounted while off
    });

    test('the Classic Discovery Queue switch leaves the panel alone', async () => {
        // `ilap_q_master` belongs to the Classic Discovery Queue. This panel
        // answers to the global master only: no teardown, nothing forgotten.
        const { ctl, calls, fireChange } = await bootedWithKeepHighScore();

        fireChange({ ilap_q_master: { newValue: false } });

        expect(calls.unmount).toBe(0);
        expect(ctl.automator.config.skipPositive).toBe(true);
    });

    test('the panel that comes back and the automator behind it agree', async () => {
        const { ctl, calls, fireChange } = await bootedWithKeepHighScore();

        fireChange({ ilap_master_enabled: { newValue: false } });
        fireChange({ ilap_master_enabled: { newValue: true } });

        // Re-mounted in place, without waiting for the user to reopen the queue…
        expect(calls.mount).toBeGreaterThan(1);
        // …and what it re-mounted is a DEFAULT panel on both sides: the fresh
        // checkbox is unticked, and so is the config it speaks for.
        expect(ctl.automator.config.skipPositive).toBe(false);
    });

    test('closing the modal clears it too — the paths share one teardown', async () => {
        const { ctl, calls, state, fireMutation } = await bootedWithKeepHighScore();

        state.modalOpen = false;
        fireMutation([{ addedNodes: [], removedNodes: [{}] }]);

        expect(calls.unmount).toBe(1);
        expect(ctl.automator.config.skipPositive).toBe(false);
    });

    test('a mutation batch costs one dialog probe, and none while the panel is up', async () => {
        // Steam's modal re-renders in batches of hundreds of records, and the
        // automator's own clicks cause them: a probe per RECORD (or one on an
        // already-mounted panel) is pure waste on the page the loop runs on.
        const { ctl, calls, state, fireMutation } = await bootedWithKeepHighScore();
        const batch = () => fireMutation(
            Array.from({ length: 50 }, () => ({ addedNodes: [{}], removedNodes: [] })));

        expect(calls.mount).toBe(1);          // mounted by init()
        let probes = calls.find;

        batch();
        expect(calls.find).toBe(probes);      // panel already up — nothing to probe
        expect(calls.mount).toBe(1);

        // The panel went with a closed modal: the next batch re-mounts it, and
        // the whole batch is worth exactly one probe.
        ctl.ui.unmount();
        batch();
        expect(calls.find).toBe(probes + 1);
        expect(calls.mount).toBe(2);
        probes = calls.find;

        // …and the case that isolates the BATCH rule from the mounted-panel one:
        // the modal is up but has nowhere to put the panel yet, so nothing mounts
        // and `isMounted` short-circuits nothing. Per-record probing would spend
        // fifty scans of the modal on one React redraw; this is the half that
        // caught nothing when the two were asserted together.
        ctl.ui.unmount();
        state.canInsert = false;
        batch();
        expect(calls.find).toBe(probes + 1);
        expect(calls.mount).toBe(2);
    });

    test('a Stop click does NOT clear it — the panel is still on screen, box ticked', async () => {
        // The counterpart to the four above, and the reason the reset lives in
        // _teardown rather than in stop(): stopping a run leaves the panel exactly
        // where it is, ticked box and all, and the next Start must honour it.
        const { ctl, calls } = await bootedWithKeepHighScore();

        await ctl._toggle();   // start
        expect(ctl.automator.isRunning).toBe(true);
        await ctl._toggle();   // stop

        expect(ctl.automator.isRunning).toBe(false);
        expect(calls.unmount).toBe(0);                      // panel untouched
        expect(ctl.automator.config.skipPositive).toBe(true);
    });
});

test.describe('DiscoveryQueueController — what Start asks first (unit)', () => {

    test('a reward or notice dependency that is not the full contract refuses construction', () => {
        const h = loadController();
        expect(() => h.newController()).not.toThrow();
        expect(() => h.newController({ reward: { check: async () => 'allowed' } })).toThrow('needs deps.reward');
        expect(() => h.newController({ reward: undefined })).toThrow('needs deps.reward');
        expect(() => h.newController({ notice: {} })).toThrow('needs deps.notice');
    });

    test('a Start click whose run rejects is caught, not left unhandled', async () => {
        // Storage behind the notice is gone after an extension update; nothing
        // awaits the click handler, so the controller must catch it.
        const h = loadController();
        h.state.confirm = async () => { throw new Error('Extension context invalidated.'); };
        const ctl = h.newController();
        ctl.init();
        await tick();
        expect(h.calls.events, 'the panel was never mounted').toBeTruthy();

        let unhandled = null;
        const onUnhandled = (e) => { unhandled = e; };
        process.on('unhandledRejection', onUnhandled);
        try {
            h.calls.events.onToggle();
            await tick();
            await tick();
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        expect(unhandled).toBeNull();
        expect(h.calls.warned.length).toBe(1);
        expect(ctl._starting).toBe(false);
    });

    for (const verdict of ['pending', 'unknown']) {
        test(`a '${verdict}' sale reward refuses Start and says why`, async () => {
            const h = loadController();
            h.state.reward = verdict;
            const ctl = h.newController();
            ctl.init();
            await tick();

            await ctl._toggle();

            expect(ctl.automator.isRunning).toBe(false);
            expect(h.calls.refused).toEqual([verdict === 'pending']);   // which reason
            expect(h.calls.cleared).toBe(0);
            expect(h.calls.acquire).toBe(0);    // not even a registry slot
        });
    }

    test('a check that lets Start through lifts the lock, even when the run then does not start', async () => {
        // Refused once, earned since, then Cancel on the notice: the button must
        // not keep asking for a queue the user has already been through.
        const h = loadController();
        h.state.reward = 'pending';
        const ctl = h.newController();
        ctl.init();
        await tick();
        await ctl._toggle();
        expect(h.calls.refused).toEqual([true]);

        h.state.reward = 'allowed';
        h.state.confirm = async () => false;
        await ctl._toggle();

        expect(h.calls.cleared).toBe(1);
        expect(ctl.automator.isRunning).toBe(false);
    });

    test('a run the sale-reward check ends mid-way locks Start and says why', async () => {
        const h = loadController();
        const ctl = h.newController();
        ctl.init();
        await tick();

        ctl.automator.isRunning = true;
        ctl.automator.refusal = 'pending';
        ctl.automator.stop();

        expect(h.calls.refused).toEqual([true]);
    });

    test('a dismissed automation notice starts nothing', async () => {
        const h = loadController();
        h.state.confirm = async () => false;
        const ctl = h.newController();
        ctl.init();
        await tick();

        await ctl._toggle();

        expect(ctl.automator.isRunning).toBe(false);
        expect(h.calls.acquire).toBe(0);
    });

    test('the master going off while the notice is open starts nothing', async () => {
        // The loop's Keep-High-Score skips and Continue take no gate slot, so
        // nothing later in the run would stop it.
        const h = loadController();
        let answer;
        h.state.confirm = () => new Promise(r => { answer = r; });
        const ctl = h.newController();
        ctl.init();
        await tick();

        const pending = ctl._toggle();
        await tick();
        h.fireChange({ ilap_master_enabled: { newValue: false } });
        answer(true);
        await pending;

        expect(ctl.automator.isRunning).toBe(false);
        expect(h.calls.acquire).toBe(0);
    });

    test('the modal closing while the notice is open starts nothing', async () => {
        const h = loadController();
        let answer;
        h.state.confirm = () => new Promise(r => { answer = r; });
        const ctl = h.newController();
        ctl.init();
        await tick();

        const pending = ctl._toggle();
        await tick();
        h.state.modalOpen = false;
        h.fireMutation([{ addedNodes: [], removedNodes: [{}] }]);
        answer(true);
        await pending;

        expect(ctl.automator.isRunning).toBe(false);
        expect(h.calls.acquire).toBe(0);
    });

    test('an earned reward and an accepted notice start the run', async () => {
        const h = loadController();
        const ctl = h.newController();
        ctl.init();
        await tick();

        await ctl._toggle();

        expect(h.calls.acquire).toBe(1);
        expect(ctl.automator.isRunning).toBe(true);
        ctl.automator.stop();
    });

    test('Start asks the sale reward fresh, and shows it is waiting meanwhile', async () => {
        // A click: a queue just finished by hand must count now, not after the
        // cached 'pending' runs out.
        const h = loadController();
        const ctl = h.newController();
        ctl.init();
        await tick();

        await ctl._toggle();

        expect(h.calls.rewardOpts).toEqual([{ fresh: true }]);
        expect(h.calls.checking).toEqual([true, false]);
        ctl.automator.stop();
    });

    test("a check that throws lifts the waiting state and reads as unreadable", async () => {
        const h = loadController();
        const ctl = h.newController();
        ctl.reward = Object.assign({}, ctl.reward, { check: async () => { throw new Error('boom'); } });
        ctl.init();
        await tick();

        await ctl._toggle();

        expect(h.calls.checking).toEqual([true, false]);
        // Unreadable, as in the loop and the Classic Discovery Queue: refused, said why.
        expect(h.calls.refused).toEqual([false]);
        expect(ctl.automator.isRunning).toBe(false);
        expect(ctl._starting).toBe(false);
    });
});
