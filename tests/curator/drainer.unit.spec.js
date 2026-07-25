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
        const Drainer = loadDrainerClass();
        const job = { id: 'j1', curatorId: 'c1', status: 'pending', appids: ['480', '11'] };
        let cursor = 0;
        let removed = false;
        const posts = [];
        const bumps = [];
        const appended = [];
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
    });

    test('undo job: a classified region-lock skips with no log write (nothing was rolled back)', async () => {
        const Drainer = loadDrainerClass();
        const job = {
            id: 'ju', curatorId: 'undo', type: 'undo',
            status: 'pending', appids: ['480'], snapshotTs: 500,
        };
        let cursor = 0;
        let removed = false;
        const bumps = [];
        const marked = [];
        const appended = [];
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
            api: {
                ignore: async () => ({ ok: true }),
                unignore: async () => ({ ok: false, rateLimited: false, unavailable: true }),
            },
            gate: { reserve: async () => ({ ok: true }) },
            fetchUserdata: async () => new Set(['480']),
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
    });

    test('undo job: inverse dedupe, remove=1 POSTs, log marked undone', async () => {
        // '2' is not in rgIgnoredApps (already rolled back elsewhere) → skipped
        // with no request BUT still marked undone (so it can't inflate "of N"
        // forever); '1' and '3' get un-ignore POSTs and their log entries
        // marked. The finished job is dropped like any other.
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

    test('curator job: every confirmed ignore lands in the undo log', async () => {
        const Drainer = loadDrainerClass();
        const job = { id: 'j1', curatorId: 'c9', status: 'pending', appids: ['7', '8'] };
        let cursor = 0;
        let removed = false;
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
    });

    test('MI job: drains each entry with its own reason, stamps Last Ignored, logs source:mi', async () => {
        // A swipe defers into a type:'mi' job carrying per-appid name + reason.
        // At drain the POST must use that reason (0 default / 2 played-elsewhere),
        // saveStats must stamp Last Ignored (gated strictly to MI), and the undo
        // log entry carries the name + source:'mi'.
        const Drainer = loadDrainerClass();
        const job = {
            id: 'job_mi', curatorId: 'mi', type: 'mi', status: 'pending',
            appids: ['10', '11'],
            meta: { 10: { name: 'A', reason: 0 }, 11: { name: 'B', reason: 2 } },
        };
        let cursor = 0;
        let removed = false;
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
        expect(appended).toEqual([
            { appid: '10', name: 'A', source: 'mi' },
            { appid: '11', name: 'B', source: 'mi' },
        ]);
        expect(cursor).toBe(2);
        expect(removed).toBe(true);
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
            signalUnignored: async (appid) => { unbadged.push(appid); },
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
        expect(unbadged).toEqual(['480']);   // only the refused MI game is un-badged
        expect(cursor).toBe(2);              // both entries stepped over
    });

    test('_pickJob prefers a drainable MI job over curator/undo work', () => {
        const Drainer = loadDrainerClass();
        const d = new Drainer({
            store: {}, api: {}, gate: {},
            fetchUserdata: async () => new Set(), ownerId: 't1',
        });
        const queue = [
            { id: 'c', curatorId: '1', status: 'pending', appids: ['1'] },
            { id: 'u', curatorId: 'undo', type: 'undo', status: 'pending', appids: ['2'] },
            { id: 'm', curatorId: 'mi', type: 'mi', status: 'pending', appids: ['3'] },
        ];
        expect(d._pickJob(queue).id).toBe('m');
        // With the MI job drained, the next pick falls back to document order.
        expect(d._pickJob(queue.slice(0, 2)).id).toBe('c');
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
});

// --- content-script boot: the SW sessionid cache ---------------------------
// The boot block caches the page's sessionid into ilap_sw_sid for the SW
// drainer (which cannot read document.cookie) and clears a halted SW route
// (ilap_sw_halt). Writes must be change-only: every store page boots this, and
// a same-value write would wake the service worker via onChanged for nothing.

function bootDrainer(sid, stored) {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'curator', 'drainer.js'), 'utf8');
    const gets = [];
    const sets = [];
    const sandbox = {
        window: {
            ILAP: {
                Curator: { Store: { getQueue: async () => [] } },
                apiIgnoreGame: async () => ({ ok: true }),
                apiUnignoreGame: async () => ({ ok: true }),
                IgnoreGate: { reserve: async () => ({ ok: true }), reportRateLimited: async () => {} },
                getSessionID: () => sid,
                newOwnerId: (p) => p + 'test',
                fetchIgnoredAppsStrict: async () => new Set(),
                SteamAuth: { probeLogin: async () => true },
            },
        },
        chrome: {
            storage: {
                local: {
                    get: (query, cb) => {
                        gets.push(query);
                        setTimeout(() => {
                            const out = {};
                            for (const k of Object.keys(query)) {
                                out[k] = (stored && k in stored) ? stored[k] : query[k];
                            }
                            cb(out);
                        }, 0);
                    },
                    set: (obj) => { sets.push({ ...obj }); },
                },
                onChanged: { addListener: () => {} },
            },
        },
        document: { readyState: 'complete', addEventListener: () => {} },
        Math, Date, Promise, Object, Array, String, Set,
        setTimeout, clearTimeout, setInterval, clearInterval,
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    const flush = async () => {
        for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    };
    return { gets, sets, flush };
}

test.describe('drainer boot: SW sessionid cache (unit)', () => {

    test('a new sessionid is cached (with the halt flag cleared)', async () => {
        const b = bootDrainer('sess-1', {});
        await b.flush();
        expect(b.sets).toEqual([{ ilap_sw_sid: 'sess-1', ilap_sw_halt: false }]);
    });

    test('an unchanged sessionid writes nothing (no pointless SW wake)', async () => {
        const b = bootDrainer('sess-1', { ilap_sw_sid: 'sess-1', ilap_sw_halt: false });
        await b.flush();
        expect(b.sets).toEqual([]);
    });

    test('a halted SW route is re-armed by the page visit even with the same sid', async () => {
        const b = bootDrainer('sess-1', { ilap_sw_sid: 'sess-1', ilap_sw_halt: true });
        await b.flush();
        expect(b.sets).toEqual([{ ilap_sw_sid: 'sess-1', ilap_sw_halt: false }]);
    });

    test('no sessionid (logged out) → the cache is left alone', async () => {
        const b = bootDrainer(null, { ilap_sw_sid: 'old', ilap_sw_halt: false });
        await b.flush();
        expect(b.sets).toEqual([]);
        expect(b.gets).toEqual([]); // not even a read — nothing to compare
    });
});
