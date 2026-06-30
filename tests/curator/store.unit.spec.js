const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The curator storage model (src/curator/store.js) keeps its decision logic in
// three pure helpers — evictCache (TTL + LRU), lockFree (lease takeability),
// isFresh — so they unit-test in Node without chrome.storage. The async
// chrome-backed methods are exercised via the drainer E2E.
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
