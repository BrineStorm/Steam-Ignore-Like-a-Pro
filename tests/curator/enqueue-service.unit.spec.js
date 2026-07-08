const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// EnqueueService (src/curator/enqueue-service.js) as a Node unit — no browser.
// This is the logic that had ZERO coverage while it lived as free functions in
// curator/main.js reaching into the Store/Enumerator singletons: staging outcomes
// (add / switch / no-op / full) and resolution (cache-vs-enumerate, the confirm
// threshold, the mid-enumeration removal bail, and the enumerate-failure fallback).

function loadService() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'curator', 'enqueue-service.js'),
        'utf8'
    );
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.Curator.EnqueueService;
}
const EnqueueService = loadService();

// In-memory Store stub mirroring the async facade EnqueueService depends on.
function makeStore(initialQueue = []) {
    const state = {
        queue: initialQueue.map(j => Object.assign({}, j)),
        cache: null, cacheFresh: false,
        cursors: {}, removed: [], updates: []
    };
    const store = {
        state,
        async mutateQueue(fn) {
            const next = fn(state.queue.map(j => Object.assign({}, j)));
            if (next) state.queue = next;
            return state.queue;
        },
        async getCache() { return state.cache; },
        isFresh() { return state.cacheFresh; },
        async putCache(id, obj) { state.cachePut = obj; state.cache = obj; },
        async getQueue() { return state.queue.map(j => Object.assign({}, j)); },
        async removeJob(jobId) {
            state.removed.push(jobId);
            state.queue = state.queue.filter(j => j.id !== jobId);
        },
        async setCursor(jobId, n) { state.cursors[jobId] = n; },
        async updateJob(jobId, patch) {
            state.updates.push({ jobId, patch });
            const j = state.queue.find(x => x.id === jobId);
            if (j) Object.assign(j, patch);
        }
    };
    return store;
}

// Enumerator stub: enumerate() returns the seeded apps; filterAppids keeps the
// rows whose `type` matches the requested filter.
function makeEnum(apps, total) {
    return {
        calls: 0,
        async enumerate() { this.calls++; return { total: total != null ? total : apps.length, apps }; },
        filterAppids(list, filter) { return list.filter(a => a.type === filter).map(a => a.appid); }
    };
}

const build = (store, enumerator, opts) => new EnqueueService(Object.assign(
    { store, enumerator, maxJobs: 3, confirmThreshold: 25 }, opts || {}
));

test.describe('EnqueueService.stage (unit)', () => {
    test('adds a new job as enumerating and reports kind:added', async () => {
        const store = makeStore();
        const svc = build(store, makeEnum([]));
        const outcome = await svc.stage('123', 'Cur', 'https://x/curator/123', 'not_recommended');
        expect(outcome.kind).toBe('added');
        expect(store.state.queue).toHaveLength(1);
        const job = store.state.queue[0];
        expect(job).toMatchObject({
            curatorId: '123', curatorName: 'Cur', curatorUrl: 'https://x/curator/123',
            filter: 'not_recommended', status: 'enumerating', appids: [], total: 0
        });
        expect(outcome.jobId).toBe(job.id);
    });

    test('re-picking the SAME filter is a no-op (null outcome, queue unchanged)', async () => {
        const store = makeStore([{ id: 'j1', curatorId: '123', filter: 'not_recommended', status: 'pending' }]);
        const svc = build(store, makeEnum([]));
        const outcome = await svc.stage('123', 'Cur', 'url', 'not_recommended');
        expect(outcome).toBeNull();
        expect(store.state.queue[0].status).toBe('pending'); // untouched
    });

    test('switching filter re-targets the existing job back to enumerating', async () => {
        const store = makeStore([{ id: 'j1', curatorId: '123', curatorName: 'Cur',
            filter: 'not_recommended', status: 'pending', appids: [1, 2], total: 2 }]);
        const svc = build(store, makeEnum([]));
        const outcome = await svc.stage('123', 'Cur', 'url', 'informational');
        expect(outcome).toMatchObject({ kind: 'switched', jobId: 'j1', name: 'Cur' });
        expect(store.state.queue).toHaveLength(1);
        expect(store.state.queue[0]).toMatchObject({
            filter: 'informational', status: 'enumerating', appids: [], total: 0
        });
    });

    test('reports kind:full for a new curator once the cap is reached', async () => {
        const store = makeStore([
            { id: 'a', curatorId: '1', filter: 'all_but_recommended' },
            { id: 'b', curatorId: '2', filter: 'all_but_recommended' },
            { id: 'c', curatorId: '3', filter: 'all_but_recommended' }
        ]);
        const svc = build(store, makeEnum([]), { maxJobs: 3 });
        const outcome = await svc.stage('9', 'New', 'url', 'not_recommended');
        expect(outcome).toEqual({ kind: 'full' });
        expect(store.state.queue).toHaveLength(3); // nothing added
    });
});

test.describe('EnqueueService.resolve (unit)', () => {
    const seedJob = (extra) => Object.assign({ id: 'j1', curatorId: '123', filter: 'not_recommended', status: 'enumerating' }, extra);
    const apps = [
        { appid: 10, type: 'not_recommended' },
        { appid: 11, type: 'not_recommended' },
        { appid: 12, type: 'informational' }
    ];

    test('fresh cache: no enumerate, filters appids, resets cursor, flips to pending', async () => {
        const store = makeStore([seedJob()]);
        store.state.cache = { apps }; store.state.cacheFresh = true;
        const enumerator = makeEnum(apps);
        const res = await build(store, enumerator).resolve('123', 'j1', 'Cur', 'not_recommended', () => true);

        expect(res).toEqual({ ok: true });
        expect(enumerator.calls).toBe(0); // served from cache
        expect(store.state.cursors.j1).toBe(0);
        const last = store.state.updates.at(-1);
        expect(last).toMatchObject({ jobId: 'j1', patch: { status: 'pending', total: 2, appids: [10, 11] } });
    });

    test('stale cache: enumerates, writes the cache, then resolves', async () => {
        const store = makeStore([seedJob()]);
        store.state.cache = null; store.state.cacheFresh = false;
        const enumerator = makeEnum(apps, 3);
        await build(store, enumerator).resolve('123', 'j1', 'Cur', 'not_recommended', () => true);

        expect(enumerator.calls).toBe(1);
        expect(store.state.cachePut).toMatchObject({ total: 3, name: 'Cur', apps });
        expect(store.state.updates.at(-1).patch).toMatchObject({ status: 'pending', total: 2 });
    });

    test('confirm-reject on a large batch removes the job instead of queueing it', async () => {
        const big = Array.from({ length: 30 }, (_, i) => ({ appid: 100 + i, type: 'not_recommended' }));
        const store = makeStore([seedJob()]);
        store.state.cache = { apps: big }; store.state.cacheFresh = true;
        const res = await build(store, makeEnum(big)).resolve('123', 'j1', 'Cur', 'not_recommended', () => false);

        expect(res).toBeUndefined();                 // a deliberate user cancel is NOT an error → no toast
        expect(store.state.removed).toContain('j1');
        expect(store.state.updates).toHaveLength(0); // never flipped to pending
    });

    test('job removed mid-enumeration: bail without writing cursor or status', async () => {
        const store = makeStore([]); // job no longer present
        store.state.cache = { apps }; store.state.cacheFresh = true;
        await build(store, makeEnum(apps)).resolve('123', 'j1', 'Cur', 'not_recommended', () => true);

        expect(store.state.updates).toHaveLength(0);
        expect(store.state.cursors.j1).toBeUndefined();
    });

    test('enumeration failure drops the job and reports { error:true } (never auto-ignores)', async () => {
        const store = makeStore([seedJob()]);
        store.state.cache = null; store.state.cacheFresh = false;
        const enumerator = { calls: 0, async enumerate() { this.calls++; throw new Error('boom'); }, filterAppids: () => [] };
        const res = await build(store, enumerator).resolve('123', 'j1', 'Cur', 'not_recommended', () => true);

        expect(enumerator.calls).toBe(1);
        expect(res).toEqual({ error: true });
        expect(store.state.removed).toContain('j1'); // dead job removed, not left at pending 0/—
        expect(store.state.updates).toHaveLength(0);  // never flipped to drainable
    });

    test('empty list (parsed 0 / nothing under filter) drops the job and reports { error:true }', async () => {
        const store = makeStore([seedJob()]);
        // Fresh cache with apps, but the requested filter matches none of them.
        store.state.cache = { apps: [{ appid: 10, type: 'informational' }] }; store.state.cacheFresh = true;
        const res = await build(store, makeEnum([])).resolve('123', 'j1', 'Cur', 'not_recommended', () => true);

        expect(res).toEqual({ error: true });
        expect(store.state.removed).toContain('j1');
        expect(store.state.updates).toHaveLength(0);
    });
});
