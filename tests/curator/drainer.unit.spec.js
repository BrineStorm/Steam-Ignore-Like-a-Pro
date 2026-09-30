const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { withVocab } = require('./_store-vocab.js');
const { loadEscape } = require('../_escape.js');
const { loadEnumerator } = require('../_curator.js');

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
        // The trailing re-kick MIN_PASS_GAP_MS defers with. Stubbable so a unit
        // can see WHAT was deferred without waiting the real gap out.
        setTimeout: (timers && timers.setTimeout) || setTimeout,
        clearTimeout: (timers && timers.clearTimeout) || clearTimeout,
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    // Every drainer dependency is required. A unit fills in what it is not about
    // with inert stand-ins: a confirmed login probe, no-op stats and log hooks, a
    // gate that never stops, and pulses that go nowhere. The lease reads through to
    // the stub store's lock methods (the units model one storage), held when the
    // stub has none; the store gets the real job vocabulary.
    const Drainer = sandbox.window.ILAP.Curator.CuratorQueueDrainer;
    const noop = async () => {};
    return class extends Drainer {
        constructor(deps) {
            const store = deps.store && withVocab(deps.store);
            if (store) {
                for (const m of ['signalCompleted', 'signalUnignored', 'signalUndoFailed', 'bumpSkipped']) {
                    if (!store[m]) store[m] = noop;
                }
            }
            const viaStore = (name, fallback) => (...args) =>
                (store && store[name] ? store[name](...args) : fallback());
            super(Object.assign({
                probeLogin: async () => true,
                lease: {
                    acquireLock: viaStore('acquireLock', async () => true),
                    renewLock: viaStore('renewLock', async () => true),
                    holdsLock: viaStore('holdsLock', async () => true),
                    releaseLock: viaStore('releaseLock', noop),
                    LOCK_PREFIX: 'ilap_curator_lock_',
                },
                fetchUserdata: async () => new Set(),
                saveStats: noop, bumpCount: noop, dropCount: noop,
            }, deps, {
                api: Object.assign({
                    ignore: async () => { throw new Error('unexpected ignore POST'); },
                    unignore: async () => { throw new Error('unexpected unignore POST'); },
                }, deps.api),
                log: Object.assign({
                    append: noop, markUndone: noop,
                    lastIgnoredAt: async () => -Infinity, wasReIgnoredAfter: async () => false,
                }, deps.log),
                gate: Object.assign({
                    reserve: async () => { throw new Error('unexpected gate reservation'); },
                    reportRateLimited: noop, stopped: async () => null,
                }, deps.gate),
            }));
        }
    };
}

// drainer.js as a store tab loads it: the facade present, so the tab host at the
// bottom builds its own drainer and wires the storage listener. The document is
// still loading, so the boot kick waits; a test fires the listener by hand.
function loadTabHost() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'curator', 'drainer.js'), 'utf8');
    const listeners = [];
    const fn = async () => {};
    const store = withVocab({ QUEUE_KEY: 'ilap_curator_queue' });
    const sandbox = {
        Math, Date, Promise, Object, Array, String, Set,
        setInterval, clearInterval, setTimeout, clearTimeout,
        document: { readyState: 'loading', addEventListener: () => {} },
        chrome: { storage: { onChanged: { addListener: (l) => listeners.push(l) } } },
        window: { ILAP: {
            newOwnerId: () => 'tab',
            Settings: { KEYS: { MASTER: 'ilap_master_enabled' } },
            Curator: {
                Store: store,
                Lease: { acquireLock: fn, renewLock: fn, holdsLock: fn, releaseLock: fn,
                    LOCK_PREFIX: 'ilap_curator_lock_' },
            },
            apiIgnoreGame: fn, apiUnignoreGame: fn, classifyRefusal: (a, r) => r,
            IgnoreGate: { reserve: fn, reportRateLimited: fn, stopVerdict: fn },
            fetchIgnoredAppsStrict: fn,
            SteamAuth: { probeLogin: fn },
            saveStats: fn, bumpIgnoredCount: fn, dropIgnoredCount: fn,
            StatsLogic: { miSourceLabel: () => '' },
            IgnoreLog: { drainerHooks: () => ({ append: fn, markUndone: fn, lastIgnoredAt: fn, wasReIgnoredAfter: fn }) },
        } },
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return { drainer: sandbox.window.ILAP.Curator.drainer, listeners };
}

// A complete set of real-shaped deps, for the construction contract.
function fullDeps() {
    const fn = async () => {};
    return {
        store: withVocab({}),
        lease: { acquireLock: fn, renewLock: fn, holdsLock: fn, releaseLock: fn },
        api: { ignore: fn, unignore: fn },
        gate: { reserve: fn, reportRateLimited: fn, stopped: fn },
        fetchUserdata: fn,
        probeLogin: fn,
        ownerId: 't',
        log: { append: fn, markUndone: fn, lastIgnoredAt: fn, wasReIgnoredAfter: fn },
        saveStats: fn, bumpCount: fn, dropCount: fn,
    };
}

test.describe('CuratorQueueDrainer (unit)', () => {

    test('a drainer missing any dependency refuses to be built, naming it', async () => {
        // A missing probe would read as "signed in", a missing gate.stopped as
        // "never stopped", a missing log as nothing to record: each would switch
        // a check or a record off without a trace.
        const code = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'curator', 'drainer.js'), 'utf8');
        const sandbox = { window: {},
            Math, Date, Promise, Object, Array, String, Set, TypeError,
            setInterval, clearInterval, setTimeout, clearTimeout };
        vm.createContext(sandbox);
        vm.runInContext(code, sandbox);
        const Raw = sandbox.window.ILAP.Curator.CuratorQueueDrainer;
        expect(() => new Raw(fullDeps())).not.toThrow();
        for (const name of Object.keys(fullDeps())) {
            const deps = fullDeps();
            delete deps[name];
            expect(() => new Raw(deps), name).toThrow(new RegExp(`deps\\.${name}`));
        }
        const noStopped = fullDeps();
        delete noStopped.gate.stopped;
        expect(() => new Raw(noStopped)).toThrow(/deps\.gate/);
    });

    test('tab host: only the queue, the master switch and a lease wake a pass', async () => {
        // The listener lives in the host now, not in the drainer. A pass on every
        // write would re-read userdata for a drain's own cursor advances.
        const { drainer, listeners } = loadTabHost();
        expect(listeners).toHaveLength(1);
        let kicks = 0;
        drainer.drain = async () => { kicks++; };
        const fire = (key, area = 'local') => listeners[0]({ [key]: { newValue: 1 } }, area);

        fire('ilap_curator_queue');
        fire('ilap_master_enabled');   // re-enabling resumes a gate-stopped drain
        fire('ilap_curator_lock_123');   // a released lease hands the job over
        expect(kicks).toBe(3);

        fire('ilap_curator_cursor_job_1');
        fire('ilap_ignore_gate');
        fire('ilap_ignore_log_c1');
        fire('ilap_curator_queue', 'sync');
        expect(kicks).toBe(3);
    });

    test('a cursor write after a POST re-reads the queue; a skip reuses the read it made', async () => {
        // A remove can land while the POST is out. Handing setCursor the queue
        // read before the request would miss it, and the removed job's cursor
        // key would be written back, never to be cleaned up.
        const Drainer = loadDrainerClass();
        const writes = [];
        let cursor = 0;
        const d = new Drainer({
            store: {
                getQueue: async () => [{ id: 'j1', curatorId: 'c1', status: 'pending', appids: ['10', '20'] }],
                getCursor: async () => cursor,
                setCursor: async (id, c, snapshot) => { cursor = c; writes.push({ c, snapshot }); },
                removeIfDrained: async () => true,
            },
            fetchUserdata: async () => new Set(['10']),     // '10' is a dedupe skip
            api: { ignore: async () => ({ ok: true }) },    // '20' is POSTed
            gate: { reserve: async () => ({ ok: true }) },
            ownerId: 't1',
            standbyMs: 0,
        });

        await d.drain();

        expect(writes.map(w => w.c)).toEqual([1, 2]);
        expect(Array.isArray(writes[0].snapshot)).toBe(true);   // the skip: no network wait since the read
        expect(writes[1].snapshot).toBeUndefined();              // after the POST: read again
    });

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
            removeIfDrained: async () => { removed = true; return true; },
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

    test('the lease is renewed while a POST is in flight, and the renewal stops with it', async () => {
        // A POST (10 s deadline) plus a 400's appdetails read can outlast the
        // 8 s lease with no loop-top heartbeat in between; a standby drainer
        // would then take the lease and send the same entry again.
        const intervals = new Map();
        let nextId = 1;
        const Drainer = loadDrainerClass(undefined, {
            setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
            clearInterval: (id) => { intervals.delete(id); },
        });
        const job = { id: 'j1', curatorId: 'c1', status: 'pending', appids: ['10'] };
        let cursor = 0;
        let renews = 0;
        let release = null;
        const store = {
            getQueue: async () => [{ ...job }],
            holdsLock: async () => true,
            getCursor: async () => cursor,
            setCursor: async (id, c) => { cursor = c; },
            renewLock: async () => { renews++; return true; },
            removeIfDrained: async () => true,
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            api: { ignore: () => new Promise(r => { release = () => r({ ok: true }); }) },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            ownerId: 't1',
        });
        const pending = d._drainJob(job);
        while (!release) await new Promise(r => setImmediate(r));   // POST in flight

        expect(intervals.size).toBe(1);
        const [{ fn, ms }] = intervals.values();
        expect(ms).toBeLessThan(8000);   // beats inside the lease TTL
        fn(); fn();                      // a slow POST spans two beats
        await new Promise(r => setImmediate(r));
        expect(renews).toBe(2);

        release();
        await pending;
        expect(intervals.size).toBe(0);  // no beat outlives the POST
        expect(cursor).toBe(1);
    });

    test('a renewal still in flight when the POST returns is awaited before the entry moves on', async () => {
        // Otherwise its write could land after the pass released the lease and
        // put it back for a full TTL.
        const intervals = new Map();
        const Drainer = loadDrainerClass(undefined, {
            setInterval: (fn) => { intervals.set(1, fn); return 1; },
            clearInterval: (id) => { intervals.delete(id); },
        });
        const job = { id: 'j1', curatorId: 'c1', status: 'pending', appids: ['10'] };
        const order = [];
        let cursor = 0;
        let finishRenew = null;
        let release = null;
        const store = {
            getQueue: async () => [{ ...job }],
            holdsLock: async () => true,
            getCursor: async () => cursor,
            setCursor: async (id, c) => { cursor = c; order.push('cursor'); },
            renewLock: () => new Promise(r => { finishRenew = () => { order.push('renewed'); r(true); }; }),
            removeIfDrained: async () => true,
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            api: { ignore: () => new Promise(r => { release = () => r({ ok: true }); }) },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            ownerId: 't1',
        });
        const pending = d._drainJob(job);
        while (!release) await new Promise(r => setImmediate(r));
        intervals.get(1)();              // a beat starts a renewal…
        release();                       // …and the POST answers before it lands
        await new Promise(r => setImmediate(r));
        expect(order).toEqual([]);       // the loop is held on the renewal
        finishRenew();
        await pending;
        expect(order).toEqual(['renewed', 'cursor']);
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

    test('a classified region-lock skips immediately: one POST, no MAX_FAILS burn, counted and logged', async () => {
        // The api layer marks a permanent per-appid 400 (no store object in
        // the account's region) with res.unavailable: the drainer must step
        // over it in ONE attempt (retrying a region lock is pointless — three
        // tries would burn two extra gate slots), bump the per-job skip
        // counter and leave a `skipped` log entry instead of a silent "done".
        // A skipped appid was never ignored, so it must not reach the total
        // either.
        const Drainer = loadDrainerClass();
        const job = { id: 'j1', curatorId: 'c1', status: 'pending', appids: ['480', '11'] };
        let cursor = 0;
        let removed = false;
        const posts = [];
        const bumps = [];
        const appended = [];
        let counted = 0;
        const store = {
            getQueue: async () => (removed ? [] : [{ ...job }]),
            holdsLock: async () => true,
            getCursor: async () => cursor,
            setCursor: async (id, c) => { cursor = c; },
            bumpSkipped: async (id) => { bumps.push(id); },
            renewLock: async () => {},
            removeJob: async () => { removed = true; },
            removeIfDrained: async () => { removed = true; return true; },
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            api: { ignore: async (appid) => {
                posts.push(appid);
                return appid === '480'
                    ? { ok: false, rateLimited: false, unavailable: true }
                    : { ok: true };
            } },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            bumpCount: async () => { counted++; },
            log: {
                append: async (entry) => { appended.push(entry); },
                markUndone: async () => {},
                wasReIgnoredAfter: async () => false,
            },
            ownerId: 't1',
        });
        await d._drainJob(job);
        expect(posts).toEqual(['480', '11']);  // exactly one attempt each
        expect(cursor).toBe(2);
        expect(removed).toBe(true);
        expect(bumps).toEqual(['j1']);
        expect(appended).toEqual([
            { appid: '480', source: 'curator', curatorId: 'c1', skipped: 'unavailable' },
            { appid: '11', source: 'curator', curatorId: 'c1' },
        ]);
        expect(counted).toBe(1);               // only the appid that was ignored
    });

    test('undo job: a classified region-lock skips with no log write (nothing was rolled back)', async () => {
        const Drainer = loadDrainerClass();
        const job = {
            id: 'ju', curatorId: 'undo', type: 'undo',
            status: 'pending', appids: ['480'], snapshotTs: 500,
        };
        let cursor = 0;
        let removed = false;
        let undoFailed = 0;
        const bumps = [];
        const marked = [];
        const appended = [];
        const store = {
            getQueue: async () => (removed ? [] : [{ ...job }]),
            holdsLock: async () => true,
            getCursor: async () => cursor,
            setCursor: async (id, c) => { cursor = c; },
            bumpSkipped: async (id) => { bumps.push(id); },
            signalUnignored: async () => { throw new Error('undo must not un-badge a skipped game'); },
            signalUndoFailed: async () => { undoFailed += 1; },
            renewLock: async () => {},
            removeJob: async () => { removed = true; },
            removeIfDrained: async () => { removed = true; return true; },
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            api: {
                ignore: async () => ({ ok: true }),
                unignore: async () => ({ ok: false, rateLimited: false, unavailable: true }),
            },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(['480']),
            dropCount: async () => { throw new Error('a refused rollback must not move the total'); },
            log: {
                append: async (entry) => { appended.push(entry); },
                markUndone: async (appid, ts) => { marked.push([appid, ts]); },
                wasReIgnoredAfter: async () => false,
            },
            ownerId: 't1',
        });
        await d._drainJob(job);
        expect(cursor).toBe(1);
        expect(removed).toBe(true);
        expect(bumps).toEqual(['ju']);
        expect(appended).toEqual([]);  // the appid is still ignored…
        expect(marked).toEqual([]);    // …so its log entries stay live
        // …and the page is already truthful (the badge says "ignored", which it
        // is), so nothing is un-badged — but the rollback the user asked for
        // silently didn't happen, and that gets reported.
        expect(undoFailed).toBe(1);
    });

    test('undo job: a rollback that fails every retry is reported too (MAX_FAILS)', async () => {
        // The other way a remove POST gives up: not a classified region lock,
        // just three refusals on a live session. Same correction — the game
        // stays ignored and the user is told the undo fell short.
        const Drainer = loadDrainerClass();
        const job = {
            id: 'ju', curatorId: 'undo', type: 'undo',
            status: 'pending', appids: ['1'], snapshotTs: 500,
        };
        let cursor = 0;
        let removed = false;
        let undoFailed = 0;
        const posts = [];
        const d = new Drainer({
            store: {
                getQueue: async () => (removed ? [] : [{ ...job }]),
                holdsLock: async () => true,
                getCursor: async () => cursor,
                setCursor: async (id, c) => { cursor = c; },
                bumpSkipped: async () => {},
                signalUndoFailed: async () => { undoFailed += 1; },
                renewLock: async () => {},
                removeIfDrained: async () => { removed = true; return true; },
                signalCompleted: async () => {},
            },
            api: {
                ignore: async () => ({ ok: true }),
                unignore: async (appid) => { posts.push(appid); return { ok: false }; },
            },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(['1']),
            probeLogin: async () => true,     // the session is fine — a per-appid refusal
            log: {
                // Neither hook may fire: the entry has to stay LIVE (not undone,
                // not `skipped`) so the next "undo the last N" retries it — that
                // self-healing is why a failed rollback needs no other record.
                append: async () => { throw new Error('a failed rollback must not be logged as skipped'); },
                markUndone: async () => { throw new Error('a failed rollback must not mark the log'); },
                wasReIgnoredAfter: async () => false,
            },
            ownerId: 't1',
            standbyMs: 0,
        });
        await d._drainJob(job);
        expect(posts).toEqual(['1', '1', '1']);   // 3 tries, then stepped over
        expect(cursor).toBe(1);
        expect(undoFailed).toBe(1);
    });

    test('an ignore that fails every retry leaves a durable log entry (MAX_FAILS)', async () => {
        // The per-job skipped counter dies with the job and the push card needs
        // a listening tab (the SW route has none), so the log entry is the only
        // trace this drop path leaves. Same shape as the region-lock skip, with
        // `skipped:'failed'` — inert for every undo selector, and no extra
        // volume: an appid that had landed would have been appended anyway.
        const Drainer = loadDrainerClass();
        const job = {
            id: 'job_mi', curatorId: 'mi', type: 'mi', status: 'pending',
            appids: ['1', '2'], meta: { 1: { name: 'Foo', reason: 2 } },
        };
        let cursor = 0;
        let removed = false;
        const posts = [];
        const appended = [];
        const unbadged = [];
        const d = new Drainer({
            store: {
                getQueue: async () => (removed ? [] : [{ ...job }]),
                holdsLock: async () => true,
                getCursor: async () => cursor,
                setCursor: async (id, c) => { cursor = c; },
                bumpSkipped: async () => {},
                signalUnignored: async (appid, reason) => { unbadged.push([appid, reason]); },
                renewLock: async () => {},
                removeIfDrained: async () => { removed = true; return true; },
                signalCompleted: async () => {},
            },
            api: { ignore: async (appid, reason) => {
                posts.push([appid, reason]);
                return appid === '1' ? { ok: false } : { ok: true };
            } },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            probeLogin: async () => true,     // the session is fine — a per-appid refusal
            log: { append: async (e) => { appended.push(e); }, markUndone: async () => {} },
            ownerId: 't1',
            standbyMs: 0,
        });
        await d._drainJob(job);
        expect(posts).toEqual([['1', 2], ['1', 2], ['1', 2], ['2', 0]]);  // 3 tries, then on
        expect(cursor).toBe(2);
        // The dropped entry carries the name resolved at swipe time, so a future
        // surface can name it; the one that landed logs normally.
        expect(appended).toEqual([
            { appid: '1', name: 'Foo', source: 'mi', skipped: 'failed' },
            { appid: '2', name: '', source: 'mi' },
        ]);
        expect(unbadged).toEqual([['1', 'failed']]);   // the optimistic badge still goes
    });

    test('undo job: inverse dedupe, remove=1 POSTs, log marked undone, total comes back down', async () => {
        // '2' is not in rgIgnoredApps (already rolled back elsewhere) → skipped
        // with no request BUT still marked undone (so it can't inflate "of N"
        // forever); '1' and '3' get un-ignore POSTs and their log entries
        // marked. The finished job is dropped like any other.
        // dropCount follows the POST, not the entry: the two rollbacks that
        // landed come off the popup's total, the skip (which rolled nothing
        // back — it was already un-ignored, and paid its decrement then) does
        // not. bumpCount is never touched on this path in either direction.
        const Drainer = loadDrainerClass();
        const job = {
            id: 'ju', curatorId: 'undo', type: 'undo',
            status: 'pending', appids: ['1', '2', '3'], snapshotTs: 500,
        };
        let cursor = 0;
        let removed = false;
        const unposts = [];
        const posts = [];
        const marked = [];
        let counted = 0;
        let uncounted = 0;
        const store = {
            getQueue: async () => (removed ? [] : [{ ...job }]),
            holdsLock: async () => true,
            getCursor: async () => cursor,
            setCursor: async (id, c) => { cursor = c; },
            renewLock: async () => {},
            removeJob: async () => { removed = true; },
            removeIfDrained: async () => { removed = true; return true; },
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            api: {
                ignore: async (appid) => { posts.push(appid); return { ok: true }; },
                unignore: async (appid) => { unposts.push(appid); return { ok: true }; },
            },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(['1', '3']), // '2' is NOT ignored
            bumpCount: async () => { counted++; },
            dropCount: async () => { uncounted++; },
            log: {
                append: async () => {},
                markUndone: async (appid, ts) => { marked.push([appid, ts]); },
                wasReIgnoredAfter: async () => false,
                lastIgnoredAt: async () => 0, // '2' ignored long ago → skip is trustworthy
            },
            ownerId: 't1',
        });
        await d._drainJob(job);
        expect(posts).toEqual([]);              // an undo job never fires ignores
        expect(unposts).toEqual(['1', '3']);
        expect(marked).toEqual([['1', 500], ['2', 500], ['3', 500]]);
        expect(uncounted).toBe(2);              // one per landed remove=1, not per entry
        expect(counted).toBe(0);
        expect(cursor).toBe(3);
        expect(removed).toBe(true);
    });

    test('undo job: a failed userdata read stops the pass instead of skip-burning the job', async () => {
        // The inverse dedupe reads "not in the set" as "already rolled back" —
        // so an undo job must never fall back to an empty set on a failed
        // fetch (a curator job safely does): the whole job would burn to
        // completion via skips with zero requests. Strict read → 'stop'.
        const Drainer = loadDrainerClass();
        const job = {
            id: 'ju', curatorId: 'undo', type: 'undo',
            status: 'pending', appids: ['1', '2'], snapshotTs: 500,
        };
        let cursor = 0;
        let removed = false;
        const unposts = [];
        const marked = [];
        const store = {
            getQueue: async () => (removed ? [] : [{ ...job }]),
            holdsLock: async () => true,
            getCursor: async () => cursor,
            setCursor: async (id, c) => { cursor = c; },
            renewLock: async () => {},
            removeJob: async () => { removed = true; },
            removeIfDrained: async () => { removed = true; return true; },
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            api: {
                ignore: async () => ({ ok: true }),
                unignore: async (appid) => { unposts.push(appid); return { ok: true }; },
            },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => null,   // strict read failed
            log: {
                append: async () => {},
                markUndone: async (appid, ts) => { marked.push([appid, ts]); },
                wasReIgnoredAfter: async () => false,
            },
            ownerId: 't1',
        });
        expect(await d._drainJob(job)).toBe('stop');
        expect(unposts).toEqual([]);
        expect(marked).toEqual([]);
        expect(cursor).toBe(0);        // nothing burned — retried on the next kick
        expect(removed).toBe(false);
    });

    test('undo job: an EMPTY userdata set needs a live login probe (dead session → stop)', async () => {
        // A logged-out userdata read returns 200 + empty defaults — identical
        // to "the user manually rolled back everything". The skip path never
        // consults the gate's dead-session check, so the drainer must confirm
        // the session itself: probe false → stop (job intact); probe true →
        // the legit-empty job completes via marked skips.
        const Drainer = loadDrainerClass();
        const makeJob = () => ({
            id: 'ju', curatorId: 'undo', type: 'undo',
            status: 'pending', appids: ['1'], snapshotTs: 500,
        });
        const makeDeps = (probeResult, state) => ({
            store: {
                getQueue: async () => (state.removed ? [] : [makeJob()]),
                holdsLock: async () => true,
                getCursor: async () => state.cursor,
                setCursor: async (id, c) => { state.cursor = c; },
                renewLock: async () => {},
                removeJob: async () => { state.removed = true; },
                removeIfDrained: async () => { state.removed = true; return true; },
                signalCompleted: async () => {},
            },
            api: {
                ignore: async () => ({ ok: true }),
                unignore: async () => ({ ok: true }),
            },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),   // empty, NOT failed
            probeLogin: async () => probeResult,
            log: {
                append: async () => {},
                markUndone: async (appid, ts) => { state.marked.push([appid, ts]); },
                wasReIgnoredAfter: async () => false,
                lastIgnoredAt: async () => 0, // ignored long ago → the empty-set skip is trustworthy
            },
            ownerId: 't1',
        });

        const dead = { cursor: 0, removed: false, marked: [] };
        const d1 = new Drainer(makeDeps(false, dead));
        expect(await d1._drainJob(makeJob())).toBe('stop');
        expect(dead.cursor).toBe(0);
        expect(dead.removed).toBe(false);
        expect(dead.marked).toEqual([]);

        const alive = { cursor: 0, removed: false, marked: [] };
        const d2 = new Drainer(makeDeps(true, alive));
        await d2._drainJob(makeJob());
        expect(alive.cursor).toBe(1);
        expect(alive.removed).toBe(true);
        expect(alive.marked).toEqual([['1', 500]]);
    });

    test('undo job: an appid re-ignored after the snapshot is skipped, not un-ignored', async () => {
        // "Last user intent wins": the user re-ignored '1' after staging the
        // undo — no POST, no markUndone, cursor still advances past it.
        const Drainer = loadDrainerClass();
        const job = {
            id: 'ju', curatorId: 'undo', type: 'undo',
            status: 'pending', appids: ['1'], snapshotTs: 500,
        };
        let cursor = 0;
        let removed = false;
        const unposts = [];
        const marked = [];
        const store = {
            getQueue: async () => (removed ? [] : [{ ...job }]),
            holdsLock: async () => true,
            getCursor: async () => cursor,
            setCursor: async (id, c) => { cursor = c; },
            renewLock: async () => {},
            removeJob: async () => { removed = true; },
            removeIfDrained: async () => { removed = true; return true; },
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            api: {
                ignore: async () => ({ ok: true }),
                unignore: async (appid) => { unposts.push(appid); return { ok: true }; },
            },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(['1']),
            log: {
                append: async () => {},
                markUndone: async (appid, ts) => { marked.push([appid, ts]); },
                wasReIgnoredAfter: async (appid, ts) => appid === '1' && ts === 500,
            },
            ownerId: 't1',
        });
        await d._drainJob(job);
        expect(unposts).toEqual([]);
        expect(marked).toEqual([]);
        expect(cursor).toBe(1);
        expect(removed).toBe(true);
    });

    test('undo job: a freshly-ignored appid missing from userdata is un-ignored, not skip-marked', async () => {
        // rgIgnoredApps lags the ignore POST: '1' was ignored moments ago (log
        // ts ≈ now) but isn't in the set yet. Trusting the inverse-dedupe skip
        // would markUndone it with no remove POST — stranding it ignored and
        // burning its log entry out of the undoable pool. The fresh-log guard
        // refuses the skip and fires remove=1 instead (idempotent).
        const now = 1000000;
        const Drainer = loadDrainerClass({ now: () => now });
        const job = {
            id: 'ju', curatorId: 'undo', type: 'undo',
            status: 'pending', appids: ['1'], snapshotTs: now,
        };
        let cursor = 0;
        let removed = false;
        const unposts = [];
        const marked = [];
        const store = {
            getQueue: async () => (removed ? [] : [{ ...job }]),
            holdsLock: async () => true,
            getCursor: async () => cursor,
            setCursor: async (id, c) => { cursor = c; },
            renewLock: async () => {},
            removeJob: async () => { removed = true; },
            removeIfDrained: async () => { removed = true; return true; },
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            api: {
                ignore: async () => ({ ok: true }),
                unignore: async (appid) => { unposts.push(appid); return { ok: true }; },
            },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),   // '1' not reflected yet
            probeLogin: async () => true,           // empty set + live session → proceed
            log: {
                append: async () => {},
                markUndone: async (appid, ts) => { marked.push([appid, ts]); },
                wasReIgnoredAfter: async () => false,
                lastIgnoredAt: async () => now - 2000, // ignored 2 s ago — inside UNDO_FRESH_MS
            },
            ownerId: 't1',
        });
        await d._drainJob(job);
        expect(unposts).toEqual(['1']);          // remove=1 fired despite the empty set
        expect(marked).toEqual([['1', now]]);    // marked undone only AFTER the confirmed POST
        expect(cursor).toBe(1);
        expect(removed).toBe(true);
    });

    test('curator job: every confirmed ignore lands in the undo log and in the total, never in the history', async () => {
        // The curator path has no name to show and arrives in job-sized batches:
        // it counts (bumpCount → ilap_ignored_count) but must never reach
        // saveStats, whose 20-entry history belongs to hand-made swipes.
        const Drainer = loadDrainerClass();
        const job = { id: 'j1', curatorId: 'c9', status: 'pending', appids: ['7', '8'] };
        let cursor = 0;
        let removed = false;
        let counted = 0;
        const stats = [];
        const appended = [];
        const store = {
            getQueue: async () => (removed ? [] : [{ ...job }]),
            holdsLock: async () => true,
            getCursor: async () => cursor,
            setCursor: async (id, c) => { cursor = c; },
            renewLock: async () => {},
            removeJob: async () => { removed = true; },
            removeIfDrained: async () => { removed = true; return true; },
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            api: { ignore: async () => ({ ok: true }), unignore: async () => ({ ok: true }) },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            saveStats: async (name, reason) => { stats.push([name, reason]); },
            bumpCount: async () => { counted++; },
            log: {
                append: async (entry) => { appended.push(entry); },
                markUndone: async () => {},
                wasReIgnoredAfter: async () => false,
            },
            ownerId: 't1',
        });
        await d._drainJob(job);
        expect(appended).toEqual([
            { appid: '7', source: 'curator', curatorId: 'c9' },
            { appid: '8', source: 'curator', curatorId: 'c9' },
        ]);
        expect(counted).toBe(2);
        expect(stats).toEqual([]);   // Last Ignored stays a manual-swipe surface
    });

    test('MI job: drains each entry with its own reason, stamps Last Ignored, logs source:mi', async () => {
        // A swipe defers into a type:'mi' job carrying per-appid name + reason.
        // At drain the POST must use that reason (0 default / 2 played-elsewhere),
        // saveStats must stamp Last Ignored (gated strictly to MI), and the undo
        // log entry carries the name + source:'mi'. bumpCount is the curator-only
        // counterpart: saveStats already increments the same total, so MI going
        // through both would count every swipe twice.
        const Drainer = loadDrainerClass();
        const job = {
            id: 'job_mi', curatorId: 'mi', type: 'mi', status: 'pending',
            appids: ['10', '11'],
            meta: { 10: { name: 'A', reason: 0 }, 11: { name: 'B', reason: 2 } },
        };
        let cursor = 0;
        let removed = false;
        let counted = 0;
        const posts = [];      // [appid, reason]
        const stats = [];      // [name, reason]
        const appended = [];
        const store = {
            getQueue: async () => (removed ? [] : [{ ...job }]),
            holdsLock: async () => true,
            getCursor: async () => cursor,
            setCursor: async (id, c) => { cursor = c; },
            renewLock: async () => {},
            removeJob: async () => { removed = true; },
            removeIfDrained: async () => { removed = true; return true; },
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            api: { ignore: async (appid, reason) => { posts.push([appid, reason]); return { ok: true }; } },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            saveStats: async (name, reason) => { stats.push([name, reason]); },
            bumpCount: async () => { counted++; },
            log: {
                append: async (entry) => { appended.push(entry); },
                markUndone: async () => {},
                wasReIgnoredAfter: async () => false,
            },
            ownerId: 't1',
        });
        await d._drainJob(job);
        expect(posts).toEqual([['10', 0], ['11', 2]]);   // per-appid reason preserved
        expect(stats).toEqual([['A', 0], ['B', 2]]);     // Last Ignored stamped at drain time
        expect(counted).toBe(0);                         // saveStats already counted these
        expect(appended).toEqual([
            { appid: '10', name: 'A', source: 'mi' },
            { appid: '11', name: 'B', source: 'mi' },
        ]);
        expect(cursor).toBe(2);
        expect(removed).toBe(true);
    });

    test('MI job: a cancelled entry is stepped over — no POST, no stats, no log', async () => {
        // Immediate regret: the un-ignore gesture reached the entry before the
        // drain did, so the ignore must never happen at all. Nothing to report
        // either — the gesture already un-badged it, and an ignore that never
        // landed has nothing to count or roll back.
        const Drainer = loadDrainerClass();
        const job = {
            id: 'job_mi', curatorId: 'mi', type: 'mi', status: 'pending',
            appids: ['10', '11'],
            meta: { 10: { name: 'A', reason: 0, cancelled: true }, 11: { name: 'B', reason: 2 } },
        };
        let cursor = 0;
        let removed = false;
        const posts = [];
        const stats = [];
        const appended = [];
        const unbadged = [];
        const d = new Drainer({
            store: {
                getQueue: async () => (removed ? [] : [{ ...job }]),
                holdsLock: async () => true,
                getCursor: async () => cursor,
                setCursor: async (id, c) => { cursor = c; },
                renewLock: async () => {},
                removeIfDrained: async () => { removed = true; return true; },
                signalCompleted: async () => {},
                signalUnignored: async (appid, reason) => { unbadged.push([appid, reason]); },
            },
            api: { ignore: async (appid, reason) => { posts.push([appid, reason]); return { ok: true }; } },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            saveStats: async (name, reason) => { stats.push([name, reason]); },
            log: {
                append: async (entry) => { appended.push(entry); },
                markUndone: async () => {},
                wasReIgnoredAfter: async () => false,
            },
            ownerId: 't1',
        });
        await d._drainJob(job);
        expect(posts).toEqual([['11', 2]]);              // only the live entry
        expect(stats).toEqual([['B', 2]]);
        expect(appended).toEqual([{ appid: '11', name: 'B', source: 'mi' }]);
        expect(unbadged).toEqual([]);                    // nothing to correct
        expect(cursor).toBe(2);                          // stepped over, not stuck
    });

    test('MI job: a cancel landing DURING the gate wait still stops the POST', async () => {
        // The race the cancel path exists for. The pre-gate snapshot shows the
        // entry live; the mark is written while reserve() paces. Re-reading the
        // job after the wait — which the drainer already does for status — is
        // what keeps the ignore from going out behind the user's back.
        const Drainer = loadDrainerClass();
        let cancelled = false;
        let cursor = 0;
        let removed = false;
        const posts = [];
        const d = new Drainer({
            store: {
                getQueue: async () => (removed ? [] : [{
                    id: 'job_mi', curatorId: 'mi', type: 'mi', status: 'pending',
                    appids: ['10'],
                    meta: { 10: { name: 'A', reason: 0, cancelled } },
                }]),
                holdsLock: async () => true,
                getCursor: async () => cursor,
                setCursor: async (id, c) => { cursor = c; },
                renewLock: async () => {},
                removeIfDrained: async () => { removed = true; return true; },
                signalCompleted: async () => {},
            },
            api: { ignore: async (appid, reason) => { posts.push([appid, reason]); return { ok: true }; } },
            // The gesture lands while this reservation is being paced.
            gate: { reserve: async () => { cancelled = true; return { ok: true }; } },
            fetchUserdata: async () => new Set(),
            saveStats: async () => {},
            log: { append: async () => {}, markUndone: async () => {}, wasReIgnoredAfter: async () => false },
            ownerId: 't1',
        });
        await d._drainJob({ id: 'job_mi', curatorId: 'mi', type: 'mi', status: 'pending' });
        expect(posts).toEqual([]);
        expect(cursor).toBe(1);
    });

    test('MI job: a cancel landing while the POST is IN FLIGHT is compensated', async () => {
        // The window the cursor cannot describe. cancelMiEntry answers "still
        // pending?" from the cursor, and the cursor only advances once the POST
        // has RETURNED — so a gesture arriving mid-request is told it cancelled an
        // ignore that was already sent, and the tab drops the badge for a game
        // Steam is about to ignore. Every check the drainer makes before the POST
        // is too early to catch it, so the correction comes after: a real rollback,
        // because the ignore genuinely landed and stays counted and logged.
        const Drainer = loadDrainerClass();
        let cancelled = false;
        let cursor = 0;
        let removed = false;
        const posts = [];
        const rollbacks = [];
        const d = new Drainer({
            store: {
                getQueue: async () => (removed ? [] : [{
                    id: 'job_mi', curatorId: 'mi', type: 'mi', status: 'pending',
                    appids: ['10'],
                    meta: { 10: { name: 'A', reason: 0, cancelled } },
                }]),
                holdsLock: async () => true,
                getCursor: async () => cursor,
                setCursor: async (id, c) => { cursor = c; },
                renewLock: async () => {},
                removeIfDrained: async () => { removed = true; return true; },
                signalCompleted: async () => {},
                enqueueMiUndo: async (entry) => { rollbacks.push(entry.appid); return { kind: 'added' }; },
            },
            // The gesture lands while THIS request is in flight.
            api: {
                ignore: async (appid, reason) => {
                    posts.push([appid, reason]);
                    cancelled = true;
                    return { ok: true };
                },
            },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            saveStats: async () => {},
            log: { append: async () => {}, markUndone: async () => {}, wasReIgnoredAfter: async () => false },
            ownerId: 't1',
        });
        await d._drainJob({ id: 'job_mi', curatorId: 'mi', type: 'mi', status: 'pending' });
        expect(posts).toEqual([['10', 0]]);   // nothing could stop it — it was already sent
        expect(rollbacks).toEqual(['10']);    // …so it is undone instead of left standing
        expect(cursor).toBe(1);
    });

    test('MI job: a swipe appended in the completion window is drained, not wiped', async () => {
        // The race removeIfDrained closes: the drainer's loop-top snapshot shows
        // the MI job fully drained (cursor at the end), but a swipe appended a new
        // appid before the removal commits. removeIfDrained re-checks against the
        // fresh queue, reports the job grew (false), and the drainer loops back to
        // drain the new entry instead of wiping it (a lost ignore + a lying badge).
        const Drainer = loadDrainerClass();
        const meta = { 10: { name: 'A', reason: 0 }, 11: { name: 'B', reason: 0 } };
        let appids = ['10'];
        let cursor = 0;
        let removed = false;
        let grewOnce = false;
        const posts = [];
        const store = {
            getQueue: async () => (removed ? [] : [{
                id: 'job_mi', curatorId: 'mi', type: 'mi', status: 'pending',
                appids: appids.slice(), meta,
            }]),
            holdsLock: async () => true,
            getCursor: async () => cursor,
            setCursor: async (id, c) => { cursor = c; },
            renewLock: async () => {},
            signalCompleted: async () => {},
            removeJob: async () => { removed = true; },
            removeIfDrained: async () => {
                // First completion attempt: model a swipe that appended '11' in the
                // window → the job is no longer drained, so keep it.
                if (!grewOnce) { grewOnce = true; appids = ['10', '11']; return false; }
                removed = true; return true;
            },
        };
        const d = new Drainer({
            store,
            api: { ignore: async (appid) => { posts.push(appid); return { ok: true }; } },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            saveStats: async () => {},
            log: { append: async () => {}, markUndone: async () => {}, wasReIgnoredAfter: async () => false },
            ownerId: 't1',
        });
        await d._drainJob({ id: 'job_mi', curatorId: 'mi', type: 'mi', status: 'pending', appids: ['10'], meta });
        expect(posts).toEqual(['10', '11']); // the appended swipe was drained, not lost
        expect(removed).toBe(true);          // and the job still completed afterwards
    });

    test('MI job: a permanent skip clears the optimistic on-page badge (signalUnignored)', async () => {
        // An MI swipe badges optimistically at swipe time; if its deferred POST is
        // permanently refused (region lock), the game was never ignored, so the
        // drainer must pulse signalUnignored to drop the lying badge as it skips —
        // and only for the refused game, not the one that ignored fine.
        const Drainer = loadDrainerClass();
        const job = {
            id: 'job_mi', curatorId: 'mi', type: 'mi', status: 'pending',
            appids: ['480', '11'],
            meta: { 480: { name: 'A', reason: 0 }, 11: { name: 'B', reason: 0 } },
        };
        let cursor = 0;
        let removed = false;
        const unbadged = [];
        const store = {
            getQueue: async () => (removed ? [] : [{ ...job }]),
            holdsLock: async () => true,
            getCursor: async () => cursor,
            setCursor: async (id, c) => { cursor = c; },
            bumpSkipped: async () => {},
            signalUnignored: async (appid, reason) => { unbadged.push([appid, reason]); },
            renewLock: async () => {},
            removeJob: async () => { removed = true; },
            removeIfDrained: async () => { removed = true; return true; },
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            api: { ignore: async (appid) => appid === '480'
                ? { ok: false, rateLimited: false, unavailable: true }
                : { ok: true } },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            saveStats: async () => {},
            log: { append: async () => {}, markUndone: async () => {}, wasReIgnoredAfter: async () => false },
            ownerId: 't1',
        });
        await d._drainJob(job);
        // Only the refused MI game is un-badged — tagged 'failed' so the tab
        // that swiped it can say the ignore never landed, instead of the badge
        // just evaporating.
        expect(unbadged).toEqual([['480', 'failed']]);
        expect(cursor).toBe(2);              // both entries stepped over
    });

    test('a gate stop ends the pass before the lease AND before the userdata read', async () => {
        // The tab half of the contract the SW unit covers from its own side:
        // the gate refuses every slot while the master toggle is off or the
        // session is dead, but that verdict used to land only inside _drainJob —
        // after a lease was taken and a userdata GET spent, once per tab per
        // standby tick, forever. drain() now asks the same verdict up front.
        const Drainer = loadDrainerClass();
        const locks = [];
        let userdataReads = 0;
        let verdict = 'disabled';
        let cursor = 0;
        let removed = false;
        const posts = [];
        const d = new Drainer({
            store: {
                getQueue: async () => (removed
                    ? []
                    : [{ id: 'j1', curatorId: 'c1', status: 'pending', appids: ['10'] }]),
                acquireLock: async (curatorId) => { locks.push(curatorId); return true; },
                releaseLock: async () => {},
                holdsLock: async () => true,
                getCursor: async () => cursor,
                setCursor: async (id, c) => { cursor = c; },
                renewLock: async () => {},
                removeIfDrained: async () => { removed = true; return true; },
                signalCompleted: async () => {},
            },
            api: { ignore: async (appid) => { posts.push(appid); return { ok: true }; } },
            gate: { reserve: async () => ({ ok: true }), stopped: async () => verdict },
            fetchUserdata: async () => { userdataReads += 1; return new Set(); },
            ownerId: 't1',
            standbyMs: 0,
        });

        await d.drain();
        expect(locks).toEqual([]);       // no lease claimed…
        expect(userdataReads).toBe(0);   // …and no network read behind it
        expect(posts).toEqual([]);

        verdict = null;                  // master re-enabled / logged back in
        await d.drain();
        expect(locks).toEqual(['c1']);
        expect(userdataReads).toBe(1);
        expect(posts).toEqual(['10']);
    });

    test('a failed POST blamed on the session stops the pass and parks the drainer', async () => {
        // The half-dead session: cookies present (so gate.reserve() keeps
        // granting slots) but Steam no longer accepts them, and appdetails says
        // the appid IS available (so the region-lock classifier stays out of it).
        // Every POST fails. Without the login probe MAX_FAILS would walk the
        // whole job — three burnt slots per appid — and finish it as a silent
        // "done" having ignored nothing.
        let now = 0;
        const Drainer = loadDrainerClass({ now: () => now });
        let cursor = 0;
        let loggedIn = false;
        let probes = 0;
        let removed = false;
        const posts = [];
        const d = new Drainer({
            store: {
                getQueue: async () => (removed
                    ? []
                    : [{ id: 'j1', curatorId: 'c1', status: 'pending', appids: ['10', '20'] }]),
                acquireLock: async () => true,
                releaseLock: async () => {},
                holdsLock: async () => true,
                getCursor: async () => cursor,
                setCursor: async (id, c) => { cursor = c; },
                renewLock: async () => {},
                removeIfDrained: async () => { removed = true; return true; },
                signalCompleted: async () => {},
            },
            // The session is what fails — so the POST starts working again at
            // the same moment the probe starts answering "logged in".
            api: { ignore: async (appid) => { posts.push(appid); return { ok: loggedIn }; } },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            probeLogin: async () => { probes += 1; return loggedIn; },
            ownerId: 't1',
            standbyMs: 0,
        });

        await d.drain();
        expect(posts).toEqual(['10']);   // ONE attempt, not MAX_FAILS worth
        expect(probes).toBe(1);
        expect(cursor).toBe(0);          // nothing was skipped — the job is intact

        // Parked: the standby tick must not turn a dead session into a retry
        // loop against Steam.
        await d.drain();
        expect(posts).toEqual(['10']);

        // …and it resumes on its own once the park expires and the session is back.
        now += 60000;
        loggedIn = true;
        await d.drain();
        expect(posts).toEqual(['10', '10', '20']);   // retried, then moved on
        expect(cursor).toBe(2);
    });

    test('a failed POST with the session alive still burns MAX_FAILS and skips', async () => {
        // The probe must not become a blanket "never skip": a genuine per-appid
        // rejection on a live session keeps the old give-up-after-3 behaviour,
        // so one bad game can't wedge the job forever.
        const Drainer = loadDrainerClass();
        let cursor = 0;
        const posts = [];
        const d = new Drainer({
            store: {
                getQueue: async () => [
                    { id: 'j1', curatorId: 'c1', status: 'pending', appids: ['10', '20'] }],
                holdsLock: async () => true,
                getCursor: async () => cursor,
                setCursor: async (id, c) => { cursor = c; },
                renewLock: async () => {},
                removeIfDrained: async () => true,
                signalCompleted: async () => {},
            },
            api: {
                ignore: async (appid) => {
                    posts.push(appid);
                    return appid === '10' ? { ok: false } : { ok: true };
                }
            },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            probeLogin: async () => true,          // session is fine
            ownerId: 't1',
            standbyMs: 0,
        });
        await d._drainJob({ id: 'j1', curatorId: 'c1', status: 'pending', appids: ['10', '20'] });
        expect(posts).toEqual(['10', '10', '10', '20']);   // 3 tries, then skipped
        expect(cursor).toBe(2);
    });

    test('miundo job: POSTs remove=1 with the INVERSE dedupe and marks the log undone', async () => {
        // The solo un-ignore gesture's twin job. It must inherit the undo pass
        // policy wholesale — direction comes from job.type, not from the entry —
        // while staying a separate job so MI keeps its lenient userdata path.
        const Drainer = loadDrainerClass();
        const job = {
            id: 'job_mi_undo', curatorId: 'miundo', type: 'miundo', status: 'pending',
            appids: ['1', '2'], meta: { 1: { ts: 900 }, 2: { ts: 950 } },
        };
        let cursor = 0;
        let removed = false;
        const unignored = [];
        const ignoredPosts = [];
        const marked = [];
        const badgesCleared = [];
        const d = new Drainer({
            store: {
                getQueue: async () => (removed ? [] : [{ ...job }]),
                holdsLock: async () => true,
                getCursor: async () => cursor,
                setCursor: async (id, c) => { cursor = c; },
                bumpSkipped: async () => {},
                signalUnignored: async (appid) => { badgesCleared.push(appid); },
                renewLock: async () => {},
                removeIfDrained: async () => { removed = true; return true; },
                signalCompleted: async () => {},
            },
            api: {
                ignore: async (appid) => { ignoredPosts.push(appid); return { ok: true }; },
                unignore: async (appid) => { unignored.push(appid); return { ok: true }; },
            },
            gate: { reserve: async () => ({ ok: true }) },
            // '2' is already NOT ignored → the inverse dedupe skips it with no POST.
            fetchUserdata: async () => new Set(['1']),
            log: {
                append: async () => { throw new Error('a rollback is not an ignore'); },
                markUndone: async (appid, ts) => { marked.push([appid, ts]); },
                lastIgnoredAt: async () => 0,      // old ignore → the skip is trusted
                wasReIgnoredAfter: async () => false,
            },
            ownerId: 't1',
            standbyMs: 0,
        });
        await d._drainJob(job);
        expect(ignoredPosts).toEqual([]);       // never the ignore endpoint
        expect(unignored).toEqual(['1']);       // only the still-ignored appid
        expect(cursor).toBe(2);
        expect(removed).toBe(true);
        // Each entry's own gesture time is the "last user intent wins" boundary,
        // NOT one job-level snapshot: this job auto-fills, so a shared ts would be
        // the moment the first gesture created it.
        expect(marked).toEqual([['1', 900], ['2', 950]]);
        // The confirmed rollback clears the on-page badge, exactly like a droplist
        // undo — same pulse, so the gesture needed no new protocol.
        expect(badgesCleared).toEqual(['1']);
    });

    test('miundo job: a refused rollback reports it (the pending badge mark comes off)', async () => {
        const Drainer = loadDrainerClass();
        const job = {
            id: 'job_mi_undo', curatorId: 'miundo', type: 'miundo', status: 'pending',
            appids: ['1'], meta: { 1: { ts: 900 } },
        };
        let cursor = 0;
        let removed = false;
        let undoFailed = 0;
        const d = new Drainer({
            store: {
                getQueue: async () => (removed ? [] : [{ ...job }]),
                holdsLock: async () => true,
                getCursor: async () => cursor,
                setCursor: async (id, c) => { cursor = c; },
                bumpSkipped: async () => {},
                signalUnignored: async () => { throw new Error('a refused rollback un-badges nothing'); },
                signalUndoFailed: async () => { undoFailed += 1; },
                renewLock: async () => {},
                removeIfDrained: async () => { removed = true; return true; },
                signalCompleted: async () => {},
            },
            api: {
                ignore: async () => ({ ok: true }),
                unignore: async () => ({ ok: false, rateLimited: false, unavailable: true }),
            },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(['1']),
            log: {
                append: async () => { throw new Error('nothing was rolled back to log'); },
                markUndone: async () => { throw new Error('a refused rollback must not mark the log'); },
                lastIgnoredAt: async () => 0,
                wasReIgnoredAfter: async () => false,
            },
            ownerId: 't1',
            standbyMs: 0,
        });
        await d._drainJob(job);
        expect(cursor).toBe(1);
        expect(undoFailed).toBe(1);
    });

    test('miundo job: a failed userdata read stops the pass (it inherits undo strictness)', async () => {
        // The inverse dedupe reads "absent from the set" as "already rolled back",
        // so a failed read would skip-burn the whole job with zero requests.
        const Drainer = loadDrainerClass();
        const job = {
            id: 'job_mi_undo', curatorId: 'miundo', type: 'miundo',
            status: 'pending', appids: ['1'], meta: { 1: { ts: 900 } },
        };
        let cursor = 0;
        const d = new Drainer({
            store: {
                getQueue: async () => [{ ...job }],
                holdsLock: async () => true,
                getCursor: async () => cursor,
                setCursor: async (id, c) => { cursor = c; },
                renewLock: async () => {},
                removeIfDrained: async () => { throw new Error('nothing drained — nothing to complete'); },
                signalCompleted: async () => {},
            },
            api: { ignore: async () => ({ ok: true }), unignore: async () => ({ ok: true }) },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => { throw new Error('userdata down'); },
            ownerId: 't1',
            standbyMs: 0,
        });
        expect(await d._drainJob(job)).toBe('stop');
        expect(cursor).toBe(0);
    });

    test('_pickJob prefers a drainable MI job over curator/undo work', async () => {
        const Drainer = loadDrainerClass();
        const d = new Drainer({
            store: { getCursor: async () => 0 }, api: {}, gate: {},
            fetchUserdata: async () => new Set(), ownerId: 't1',
        });
        const queue = [
            { id: 'c', curatorId: '1', status: 'pending', appids: ['1'] },
            { id: 'u', curatorId: 'undo', type: 'undo', status: 'pending', appids: ['2'] },
            { id: 'm', curatorId: 'mi', type: 'mi', status: 'pending', appids: ['3'] },
        ];
        expect((await d._pickJob(queue)).id).toBe('m');
        // With the MI job drained, the next pick falls back to document order.
        expect((await d._pickJob(queue.slice(0, 2))).id).toBe('c');
    });

    test('a job of an unknown type is skipped, and the rest of the queue still drains', async () => {
        // After a downgrade the queue can hold a type this build does not know. It
        // might be a rollback, so it is never drained as an ignore — and it must not
        // stall the jobs behind it either.
        const Drainer = loadDrainerClass();
        const d = new Drainer({
            store: { getCursor: async () => 0 }, api: {}, gate: {},
            fetchUserdata: async () => new Set(), ownerId: 't1',
        });
        const unknown = { id: 'x', curatorId: 'x', type: 'from-a-newer-build', status: 'pending', appids: ['1'] };
        const curator = { id: 'c', curatorId: '1', status: 'pending', appids: ['2'] };
        expect(await d._drainable(unknown)).toBe(false);
        expect((await d._pickJob([unknown, curator])).id).toBe('c');
        expect(await d.hasDrainableWork([unknown])).toBe(false);
    });

    test('progress comes from the cursor KEY, not the queue record', async () => {
        // The `cursor` field on a job is a legacy pre-cursor-key value that no
        // build writes any more — reading it instead of the key called every job
        // drainable for as long as it sat in the queue, whatever it had done.
        const Drainer = loadDrainerClass();
        const make = (cursors) => new Drainer({
            store: { getCursor: async (id) => cursors[id], getQueue: async () => [] },
            api: {}, gate: {}, fetchUserdata: async () => new Set(), ownerId: 't1',
        });
        const job = { id: 'j', curatorId: 'c', status: 'pending', appids: ['1', '2'] };

        expect(await make({ j: 1 })._drainable(job)).toBe(true);
        expect(await make({ j: 2 })._drainable(job)).toBe(false);   // the KEY says done…
        // …even though the record's own field would have claimed work left, and
        // vice versa: the field is consulted ONLY when the key holds nothing,
        // which is the pre-cursor-key record it exists for.
        expect(await make({})._drainable(Object.assign({}, job, { cursor: 2 }))).toBe(false);
        expect(await make({})._drainable(job)).toBe(true);
    });

    test('_pickJob: both GESTURE jobs beat background work, rollback first', async () => {
        // A solo un-ignore is as live a user action as a swipe, so it outranks
        // background curator/undo work too — and it outranks the SWIPE as well,
        // in BOTH array orders. _drainJob runs a job to its end, so sharing one
        // position-ordered bucket meant whichever job happened to sit earlier
        // drained entirely first; the rollback is the later intent by
        // construction, and the one holding a provisional mark on screen.
        const Drainer = loadDrainerClass();
        const d = new Drainer({
            // 'mu-done' is the one job whose cursor key says it has nothing left.
            store: { getCursor: async (id) => (id === 'mu-done' ? 1 : 0) },
            api: {}, gate: {},
            fetchUserdata: async () => new Set(), ownerId: 't1',
        });
        const curator = { id: 'c', curatorId: '1', status: 'pending', appids: ['1'] };
        const undo = { id: 'u', curatorId: 'undo', type: 'undo', status: 'pending', appids: ['2'] };
        const mi = { id: 'm', curatorId: 'mi', type: 'mi', status: 'pending', appids: ['3'] };
        const miundo = {
            id: 'mu', curatorId: 'miundo', type: 'miundo', status: 'pending', appids: ['4'] };
        expect((await d._pickJob([curator, undo, miundo])).id).toBe('mu');
        expect((await d._pickJob([curator, undo, miundo, mi])).id).toBe('mu');
        expect((await d._pickJob([curator, undo, mi, miundo])).id).toBe('mu');  // …position-proof
        // With no rollback queued the swipe still wins over curator/undo.
        expect((await d._pickJob([curator, undo, mi])).id).toBe('m');
        // A DRAINED rollback job is not drainable, so it cannot block the swipe.
        const done = Object.assign({}, miundo, { id: 'mu-done' });
        expect((await d._pickJob([curator, undo, done, mi])).id).toBe('m');
    });

    test('a rollback gestured mid-pass takes the drain over', async () => {
        // _pickJob's priority only settles which job a pass STARTS on, and
        // _drainJob runs its job to the end — so a solo un-ignore gestured INTO
        // a draining MI backlog used to wait the backlog out (minutes at ~0.6 s
        // a POST) with its badge dimmed the whole time. The loop-top hand-off is
        // what makes the priority mean anything for the gesture that arrives late.
        const Drainer = loadDrainerClass();
        const mi = {
            id: 'job_mi', curatorId: 'mi', type: 'mi', status: 'pending',
            appids: ['1', '2', '3'], meta: {},
        };
        const miundo = {
            id: 'job_mi_undo', curatorId: 'miundo', type: 'miundo', status: 'pending',
            appids: ['9'], meta: { 9: { ts: 1 } },
        };
        let queue = [mi];
        let cursor = 0;
        const posts = [];
        const d = new Drainer({
            store: {
                getQueue: async () => queue.map(j => Object.assign({}, j)),
                holdsLock: async () => true,
                // Per-job, because the preemption check now asks the ROLLBACK's
                // own cursor key rather than the record it rides in on.
                getCursor: async (id) => (id === 'job_mi' ? cursor : 0),
                setCursor: async (id, c) => { cursor = c; },
                renewLock: async () => {},
                removeIfDrained: async () => { throw new Error('a yielding pass finishes nothing'); },
                signalCompleted: async () => {},
            },
            api: {
                ignore: async (appid) => {
                    posts.push(appid);
                    queue = [mi, miundo];   // the gesture lands during the first POST
                    return { ok: true };
                },
                unignore: async () => ({ ok: true }),
            },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            ownerId: 't1',
            standbyMs: 0,
        });
        await d._drainJob(mi);
        expect(posts).toEqual(['1']);      // handed over instead of draining 2 and 3
        expect(cursor).toBe(1);            // …with the MI job's own progress intact
        // Hand-off, not abandonment: this is the job drain() picks next, and the
        // MI job resumes from its cursor when the rollback is done.
        expect((await d._pickJob(queue)).id).toBe('job_mi_undo');
    });

    test('_preemptedBy: no self-yield, and nothing yields to an unpickable rollback', async () => {
        const Drainer = loadDrainerClass();
        const d = new Drainer({
            store: { getCursor: async (id) => (id === 'mu-done' ? 1 : 0) },
            api: {}, gate: {},
            fetchUserdata: async () => new Set(), ownerId: 't1',
        });
        const mi = { id: 'm', curatorId: 'mi', type: 'mi', status: 'pending', appids: ['1'] };
        const curator = { id: 'c', curatorId: '1', status: 'pending', appids: ['2'] };
        const miundo = {
            id: 'mu', curatorId: 'miundo', type: 'miundo', status: 'pending', appids: ['3'] };
        expect(await d._preemptedBy([mi, miundo], mi)).toBe(true);
        expect(await d._preemptedBy([curator, miundo], curator)).toBe(true);
        // Yielding to itself would be a livelock: drain() would re-pick the very
        // job that just stepped aside, forever.
        expect(await d._preemptedBy([mi, miundo], miundo)).toBe(false);
        // A drained or paused rollback is not something the picker would take,
        // so standing aside for it would only cost a pass (and a userdata GET).
        // "Drained" per its own cursor KEY — the check that used to read the
        // legacy field on the record, which no build writes, and so never fired.
        expect(await d._preemptedBy([mi, Object.assign({}, miundo, { id: 'mu-done' })], mi))
            .toBe(false);
        expect(await d._preemptedBy([mi, Object.assign({}, miundo, { status: 'paused' })], mi))
            .toBe(false);
    });

    test('a job left drained in the queue is collected by the idle pass', async () => {
        // The completion the picker used to perform by accident. _drainJob drops
        // a job the moment its cursor reaches the end, but the pass can die in
        // between (stolen lease, closed tab, killed worker) — and a picker that
        // only takes real work would never look at the leftover again: 100 % in
        // the applet, the standby tick armed for good.
        const Drainer = loadDrainerClass();
        let queue = [
            { id: 'done', curatorId: 'c1', status: 'pending', appids: ['1'] },
            { id: 'paused', curatorId: 'c2', status: 'paused', appids: ['2'] },
        ];
        const removals = [];
        let pulses = 0;
        const d = new Drainer({
            store: {
                getQueue: async () => queue,
                getCursor: async (id) => (id === 'done' ? 1 : 0),
                removeIfDrained: async (id, cursor) => {
                    removals.push([id, cursor]);
                    queue = queue.filter(j => j.id !== id);
                    return true;
                },
                signalCompleted: async () => { pulses += 1; },
                acquireLock: async () => { throw new Error('nothing here is drainable'); },
            },
            api: {}, gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(), ownerId: 't1', standbyMs: 0,
        });

        await d.drain();
        expect(removals).toEqual([['done', 1]]);   // …and the PAUSED job is left alone
        expect(pulses).toBe(1);
        expect(queue.map(j => j.id)).toEqual(['paused']);
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

    test('back-to-back kicks cost ONE userdata read; the second is deferred, not dropped', async () => {
        // Flipping the master toggle off and on is a storage write each way, and
        // every write this drainer watches kicks a pass. The rate gate paces the
        // ignore POSTs but not the dedupe GET at the top of a pass, so without a
        // floor a user could spend one userdata read per flip, per host.
        let now = 1_000_000;
        const deferred = [];
        const Drainer = loadDrainerClass({ now: () => now }, {
            setTimeout: (fn, ms) => { deferred.push({ fn, ms }); return 1; },
            clearTimeout: () => {},
        });
        let reads = 0;
        let cursor = 0;
        let reserves = 0;
        const posts = [];
        const d = new Drainer({
            store: {
                getQueue: async () => [{ id: 'j1', curatorId: 'c1', status: 'pending', appids: ['10', '20'] }],
                acquireLock: async () => true,
                releaseLock: async () => {},
                holdsLock: async () => true,
                getCursor: async () => cursor,
                setCursor: async (id, c) => { cursor = c; },
                renewLock: async () => {},
                removeIfDrained: async () => true,
                signalCompleted: async () => {},
            },
            api: { ignore: async (appid) => { posts.push(appid); return { ok: true }; } },
            // One slot per pass, so each pass ends with the job still drainable —
            // the shape a re-kick has to find something to do in.
            gate: { reserve: async () => ({ ok: reserves++ % 2 === 0 }) },
            fetchUserdata: async () => { reads += 1; return new Set(); },
            ownerId: 't1',
            standbyMs: 0,
        });

        await d.drain();
        expect(reads).toBe(1);
        expect(posts).toEqual(['10']);

        // A second kick in the same instant: no read, and a re-kick armed for
        // what is left of the gap.
        await d.drain();
        expect(reads).toBe(1);
        expect(deferred).toHaveLength(1);
        expect(deferred[0].ms).toBe(2000);

        // A third one does not stack a second timer — one deferred kick answers
        // for every kick the gap swallowed.
        await d.drain();
        expect(deferred).toHaveLength(1);

        // The deferred kick is a real pass once the gap has passed.
        now += 2000;
        await deferred[0].fn();
        await new Promise(r => setTimeout(r, 0));
        expect(reads).toBe(2);
    });

    test('a deferred kick re-enters through the host rekick, not straight into drain()', async () => {
        // The SW wraps every pass in its own kick(): the halt check before, the
        // alarm re-sync after. A pass the gap deferred must not skip both.
        let now = 1_000_000;
        const deferred = [];
        const Drainer = loadDrainerClass({ now: () => now }, {
            setTimeout: (fn, ms) => { deferred.push({ fn, ms }); return 1; },
            clearTimeout: () => {},
        });
        let hostKicks = 0;
        let cursor = 0;
        let reserves = 0;
        const d = new Drainer({
            store: {
                getQueue: async () => [{ id: 'j1', curatorId: 'c1', status: 'pending', appids: ['10', '20'] }],
                acquireLock: async () => true,
                releaseLock: async () => {},
                holdsLock: async () => true,
                getCursor: async () => cursor,
                setCursor: async (id, c) => { cursor = c; },
                renewLock: async () => {},
                removeIfDrained: async () => true,
                signalCompleted: async () => {},
            },
            api: { ignore: async () => ({ ok: true }) },
            gate: { reserve: async () => ({ ok: reserves++ % 2 === 0 }) },
            fetchUserdata: async () => new Set(),
            ownerId: 't1',
            standbyMs: 0,
            rekick: () => { hostKicks += 1; },
        });

        await d.drain();                 // a real pass: the gap starts
        await d.drain();                 // deferred
        expect(deferred).toHaveLength(1);

        now += 2000;
        deferred[0].fn();
        expect(hostKicks).toBe(1);
    });

    test('a kick that costs nothing does not delay the next real pass', async () => {
        // The floor is measured from the last pass that reached the NETWORK. A
        // pass the gate stopped (master off) spends nothing, so re-enabling must
        // drain at once rather than sit out a gap it never earned.
        let now = 1_000_000;
        const deferred = [];
        const Drainer = loadDrainerClass({ now: () => now }, {
            setTimeout: (fn, ms) => { deferred.push({ fn, ms }); return 1; },
            clearTimeout: () => {},
        });
        let verdict = 'disabled';
        let reads = 0;
        let cursor = 0;
        const d = new Drainer({
            store: {
                getQueue: async () => [{ id: 'j1', curatorId: 'c1', status: 'pending', appids: ['10'] }],
                acquireLock: async () => true,
                releaseLock: async () => {},
                holdsLock: async () => true,
                getCursor: async () => cursor,
                setCursor: async (id, c) => { cursor = c; },
                renewLock: async () => {},
                removeIfDrained: async () => true,
                signalCompleted: async () => {},
            },
            api: { ignore: async () => ({ ok: true }) },
            gate: { reserve: async () => ({ ok: true }), stopped: async () => verdict },
            fetchUserdata: async () => { reads += 1; return new Set(); },
            ownerId: 't1',
            standbyMs: 0,
        });

        await d.drain();                 // refused up front — no lease, no read
        expect(reads).toBe(0);
        verdict = null;                  // the toggle came back in the same instant
        await d.drain();
        expect(reads).toBe(1);
        expect(deferred).toEqual([]);    // nothing was ever deferred
    });

    test('standbyMs: 0 disables the standby interval (the SW host retries via alarms)', async () => {
        const arms = [];
        const Drainer = loadDrainerClass(null, {
            setInterval: () => { arms.push(1); return 1; },
            clearInterval: () => {},
        });
        const d = new Drainer({
            store: { getQueue: async () => [{ id: 'j1', curatorId: 'c1', status: 'paused', appids: ['1'] }] },
            api: { ignore: async () => ({ ok: true }) },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            ownerId: 't1',
            standbyMs: 0,
        });
        await d.drain();          // a job exists, but the interval must not arm
        expect(arms).toEqual([]);
        expect(d._timer).toBe(null);
    });

    test('kick() absorbs a storage that throws — nothing awaits a pass', async () => {
        // The drainer is kicked from a storage listener and from a boot call,
        // neither of which awaits it. On a content script an extension update has
        // replaced, every chrome.storage call throws from then on, and the shims
        // hand that rejection straight to the caller (serialChain swallows only
        // its own continuation). kick() is where it stops.
        const Drainer = loadDrainerClass();
        const d = new Drainer({
            store: {
                getQueue: async () => { throw new Error('Extension context invalidated'); },
            },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            ownerId: 't1',
        });

        // drain() still rejects — it is awaited by the tests and by nothing else.
        await expect(d.drain()).rejects.toThrow('Extension context invalidated');

        const leaked = [];
        const onUnhandled = (e) => leaked.push(e);
        process.on('unhandledRejection', onUnhandled);
        try {
            d.kick();
            await new Promise((r) => setTimeout(r, 50));
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        expect(leaked.map(String)).toEqual([]);
    });

    test('the standby interval stops in the pass that empties the queue, not a tick later', async () => {
        // It is synced against the queue as READ, so a job the same pass then
        // collects would leave it armed for one more idle kick (9 s).
        let cleared = 0;
        const Drainer = loadDrainerClass(null, {
            setInterval: () => 7,
            clearInterval: () => { cleared += 1; },
        });
        // A job whose cursor already sits at its end: the picker skips it, so
        // this pass drains nothing and collects it instead.
        let queue = [{ id: 'j1', curatorId: 'c1', status: 'pending', appids: ['1'] }];
        const d = new Drainer({
            store: {
                getQueue: async () => queue,
                getCursor: async () => 1,
                removeIfDrained: async () => { queue = []; return true; },
                signalCompleted: async () => {},
            },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(),
            ownerId: 't1',
        });

        await d.drain();

        expect(cleared).toBeGreaterThan(0);
        expect(d._timer).toBe(null);
    });

    test('undo skip: a Remove landing inside markUndone does not get its cursor key back', async () => {
        // The cursor-write optimization hands setCursor the queue the loop already
        // read, on the premise that nothing awaited since. An undo skip breaks that
        // premise: markUndone reads every log chunk and writes one back. Remove
        // landing in that window takes the job AND its cursor key; re-creating the
        // key from the stale snapshot poisons the NEXT gesture job, which reuses the
        // fixed MIUNDO_JOB_ID and would mount already past its own end — the
        // rollback never goes out and removeIfDrained clears it with none of
        // removeJob's pulses, leaving the badge pale with nothing said.
        const Drainer = loadDrainerClass();
        const job = {
            id: 'job_mi_undo', curatorId: 'miundo', type: 'miundo',
            status: 'pending', appids: ['1'], snapshotTs: 500,
            meta: { '1': { ts: 500 } },
        };
        let removed = false;
        const cursorWrites = [];
        const store = {
            getQueue: async () => (removed ? [] : [{ ...job }]),
            holdsLock: async () => true,
            getCursor: async () => 0,
            // The real guard in src/curator/store.js: a cursor write is refused for
            // a job no longer queued, because removeJob is the key's only cleanup.
            setCursor: async (id, c, queue) => {
                if (!(queue || await store.getQueue()).some(j => j.id === id)) return false;
                cursorWrites.push(c);
                return true;
            },
            renewLock: async () => {},
            removeJob: async () => { removed = true; },
            removeIfDrained: async () => { removed = true; return true; },
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            gate: { reserve: async () => ({ ok: true }) },
            // '1' is absent, so the inverse dedupe fires and no POST is spent.
            fetchUserdata: async () => new Set(['999']),
            log: {
                append: async () => {},
                lastIgnoredAt: async () => 0,   // ignored long ago → the skip is trusted
                markUndone: async () => { removed = true; },   // the user presses Remove here
                wasReIgnoredAfter: async () => false,
            },
            ownerId: 't1',
        });
        await d._drainJob(job);
        expect(cursorWrites).toEqual([]);
    });

    test('MI skip: a Remove landing mid-iteration does not get its cursor key back either', async () => {
        // The twin of the case above, and the reason the re-read is keyed on the
        // job id being REUSED rather than on the pass being an undo: `job_mi` is
        // just as fixed as `job_mi_undo`. The window is narrower (no log rewrite,
        // but still holdsLock → renewLock → getCursor between the queue read and
        // the write), and the outcome is worse to diagnose — the next swipe
        // recreates `job_mi`, it mounts past its own end, removeIfDrained clears
        // it with none of removeJob's pulses, and the badge sits there over an
        // ignore that was never sent.
        const Drainer = loadDrainerClass();
        const job = {
            id: 'job_mi', curatorId: 'mi', type: 'mi',
            status: 'pending', appids: ['1'], meta: { '1': { name: 'A', reason: 0 } },
        };
        let removed = false;
        const cursorWrites = [];
        const store = {
            getQueue: async () => (removed ? [] : [{ ...job }]),
            // The user presses Remove in the applet right here, after the loop has
            // read the queue for this iteration.
            holdsLock: async () => { removed = true; return true; },
            getCursor: async () => 0,
            setCursor: async (id, c, queue) => {
                if (!(queue || await store.getQueue()).some(j => j.id === id)) return false;
                cursorWrites.push(c);
                return true;
            },
            renewLock: async () => {},
            removeJob: async () => { removed = true; },
            removeIfDrained: async () => { removed = true; return true; },
            signalCompleted: async () => {},
        };
        const d = new Drainer({
            store,
            gate: { reserve: async () => ({ ok: true }) },
            // '1' is already ignored → the MI dedupe skips it, so no POST is spent
            // and the iteration ends at exactly the cursor write under test.
            fetchUserdata: async () => new Set(['1']),
            ownerId: 't1',
        });

        await d._drainJob(job);

        expect(cursorWrites).toEqual([]);
    });
});

// A filter switch through the REAL store and staging service, racing a drainer
// that is mid-iteration on the old list. The stub stores above cannot show it:
// the bug lived in how the two real modules share one job id.
function loadRealStore(initial) {
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const norm = (keys) => (Array.isArray(keys) ? keys : [keys]);
    const data = clone(initial);
    const tick = (fn) => setTimeout(fn, 0);
    const local = {
        get: (keys, cb) => tick(() => {
            const out = {};
            for (const k of norm(keys)) if (k in data) out[k] = clone(data[k]);
            cb(out);
        }),
        set: (obj, cb) => tick(() => { for (const k of Object.keys(obj)) data[k] = clone(obj[k]); if (cb) cb(); }),
        remove: (keys, cb) => tick(() => { for (const k of norm(keys)) delete data[k]; if (cb) cb(); }),
    };
    const sandbox = { window: {}, chrome: { storage: { local } }, setTimeout, Date, Math, JSON };
    vm.createContext(sandbox);
    loadEscape(sandbox);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'curator', 'store.js'), 'utf8'), sandbox);
    return { Store: sandbox.window.ILAP.Curator.Store, data };
}

function loadEnqueueService() {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'curator', 'enqueue-service.js'), 'utf8'), sandbox);
    return sandbox.window.ILAP.Curator.EnqueueService;
}

test.describe('CuratorQueueDrainer × EnqueueService — filter switch mid-drain (unit)', () => {

    test('a switch during the gate wait stops the old list: no stale POST, the new list starts at 0', async () => {
        const OLD = 'job_123_1';
        const { Store, data } = loadRealStore({
            ilap_curator_queue: [{ id: OLD, type: 'curator', curatorId: '123', curatorName: 'Cur',
                filter: 'not_recommended', status: 'pending', appids: ['1', '2', '3'], total: 3 }],
            ['ilap_curator_cursor_' + OLD]: 1,
            ['ilap_curator_skipped_' + OLD]: 4,
            ilap_curator_cache: { '123': { fetchedAt: Date.now(), apps: {
                not_recommended: ['1', '2', '3'], informational: ['7', '8'], recommended: [] } } },
        });
        const EnqueueService = loadEnqueueService();
        const svc = new EnqueueService({ store: Store, enumerator: loadEnumerator(), maxJobs: 3 });
        const Drainer = loadDrainerClass();
        const posts = [];
        let switched = false;
        const d = new Drainer({
            store: Store,
            api: { ignore: async (appid) => { posts.push(appid); return { ok: true }; } },
            gate: {
                reserve: async () => {
                    if (!switched) {
                        switched = true;
                        // The user picks another filter while the POST for '2'
                        // waits its slot, and the cache answers before it arrives.
                        const o = await svc.stage('123', 'Cur', 'url', 'informational');
                        await svc.resolve('123', o.jobId, o.name, 'informational', o.paused);
                    }
                    return { ok: true };
                },
            },
            fetchUserdata: async () => new Set(),
            ownerId: 't1',
        });

        await d._drainJob((await Store.getQueue())[0]);
        expect(posts).toEqual([]);   // nothing from the old list after the switch

        const [job] = await Store.getQueue();
        expect(job.id).not.toBe(OLD);
        expect(job).toMatchObject({ filter: 'informational', status: 'pending', appids: ['7', '8'] });
        expect(await Store.getCursor(job.id)).toBe(0);
        expect(data).not.toHaveProperty('ilap_curator_cursor_' + OLD);
        expect(data).not.toHaveProperty('ilap_curator_skipped_' + OLD);

        await d._drainJob(job);
        expect(posts).toEqual(['7', '8']);   // the new list, from its first entry
    });
});
