const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// CuratorQueueDrainer lease discipline as Node units — no browser. The E2E
// drain.spec covers the happy paths; these guards are timing races (lease TTL
// vs a dedupe-skip run, a lease steal during the gate wait) that E2E can't
// drive deterministically. Audit findings #3/#4.

function loadDrainerClass(DateImpl, timers) {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'curator', 'drainer.js'), 'utf8');
    const sandbox = {
        window: {},
        Math, Date: DateImpl || Date, Promise, Object, Array, String, Set,
        setInterval: (timers && timers.setInterval) || setInterval,
        clearInterval: (timers && timers.clearInterval) || clearInterval,
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.Curator.CuratorQueueDrainer;
}

test.describe('CuratorQueueDrainer (unit)', () => {

    test('a dedupe-skip run heartbeats the lease (no POSTs, lease still renewed)', async () => {
        // Every appid is already ignored → the whole job drains via the skip
        // branch. The skips advance fake time past HEARTBEAT_MS (3 s) each, so
        // the lease must be renewed along the way — without it the 8 s TTL
        // would lapse and a standby tab would steal the lock mid-drain.
        let now = 0;
        const Drainer = loadDrainerClass({ now: () => now });
        const appids = ['1', '2', '3', '4', '5'];
        const job = { id: 'j1', curatorId: 'c1', status: 'pending', appids };
        let cursor = 0;
        let removed = false;
        const renews = [];
        const posts = [];
        const store = {
            getQueue: async () => (removed ? [] : [{ ...job }]),
            holdsLock: async () => true,
            getCursor: async () => cursor,
            setCursor: async (id, c) => { cursor = c; now += 4000; },
            renewLock: async () => { renews.push(now); },
            removeJob: async () => { removed = true; },
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            api: { ignore: async (appid) => { posts.push(appid); return { ok: true }; } },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(appids), // everything already ignored
            ownerId: 't1',
        });
        await d._drainJob(job);
        expect(posts).toEqual([]);                       // pure dedupe pass — no requests
        expect(cursor).toBe(appids.length);
        expect(removed).toBe(true);                      // job completed and dropped
        expect(renews.length).toBeGreaterThanOrEqual(2); // lease heartbeated during the run
    });

    test('a lease stolen during the gate wait stops before the POST (no cursor burn)', async () => {
        // The pacing wait in gate.reserve() can span seconds; model the steal
        // by dropping the lease inside reserve(). The loop-top holdsLock check
        // already passed, so only the post-wait re-check can catch this.
        const Drainer = loadDrainerClass();
        const job = { id: 'j1', curatorId: 'c1', status: 'pending', appids: ['10'] };
        let lockHeld = true;
        let cursor = 0;
        const posts = [];
        const store = {
            getQueue: async () => [{ ...job }],
            holdsLock: async () => lockHeld,
            getCursor: async () => cursor,
            setCursor: async (id, c) => { cursor = c; },
            renewLock: async () => {},
            removeJob: async () => {},
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            api: { ignore: async (appid) => { posts.push(appid); return { ok: true }; } },
            gate: { reserve: async () => { lockHeld = false; return { ok: true }; } },
            fetchUserdata: async () => new Set(),
            ownerId: 't1',
        });
        await d._drainJob(job);
        expect(posts).toEqual([]); // single-drainer invariant: no POST after the steal
        expect(cursor).toBe(0);    // and the stolen iteration burned no cursor
    });

    test('a 429 (rate-limited) ends the pass without burning fails or cursor', async () => {
        // The server throttling the ACCOUNT must not be charged against the
        // current appid (MAX_FAILS would eventually skip innocent games): the
        // drainer reports the 429 to the shared gate and stops the pass like a
        // gate stop, so the standby tick retries once the penalty expires.
        const Drainer = loadDrainerClass();
        const job = { id: 'j1', curatorId: 'c1', status: 'pending', appids: ['10', '11'] };
        let cursor = 0;
        const posts = [];
        const reports = [];
        const store = {
            getQueue: async () => [{ ...job }],
            holdsLock: async () => true,
            getCursor: async () => cursor,
            setCursor: async (id, c) => { cursor = c; },
            renewLock: async () => {},
            removeJob: async () => {},
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            api: { ignore: async (appid) => {
                posts.push(appid);
                return { ok: false, rateLimited: true, retryAfterMs: 7000 };
            } },
            gate: {
                reserve: async () => ({ ok: true }),
                reportRateLimited: async (ms) => { reports.push(ms); },
            },
            fetchUserdata: async () => new Set(),
            ownerId: 't1',
        });
        const result = await d._drainJob(job);
        expect(result).toBe('stop');     // ends the whole pass, no same-pass retry hammer
        expect(posts).toEqual(['10']);   // exactly one POST fired
        expect(cursor).toBe(0);          // nothing advanced or skipped
        expect(reports).toEqual([7000]); // Retry-After forwarded to the shared gate
    });

    test('standby interval armed only while the queue holds a job', async () => {
        // Audit cleanup: with a permanently empty queue the 9 s
        // standby tick used to run forever in every store tab (one storage read
        // per tick). Now drain() arms it when a job appears and disarms it when
        // the queue empties; onChanged covers the empty→staged transition.
        const arms = [];
        const clears = [];
        const Drainer = loadDrainerClass(null, {
            setInterval: () => { arms.push(1); return arms.length; },
            clearInterval: (id) => { clears.push(id); },
        });
        let queue = [];
        const d = new Drainer({
            store: {
                getQueue: async () => queue,
                // A paused job is not drainable → drain() breaks right after the
                // timer sync, which is exactly the state we want to observe.
                holdsLock: async () => false,
            },
            api: { ignore: async () => ({ ok: true }) },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            ownerId: 't1',
        });

        await d.drain();                                  // empty queue
        expect(arms).toEqual([]);                         // never armed

        queue = [{ id: 'j1', curatorId: 'c1', status: 'paused', appids: ['1'] }];
        await d.drain();
        expect(arms).toEqual([1]);                        // armed once
        await d.drain();
        expect(arms).toEqual([1]);                        // no double-arm

        queue = [];
        await d.drain();
        expect(clears).toEqual([1]);                      // disarmed on empty
        expect(d._timer).toBe(null);
    });
});
