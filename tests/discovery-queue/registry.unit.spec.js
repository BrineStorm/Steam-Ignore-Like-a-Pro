const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Cross-tab DQ-automator cap (src/discovery-queue/registry.js) as a Node unit.
// Pure helpers (activeCount / prune) plus the serialized tryAcquire/renew/release
// over an async chrome.storage stub — the same harness the store unit uses.

function loadRegistry(initial) {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'discovery-queue', 'registry.js'), 'utf8');
    const clone = (v) => JSON.parse(JSON.stringify(v));
    let data = clone(initial || {});
    const norm = (keys) => (Array.isArray(keys) ? keys : [keys]);
    const local = {
        get: (keys, cb) => setTimeout(() => {
            const out = {};
            for (const k of norm(keys)) if (k in data) out[k] = clone(data[k]);
            cb(out);
        }, 0),
        set: (obj, cb) => setTimeout(() => {
            for (const k of Object.keys(obj)) data[k] = clone(obj[k]);
            if (cb) cb();
        }, 0),
    };
    const sandbox = { window: {}, chrome: { storage: { local } }, setTimeout, Date, Math, JSON, Object };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return { R: sandbox.window.ILAP.Discovery.Registry, data: () => data };
}

test.describe('DQ-automator registry (unit)', () => {

    test('activeCount counts only live owners and honours the exclude', () => {
        const { R } = loadRegistry();
        const now = 1000;
        const map = { a: 2000, b: 500 /* expired */, c: 3000 };
        expect(R.activeCount(map, now)).toBe(2);       // a, c live; b expired
        expect(R.activeCount(map, now, 'a')).toBe(1);  // exclude a → only c
    });

    test('prune drops expired owners', () => {
        const { R } = loadRegistry();
        expect(R.prune({ a: 2000, b: 500 }, 1000)).toEqual({ a: 2000 });
    });

    test('tryAcquire fills up to the cap, then refuses a new owner', async () => {
        const { R } = loadRegistry();
        expect(await R.tryAcquire('a')).toBe(true);
        expect(await R.tryAcquire('b')).toBe(true);   // CAP is 2
        expect(await R.tryAcquire('c')).toBe(false);  // full
    });

    test('an owner already holding a slot re-acquires (renew), never blocked', async () => {
        const { R } = loadRegistry();
        await R.tryAcquire('a');
        await R.tryAcquire('b'); // cap full with a, b
        expect(await R.tryAcquire('a')).toBe(true); // a already holds → renew, still ok
    });

    test('an expired slot is reclaimed so a new owner can acquire', async () => {
        const now = Date.now();
        // Two slots, but both already expired → count as free.
        const { R, data } = loadRegistry({ ilap_dq_active: { stale1: now - 1, stale2: now - 1 } });
        expect(await R.tryAcquire('fresh')).toBe(true);
        expect('fresh' in data().ilap_dq_active).toBe(true);
        expect('stale1' in data().ilap_dq_active).toBe(false); // pruned on write
    });

    test('release frees the slot', async () => {
        const { R, data } = loadRegistry();
        await R.tryAcquire('a');
        await R.release('a');
        expect(data().ilap_dq_active.a).toBeUndefined();
    });
});
