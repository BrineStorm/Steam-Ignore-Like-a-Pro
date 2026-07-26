const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// What "survives a service-worker restart" actually hinges on:
// StatsManager.save (src/utils.js) probes chrome.runtime.id before touching
// storage. If an MV3 service worker was evicted, a still-attached content script's
// chrome.* context is invalidated and that probe is the guard that turns a save
// into a silent no-op instead of throwing the dreaded "Extension context
// invalidated" error. Once the page reloads, a fresh content script wires up and
// saves resume — covered by the persistence / manual-ignore suites.
//
// Driving a genuine SW kill end-to-end (chrome.runtime.reload) is not reliably
// observable under Playwright's persistent context — the dead worker lingers in
// context.serviceWorkers() and no responsive replacement is re-attached. So the
// guard itself, which is pure logic over a chrome stub, is unit-tested here
// (same approach as decision-matrix / history-cap).
function loadIlapWithChrome(chrome) {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'utils.js'),
        'utf8'
    );
    const sandbox = { window: {}, chrome, console };
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
    return sandbox.window.ILAP;
}

function makeChrome(store, { withId }) {
    return {
        // Missing `id` models an invalidated extension context (SW gone).
        runtime: withId ? { id: 'ctx', lastError: undefined } : { lastError: undefined },
        storage: {
            local: {
                get(keys, cb) {
                    const out = {};
                    const list = Array.isArray(keys)
                        ? keys
                        : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
                    for (const k of list) if (k in store) out[k] = store[k];
                    cb(out);
                },
                set(obj, cb) {
                    store.__writes = (store.__writes || 0) + 1;
                    Object.assign(store, obj);
                    if (cb) cb();
                },
            },
        },
    };
}

test.describe('Cross-cutting — StatsManager survives an invalidated extension context (unit)', () => {

    test('saveStats is a silent no-op when the context is gone (no chrome.runtime.id) — no throw, no write', () => {
        const store = {};
        const ILAP = loadIlapWithChrome(makeChrome(store, { withId: false }));

        expect(() => ILAP.saveStats('Game', 'Manual')).not.toThrow();
        expect(store.__writes).toBeUndefined();          // storage never touched
        expect(store.ilap_ignored_count).toBeUndefined();
    });

    test('saveStats writes normally once the context is valid again (post-recovery)', async () => {
        const store = {};
        const ILAP = loadIlapWithChrome(makeChrome(store, { withId: true }));

        // saveStats serializes through a promise chain → await the returned tail.
        await ILAP.saveStats('Recovered Game', 'Manual');

        expect(store.ilap_ignored_count).toBe(1);
        expect(store.ilap_last_ignored_name).toBe('Recovered Game');
        expect(Array.isArray(store.ilap_ignored_history)).toBe(true);
        expect(store.ilap_ignored_history[0].name).toBe('Recovered Game');
    });
});
