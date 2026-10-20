// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadSettingsSchema } = require('../_settings-schema.js');

// Steam's ignore-list size as the popup headline: the pure snapshot and
// display formula (src/stats.js), and the store-page poll that refreshes the
// snapshot while nothing drains (src/ignored-total.js).

const SRC = path.join(__dirname, '..', '..', 'src');

function loadStats(sandbox) {
    sandbox = sandbox || { window: {} };
    if (!vm.isContext(sandbox)) vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(SRC, 'stats.js'), 'utf8'), sandbox);
    return sandbox.window.ILAP.StatsLogic;
}

const MIN = 60 * 1000;

// Steam's userdata as the strict reader returns it: appid -> ignore reason.
const ignoredOf = (appids) => new Map(appids.map((a) => [a, 0]));

// ignored-total.js against a stub storage and Steam layer. `opts.session` is
// what SteamAuth.hasLiveSession answers, `opts.probe` the fresh probeLogin,
// `opts.userdata` the strict read, `opts.lastSlotAt` the gate's last slot
// (a function: asked on each call).
function bootPoll(stored, opts) {
    const store = Object.assign({}, stored);
    const calls = { session: 0, probe: 0, fetch: 0, recorded: [] };
    const sandbox = {
        Date, Math,
        document: { readyState: 'complete' },
        chrome: {
            runtime: {},
            storage: {
                local: {
                    get: (keys, cb) => {
                        const out = {};
                        for (const k of keys) if (k in store) out[k] = store[k];
                        setTimeout(() => cb(out), 0);
                    },
                    set: (obj) => { Object.assign(store, obj); },
                },
            },
        },
        window: { ILAP: {
            SteamAuth: {
                hasLiveSession: async () => { calls.session++; return opts.session; },
                probeLogin: async () => { calls.probe++; return opts.probe; },
            },
            fetchIgnoredAppsStrict: async () => { calls.fetch++; return opts.userdata; },
            IgnoreGate: { lastSlotAt: async () => (typeof opts.lastSlotAt === 'function'
                ? opts.lastSlotAt() : opts.lastSlotAt || 0) },
            recordIgnoredTotal: async (n) => { calls.recorded.push(n); },
        } },
    };
    vm.createContext(sandbox);
    loadSettingsSchema(sandbox);
    loadStats(sandbox);
    // The real steam-net.js, for USERDATA_LAG_MS only: ignored-total.js reads
    // Steam through the facade stubs above, not through SteamNet.
    vm.runInContext(fs.readFileSync(path.join(SRC, 'steam-net.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(path.join(SRC, 'ignored-total.js'), 'utf8'), sandbox);
    const flush = async () => {
        for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    };
    return { store, calls, flush };
}

test.describe('Steam ignore-list total (unit)', () => {

    test('totalState snapshots the size with the counter it was read against', () => {
        const S = loadStats();
        expect(S.totalState({ ilap_ignored_count: 12 }, 900, 5)).toEqual({
            ilap_ignored_total: { total: 900, tallyAt: 12, ts: 5 },
        });
        expect(S.totalState({}, 0, 5).ilap_ignored_total.tallyAt).toBe(0);
    });

    test('displayTotal adds what the counter moved since the read, and is null before any read', () => {
        const S = loadStats();
        const snap = { total: 900, tallyAt: 12, ts: 5 };
        expect(S.displayTotal(snap, 12)).toBe(900);
        expect(S.displayTotal(snap, 15)).toBe(903);    // three swipes since
        expect(S.displayTotal(snap, 10)).toBe(898);    // two rollbacks since
        expect(S.displayTotal({ total: 1, tallyAt: 5 }, 0)).toBe(0);   // floored
        expect(S.displayTotal(undefined, 40)).toBe(null);
        expect(S.displayTotal({ total: 'x' }, 40)).toBe(null);
    });

    test('a stale total is re-read once on a signed-in store page', async () => {
        const b = bootPoll({ ilap_ignored_total: { total: 5, tallyAt: 0, ts: Date.now() - 20 * MIN } },
            { session: true, userdata: ignoredOf(['1', '2', '3']) });
        await b.flush();
        expect(b.calls.fetch).toBe(1);
        expect(b.calls.recorded).toEqual([3]);
        expect(b.store.ilap_ignored_total_poll).toBeGreaterThan(Date.now() - MIN);
    });

    test('no snapshot at all counts as stale', async () => {
        const b = bootPoll({}, { session: true, userdata: ignoredOf(['1']) });
        await b.flush();
        expect(b.calls.recorded).toEqual([1]);
    });

    test('a fresh snapshot, or another tab\'s recent attempt, costs no request', async () => {
        const fresh = bootPoll({ ilap_ignored_total: { total: 5, tallyAt: 0, ts: Date.now() - MIN } },
            { session: true, userdata: ignoredOf([]) });
        const claimed = bootPoll({ ilap_ignored_total_poll: Date.now() - MIN },
            { session: true, userdata: ignoredOf([]) });
        await fresh.flush();
        await claimed.flush();
        for (const b of [fresh, claimed]) {
            expect(b.calls.session).toBe(0);
            expect(b.calls.fetch).toBe(0);
        }
    });

    test('a signed-out page claims the attempt but reads nothing (an empty list is never a 0)', async () => {
        for (const session of [false, null]) {
            const b = bootPoll({}, { session, userdata: ignoredOf([]) });
            await b.flush();
            expect(b.calls.fetch).toBe(0);
            expect(b.calls.recorded).toEqual([]);
            expect(b.store.ilap_ignored_total_poll).toBeGreaterThan(0);
        }
    });

    test('with the master switch off nothing is read or claimed', async () => {
        const b = bootPoll({ ilap_master_enabled: false }, { session: true, userdata: ignoredOf(['1']) });
        await b.flush();
        expect(b.calls.session).toBe(0);
        expect(b.calls.fetch).toBe(0);
        expect(b.store.ilap_ignored_total_poll).toBeUndefined();
    });

    test('an empty read counts only once the fresh probe confirms the session', async () => {
        // The header can still show signed-in on a session that has died since.
        const dead = bootPoll({}, { session: true, probe: false, userdata: ignoredOf([]) });
        const live = bootPoll({}, { session: true, probe: true, userdata: ignoredOf([]) });
        await dead.flush();
        await live.flush();
        expect(dead.calls.recorded).toEqual([]);
        expect(live.calls.recorded).toEqual([0]);
        // A non-empty read needs no extra request.
        const full = bootPoll({}, { session: true, userdata: ignoredOf(['1']) });
        await full.flush();
        expect(full.calls.probe).toBe(0);
    });

    test('within the userdata lag of a POST nothing is read or claimed', async () => {
        // The counter already has that POST and userdata may not yet: the
        // next page load asks again.
        const b = bootPoll({}, { session: true, userdata: ignoredOf(['1']), lastSlotAt: Date.now() - 3000 });
        await b.flush();
        expect(b.calls.session).toBe(0);
        expect(b.calls.fetch).toBe(0);
        expect(b.store.ilap_ignored_total_poll).toBeUndefined();
    });

    test('a POST sent between the lag check and the read: read, but nothing recorded', async () => {
        // The check before the read cannot see it, and userdata may not show it
        // while the counter already does: the snapshot would pin the headline
        // one short until the next read.
        // No slot at the first ask, one going out by the second.
        let asked = 0;
        const lastSlotAt = () => (asked++ === 0 ? 0 : Date.now());
        const b = bootPoll({}, { session: true, userdata: ignoredOf(['1']), lastSlotAt });
        await b.flush();
        expect(b.calls.fetch).toBe(1);
        expect(b.calls.recorded).toEqual([]);
    });

    test('a failed read records nothing', async () => {
        const b = bootPoll({}, { session: true, userdata: null });
        await b.flush();
        expect(b.calls.fetch).toBe(1);
        expect(b.calls.recorded).toEqual([]);
    });
});
