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
//   - any other reason (chrome_update, …) → no write.

function loadMigrate(initial) {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'migrate.js'), 'utf8');
    let data = { ...(initial || {}) };
    const sets = [];
    let onInstalled = null;
    const local = {
        get: (key, cb) => setTimeout(() => cb(key in data ? { [key]: data[key] } : {}), 0),
        set: (obj, cb) => setTimeout(() => {
            Object.assign(data, obj);
            sets.push({ ...obj });
            if (cb) cb();
        }, 0),
    };
    const sandbox = {
        chrome: {
            runtime: { onInstalled: { addListener: (fn) => { onInstalled = fn; } } },
            storage: { local },
        },
        setTimeout,
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    const flush = () => new Promise((r) => setTimeout(r, 10));
    return { fire: (details) => onInstalled(details), flush, sets, data: () => data };
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

    test('other reasons (chrome_update) write nothing', async () => {
        const m = loadMigrate({});
        m.fire({ reason: 'chrome_update' });
        await m.flush();
        expect(m.sets).toEqual([]);
    });
});
