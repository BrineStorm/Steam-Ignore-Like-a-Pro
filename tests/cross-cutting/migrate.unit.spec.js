const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Install/update surface migration (src/migrate.js) as a Node unit — no browser.
// The script is the only background context and the --test build swaps it out,
// so E2E never exercises it; this unit drives the captured onInstalled listener
// directly and guards the default-picking contract:
//   - fresh install persists 'widget' (explicitly, so later updates see the key)
//     plus the ilap_intro_glow new-install chevron beacon;
//   - update with the key ABSENT = pre-surface-switch profile → 'popup' plus the
//     one-shot ilap_update_glow popup highlight;
//   - update with the key PRESENT = user's choice → untouched (so LATER updates
//     never re-arm the glow);
//   - any other reason (chrome_update, …) → no write;
//   - onStartup re-asserts 'widget' when the key is absent (a lost onInstalled
//     write), no glow flags, and YIELDS to an install/update event fired in the
//     same lifetime (the update-while-browser-closed race).

function loadMigrate(initial, opts) {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'migrate.js'), 'utf8');
    let data = { ...(initial || {}) };
    const sets = [];
    let onInstalled = null;
    let onStartup = null;
    const runtime = {
        onInstalled: { addListener: (fn) => { onInstalled = fn; } },
        onStartup: { addListener: (fn) => { onStartup = fn; } },
    };
    const local = {
        get: (key, cb) => setTimeout(() => {
            if (opts && opts.failGet) {
                // A transient storage error: callback fires with an empty
                // result while chrome.runtime.lastError is set (real chrome
                // clears it after the callback returns).
                runtime.lastError = { message: 'storage unavailable' };
                cb({});
                delete runtime.lastError;
                return;
            }
            cb(key in data ? { [key]: data[key] } : {});
        }, 0),
        set: (obj, cb) => setTimeout(() => {
            Object.assign(data, obj);
            sets.push({ ...obj });
            if (cb) cb();
        }, 0),
    };
    const sandbox = {
        chrome: { runtime, storage: { local } },
        // The onStartup re-assert delays 3 s in product; collapse every sandbox
        // timer to a 0 ms macrotask so the unit is instant AND deterministic
        // (the race-guard contract rides the installEventSeen flag, not wall time).
        setTimeout: (fn) => setTimeout(fn, 0),
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    // Deterministic flush: the deepest callback chain (startup delay → get → set)
    // is three timer hops; eight sequential macrotask turns always cover it,
    // where a fixed wall-clock sleep was flaky under load.
    const flush = async () => {
        for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    };
    return {
        fire: (details) => onInstalled(details),
        fireStartup: () => onStartup(),
        flush, sets, data: () => data,
    };
}

test.describe('surface install-default migration (unit)', () => {

    test('fresh install persists widget explicitly, with the intro glow armed', async () => {
        const m = loadMigrate({});
        m.fire({ reason: 'install' });
        await m.flush();
        expect(m.sets).toEqual([{ ilap_surface_mode: 'widget', ilap_intro_glow: true }]);
    });

    test('update from a pre-surface-key build (key absent) lands on popup, glow armed once', async () => {
        const m = loadMigrate({ ilap_ignored_count: 42 }); // old profile, no surface key
        m.fire({ reason: 'update' });
        await m.flush();
        expect(m.sets).toEqual([{ ilap_surface_mode: 'popup', ilap_update_glow: true }]);

        // The NEXT update finds the key present → nothing re-arms the glow.
        m.fire({ reason: 'update' });
        await m.flush();
        expect(m.sets).toHaveLength(1);
    });

    test('update with the key already present leaves it untouched', async () => {
        for (const mode of ['widget', 'popup']) {
            const m = loadMigrate({ ilap_surface_mode: mode });
            m.fire({ reason: 'update' });
            await m.flush();
            expect(m.sets).toEqual([]);
            expect(m.data().ilap_surface_mode).toBe(mode);
        }
    });

    test('a transient storage error on update writes nothing (widget profile not mis-migrated)', async () => {
        // The profile HAS the key, but the get errors and reports {} — without
        // the lastError guard that read as "key absent" and migrated a widget
        // user to 'popup'.
        const m = loadMigrate({ ilap_surface_mode: 'widget' }, { failGet: true });
        m.fire({ reason: 'update' });
        await m.flush();
        expect(m.sets).toEqual([]);
        expect(m.data().ilap_surface_mode).toBe('widget');
    });

    test('other reasons (chrome_update) write nothing', async () => {
        const m = loadMigrate({});
        m.fire({ reason: 'chrome_update' });
        await m.flush();
        expect(m.sets).toEqual([]);
    });

    test('onStartup re-asserts widget when the key is absent — no glow flags', async () => {
        // Models a LOST onInstalled write: the profile runs with the key absent.
        // Without the re-assert, a later update would mis-migrate it to popup.
        const m = loadMigrate({ ilap_ignored_count: 7 });
        m.fireStartup();
        await m.flush();
        expect(m.sets).toEqual([{ ilap_surface_mode: 'widget' }]);
    });

    test('onStartup leaves a present key untouched (and survives a failing get)', async () => {
        for (const mode of ['widget', 'popup']) {
            const m = loadMigrate({ ilap_surface_mode: mode });
            m.fireStartup();
            await m.flush();
            expect(m.sets).toEqual([]);
            expect(m.data().ilap_surface_mode).toBe(mode);
        }
        const failing = loadMigrate({ ilap_surface_mode: 'popup' }, { failGet: true });
        failing.fireStartup();
        await failing.flush();
        expect(failing.sets).toEqual([]);
    });

    test('onStartup yields to an install/update event in the same lifetime (race guard)', async () => {
        // Update-while-browser-closed: both events fire at the same launch. The
        // re-assert must NOT beat the update branch to the key, or the legacy
        // popup migration would see 'widget' present and skip itself.
        const m = loadMigrate({ ilap_ignored_count: 42 }); // pre-surface-key profile
        m.fireStartup();
        m.fire({ reason: 'update' });
        await m.flush();
        expect(m.sets).toEqual([{ ilap_surface_mode: 'popup', ilap_update_glow: true }]);
        expect(m.data().ilap_surface_mode).toBe('popup');
    });
});
