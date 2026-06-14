const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// StatsLogic.pushHistory caps ilap_ignored_history at 20 (src/utils.js). It's
// module-private, reachable only through the public window.ILAP.saveStats facade
// (→ StatsManager.save → chrome.storage). The old test drove saveStats from
// page context, but window.ILAP lives in the content script's ISOLATED world and
// is invisible to page.evaluate. Since the cap is pure logic, load utils.js in
// Node (vm) with a window stub + an in-memory chrome.storage, then exercise the
// real facade. No browser, no Steam login, deterministic.
function loadIlap() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'utils.js'),
        'utf8'
    );

    const store = {};
    const chrome = {
        runtime: { id: 'test-ctx', lastError: undefined },
        storage: {
            local: {
                // Synchronous in-memory get/set → saveStats resolves inline,
                // keeping the 25 sequential calls ordered without races.
                get(keys, cb) {
                    const out = {};
                    const list = Array.isArray(keys)
                        ? keys
                        : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
                    for (const k of list) if (k in store) out[k] = store[k];
                    cb(out);
                },
                set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
            },
        },
    };

    const sandbox = { window: {}, chrome, console };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return { ILAP: sandbox.window.ILAP, store };
}

test.describe('Cross-cutting — ilap_ignored_history is capped at 20 (unit)', () => {

    test('25 saveStats calls → history holds exactly 20, newest-first; count tracks all 25', () => {
        const { ILAP, store } = loadIlap();

        for (let i = 1; i <= 25; i++) {
            ILAP.saveStats(`Game ${i}`, 'Manual');
        }

        // Count tracks every call regardless of the history cap.
        expect(store.ilap_ignored_count).toBe(25);

        const history = store.ilap_ignored_history;
        expect(Array.isArray(history)).toBe(true);
        expect(history.length).toBe(20);

        // pushHistory prepends → index 0 is newest (Game 25); the cap drops the
        // oldest five (Game 1..5).
        expect(history[0].name).toBe('Game 25');
        expect(history[19].name).toBe('Game 6');
        const names = history.map(h => h.name);
        expect(names).not.toContain('Game 5');
        expect(names).not.toContain('Game 1');

        expect(store.ilap_last_ignored_name).toBe('Game 25');
    });
});
