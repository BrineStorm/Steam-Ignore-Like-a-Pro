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

    const calls = { mount: 0, unmount: 0, updateState: [], release: 0, find: 0 };

    // Stateful like the real panel: mount() is a no-op while one is on screen,
    // and isMounted() is what the controller checks before probing the modal.
    class FakeUI {
        constructor() { this._mounted = false; }
        isMounted() { return this._mounted; }
        mount() { if (this._mounted) return; this._mounted = true; calls.mount += 1; }
        unmount() { this._mounted = false; calls.unmount += 1; }
        updateState(running, count) { calls.updateState.push([running, count]); }
        showRefused() {}
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
        tryAcquire: async () => true,
        renew: async () => {},
        release: () => { calls.release += 1; },
    };

    // Flipped by the tests: whether the queue modal is on screen, and whether the
    // panel can be placed into it yet.
    const state = { modalOpen: true, canInsert: true };
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
        console: { warn: () => {}, log: () => {}, error: () => {} },
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
    const newController = () => new ILAP.Discovery.Controller({
        automator: new ILAP.Discovery.Automator({
            userdata: { fetchIgnored: async () => new Set() },
            stats: { save: () => {} },
            nameExtractor: { get: () => 'Unknown Game' },
            gate: { reserve: async () => ({ ok: true }) },
        }),
        ui: new FakeUI(),
        registry,
        insertionStrategy,
        masterSwitch: ILAP.MasterSwitch,
        ownerId: 'dq_test',
    });
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
