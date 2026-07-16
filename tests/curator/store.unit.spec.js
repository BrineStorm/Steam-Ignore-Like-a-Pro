const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The curator storage model (src/curator/store.js) keeps its decision logic in
// three pure helpers — evictCache (TTL + LRU), lockFree (lease takeability),
// isFresh — so they unit-test in Node without chrome.storage. The queue RMW
// path (mutateQueue serialization, cursor keys) is unit-tested below against an
// async in-memory chrome.storage stub; the rest is exercised via the drainer E2E.
function loadStore() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'curator', 'store.js'),
        'utf8'
    );
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.Curator.Store;
}

// Load the store against an async chrome.storage.local stub. Every get/set/remove
// completes on a macrotask (setTimeout 0), so an UNserialized read-modify-write
// genuinely interleaves — exactly the lost-update race mutateQueue must close.
function loadStoreWithChrome(initial) {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'curator', 'store.js'),
        'utf8'
    );
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const norm = (keys) => (Array.isArray(keys) ? keys : [keys]);
    let data = clone(initial || {});
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
        remove: (keys, cb) => setTimeout(() => {
            for (const k of norm(keys)) delete data[k];
            if (cb) cb();
        }, 0),
    };
    const sandbox = { window: {}, chrome: { storage: { local } }, setTimeout, Date, Math, JSON };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return { Store: sandbox.window.ILAP.Curator.Store, data: () => data };
}

const DAY = 24 * 60 * 60 * 1000;

test.describe('Curator storage — pure helpers (unit)', () => {
    const S = loadStore();

    test('isFresh respects the TTL window', () => {
        const now = 1_000_000_000_000;
        expect(S.isFresh({ fetchedAt: now - 1 * DAY }, now)).toBe(true);
        expect(S.isFresh({ fetchedAt: now - 8 * DAY }, now)).toBe(false);
        expect(S.isFresh(null, now)).toBe(false);
    });

    test('evictCache drops entries older than the 7-day TTL', () => {
        const now = 1_000_000_000_000;
        const cache = {
            fresh: { fetchedAt: now - 1 * DAY, apps: {} },
            stale: { fetchedAt: now - 9 * DAY, apps: {} },
        };
        const out = S.evictCache(cache, now);
        expect(Object.keys(out)).toEqual(['fresh']);
    });

    test('evictCache keeps only the 10 most-recently-fetched curators (LRU cap)', () => {
        const now = 1_000_000_000_000;
        const cache = {};
        // 12 entries, fetchedAt increasing with index → c0 oldest, c11 newest.
        for (let i = 0; i < 12; i++) {
            cache['c' + i] = { fetchedAt: now - (12 - i) * 1000, apps: {} };
        }
        const out = S.evictCache(cache, now);
        const kept = Object.keys(out).sort();
        expect(kept).toHaveLength(10);
        // The two oldest (c0, c1) are evicted; the newest survive.
        expect(out.c0).toBeUndefined();
        expect(out.c1).toBeUndefined();
        expect(out.c11).toBeDefined();
    });

    test('lockFree: a lock is takeable when missing, ours, or expired', () => {
        const now = 1_000_000;
        expect(S.lockFree(null, 'me', now)).toBe(true);
        expect(S.lockFree({ owner: 'me', expiresAt: now + 5000 }, 'me', now)).toBe(true);
        expect(S.lockFree({ owner: 'other', expiresAt: now - 1 }, 'me', now)).toBe(true);   // expired
        expect(S.lockFree({ owner: 'other', expiresAt: now + 5000 }, 'me', now)).toBe(false); // held
    });
});

test.describe('Curator storage — serialized queue writes (unit)', () => {

    test('20 concurrent updateJob patches all land (no lost update)', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{ id: 'a', status: 'pending' }],
        });
        // Without the mutateQueue chain these overlapping get→set pairs would
        // read the same base record and clobber each other's fields.
        await Promise.all(Array.from({ length: 20 }, (_, i) =>
            Store.updateJob('a', { ['f' + i]: true })
        ));
        const job = data().ilap_curator_queue[0];
        for (let i = 0; i < 20; i++) expect(job['f' + i]).toBe(true);
    });

    test('concurrent updateJob + removeJob lose neither effect', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [
                { id: 'a', status: 'pending' },
                { id: 'b', status: 'pending' },
            ],
            ilap_curator_cursor_b: 5,
        });
        await Promise.all([
            Store.updateJob('a', { status: 'paused' }),
            Store.removeJob('b'),
        ]);
        const q = data().ilap_curator_queue;
        expect(q.map(j => j.id)).toEqual(['a']);
        expect(q[0].status).toBe('paused');
        // The removed job's progress cursor is cleaned up with it.
        expect(data().ilap_curator_cursor_b).toBeUndefined();
    });

    test('updateJob accepts a function patch and no-ops on a missing job', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{ id: 'a', status: 'paused' }],
        });
        const updated = await Store.updateJob('a', (j) => ({
            status: j.status === 'paused' ? 'pending' : 'paused',
        }));
        expect(updated.status).toBe('pending');
        expect(data().ilap_curator_queue[0].status).toBe('pending');

        const missing = await Store.updateJob('nope', { status: 'paused' });
        expect(missing).toBeNull();
        expect(data().ilap_curator_queue).toHaveLength(1);
    });

    test('pause-button spam: 11 concurrent toggles land as exact click parity', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{ id: 'a', status: 'pending' }],
        });
        // Models a user hammering Pause/Resume: every toggle is a function patch
        // evaluated inside the serialized RMW, so each click sees the state left
        // by the previous one. 11 toggles from 'pending' → odd parity → 'paused'.
        // (Unserialized, overlapping toggles read the same base status and
        // collapse — e.g. two clicks become one toggle.)
        await Promise.all(Array.from({ length: 11 }, () =>
            Store.updateJob('a', (j) => ({ status: j.status === 'paused' ? 'pending' : 'paused' }))
        ));
        expect(data().ilap_curator_queue[0].status).toBe('paused');
    });

    test('cursor keys: setCursor/getCursor roundtrip, null when unset', async () => {
        const { Store } = loadStoreWithChrome({ ilap_curator_queue: [{ id: 'j1' }] });
        expect(await Store.getCursor('j1')).toBeNull();
        expect(await Store.setCursor('j1', 7)).toBe(true);
        expect(await Store.getCursor('j1')).toBe(7);
    });

    test('setCursor refuses for a job not in the queue — a removed job cannot leak its key', async () => {
        const { Store, data } = loadStoreWithChrome({ ilap_curator_queue: [{ id: 'j1' }] });
        await Store.setCursor('j1', 3);
        // removeJob is the cursor key's ONLY cleanup path; a cursor write
        // landing after it (remove/resolve or remove/drain race) must not
        // recreate the key.
        await Store.removeJob('j1');
        expect(await Store.setCursor('j1', 4)).toBe(false);
        expect(data()['ilap_curator_cursor_j1']).toBeUndefined();
        expect(await Store.getCursor('j1')).toBeNull();
    });
});
