const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// StatsManager.save does a read-modify-write on ilap_ignored_count. Real
// chrome.storage get/set fire their callbacks ASYNCHRONOUSLY, so two overlapping
// saves can both read the same count and both write count+1 → a lost increment.
// We load utils.js (vm) with an ASYNC in-memory storage stub (deferred callbacks)
// — the worst case the synchronous stub in history-cap.spec can't reproduce — and
// fire many saves without awaiting between them. The fix serializes the RMW, so
// every increment must land. saveStats returns the (serialized) chain tail, so
// awaiting the calls drains all pending writes deterministically.
//
// opts.throwOnGet: 1-based get-call indices that should throw synchronously,
// simulating a transient storage fault (used to prove the chain doesn't wedge).
function loadIlapAsync(opts) {
    opts = opts || {};
    const throwOn = new Set(opts.throwOnGet || []);
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'utils.js'),
        'utf8'
    );

    const store = {};
    const defer = (fn) => setTimeout(fn, 0);
    let getCalls = 0;
    const chrome = {
        runtime: { id: 'test-ctx', lastError: undefined },
        storage: {
            local: {
                get(keys, cb) {
                    if (throwOn.has(++getCalls)) throw new Error('simulated storage fault');
                    const out = {};
                    const list = Array.isArray(keys)
                        ? keys
                        : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
                    for (const k of list) if (k in store) out[k] = store[k];
                    defer(() => cb(out));   // callback fires on a later tick
                },
                set(obj, cb) {
                    defer(() => { Object.assign(store, obj); if (cb) cb(); });
                },
            },
        },
    };

    const sandbox = { window: {}, chrome, console, setTimeout };
    vm.createContext(sandbox);
    // escape.js owns the shared string helpers (escapeHTML + sanitizeName) for
    // all three worlds, stats.js the Last-Ignored record shape for the two that
    // write it, steam-net.js the Steam reads for the two that fetch; all three
    // load before utils.js wherever it runs — the sandbox mirrors that.
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'escape.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'stats.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'steam-net.js'), 'utf8'), sandbox);
    vm.runInContext(code, sandbox);
    return { ILAP: sandbox.window.ILAP, store };
}

test.describe('Cross-cutting — StatsManager.save serializes the read-modify-write (unit)', () => {

    test('25 concurrent saveStats (async storage) → no lost increments', async () => {
        const { ILAP, store } = loadIlapAsync();

        // Deliberately != HISTORY_LIMIT (20), so the count assert below can only
        // mean "no lost increments" and can't be confused with the history cap.
        const N = 25;
        const pending = [];
        for (let i = 1; i <= N; i++) {
            pending.push(ILAP.saveStats(`Game ${i}`, 'Manual')); // no await between calls
        }
        await Promise.all(pending);

        // Without serialization, overlapping read-modify-writes drop increments and
        // this lands below N. With the fix it must be exactly N.
        expect(store.ilap_ignored_count).toBe(N);
        expect(store.ilap_ignored_history.length).toBe(20); // capped at HISTORY_LIMIT
        expect(store.ilap_last_ignored_name).toBe(`Game ${N}`);
    });

    test('a failed commit is caught and does not wedge later saves', async () => {
        // The first commit's get() throws; the .catch in save() must absorb it so
        // the next save still runs (count reflects only the survivor).
        const { ILAP, store } = loadIlapAsync({ throwOnGet: [1] });

        await ILAP.saveStats('Game A', 'Manual'); // faults internally, resolves
        await ILAP.saveStats('Game B', 'Manual'); // must still go through

        expect(store.ilap_ignored_count).toBe(1);
        expect(store.ilap_last_ignored_name).toBe('Game B');
    });
});
