const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { withVocab } = require('./_store-vocab.js');

// EnqueueService (src/curator/enqueue-service.js) as a Node unit — no browser.
// This is the logic that had ZERO coverage while it lived as free functions in
// curator/main.js reaching into the Store/Enumerator singletons: staging outcomes
// (add / the other review type / no-op / full) and resolution (cache-vs-enumerate,
// the mid-enumeration removal bail, and the enumerate-failure fallback).

function loadService() {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    // The coverage rules (coveredTypes / filterToAdd) live in filters.js.
    for (const file of ['filters.js', 'enqueue-service.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'curator', file), 'utf8'), sandbox);
    }
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
        // Mirrors the real Store: `patch` may be an object or a (job)=>partial fn,
        // and a vanished job is a no-op.
        async updateJob(jobId, patch) {
            const j = state.queue.find(x => x.id === jobId);
            if (!j) return null;
            const resolved = typeof patch === 'function' ? patch(j) : patch;
            state.updates.push({ jobId, patch: resolved });
            Object.assign(j, resolved);
        }
    };
    return withVocab(store);
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

const build = (store, enumerator) => new EnqueueService({ store, enumerator, maxJobs: 3 });

test.describe('EnqueueService.stage (unit)', () => {
    test('adds a new job as enumerating and reports kind:added', async () => {
        const store = makeStore();
        const svc = build(store, makeEnum([]));
        const outcome = await svc.stage('123', 'Cur', 'not_recommended');
        expect(outcome.kind).toBe('added');
        expect(store.state.queue).toHaveLength(1);
        const job = store.state.queue[0];
        expect(job).toMatchObject({
            type: 'curator',
            curatorId: '123', curatorName: 'Cur',
            filter: 'not_recommended', status: 'enumerating', appids: [], total: 0
        });
        expect(outcome.jobId).toBe(job.id);
    });

    test('re-picking the SAME filter is a no-op (null outcome, queue unchanged)', async () => {
        const store = makeStore([{ id: 'j1', curatorId: '123', filter: 'not_recommended', status: 'pending' }]);
        const svc = build(store, makeEnum([]));
        const outcome = await svc.stage('123', 'Cur', 'not_recommended');
        expect(outcome).toBeNull();
        expect(store.state.queue[0].status).toBe('pending'); // untouched
    });

    // A curator has one job per review type, or one of both. With one type
    // queued, the other one goes in as a job of its own, pending behind it.
    const nr = { id: 'j1', curatorId: '123', curatorName: 'Cur', filter: 'not_recommended',
        status: 'pending', appids: [1, 2], total: 2 };

    test('with one type queued, the other one is added as a job of its own', async () => {
        const store = makeStore([nr]);
        const outcome = await build(store, makeEnum([])).stage('123', 'Cur', 'informational');
        expect(outcome).toMatchObject({ kind: 'added', filter: 'informational' });
        expect(store.state.queue).toHaveLength(2);
        expect(store.state.queue[0]).toMatchObject(nr);   // the first job untouched
        expect(store.state.queue[1]).toMatchObject({
            id: outcome.jobId, curatorId: '123', filter: 'informational', status: 'enumerating'
        });
    });

    test('"All except Recommended" with one type queued adds the other type, as its own pick would', async () => {
        const store = makeStore([nr]);
        const outcome = await build(store, makeEnum([])).stage('123', 'Cur', 'all_but_recommended');
        expect(outcome).toMatchObject({ kind: 'added', filter: 'informational' });
        expect(store.state.queue.map(j => j.filter)).toEqual(['not_recommended', 'informational']);

        const inf = makeStore([Object.assign({}, nr, { filter: 'informational' })]);
        expect(await build(inf, makeEnum([])).stage('123', 'Cur', 'all_but_recommended'))
            .toMatchObject({ kind: 'added', filter: 'not_recommended' });
    });

    test('a covered pick is a no-op: both types queued, or a job of both', async () => {
        const both = makeStore([nr, Object.assign({}, nr, { id: 'j2', filter: 'informational' })]);
        for (const f of ['not_recommended', 'informational', 'all_but_recommended']) {
            expect(await build(both, makeEnum([])).stage('123', 'Cur', f)).toBeNull();
        }
        expect(both.state.queue).toHaveLength(2);

        const all = makeStore([Object.assign({}, nr, { filter: 'all_but_recommended' })]);
        for (const f of ['not_recommended', 'informational', 'all_but_recommended']) {
            expect(await build(all, makeEnum([])).stage('123', 'Cur', f)).toBeNull();
        }
        expect(all.state.queue).toHaveLength(1);
    });

    test('a nothing-queued "All except Recommended" pick is one job of both', async () => {
        const store = makeStore();
        expect(await build(store, makeEnum([])).stage('123', 'Cur', 'all_but_recommended'))
            .toMatchObject({ kind: 'added', filter: 'all_but_recommended' });
        expect(store.state.queue).toHaveLength(1);
    });

    test('the second type takes a job slot like any job', async () => {
        const store = makeStore([nr,
            { id: 'b', curatorId: '2', filter: 'all_but_recommended' },
            { id: 'c', curatorId: '3', filter: 'all_but_recommended' }]);
        expect(await build(store, makeEnum([])).stage('123', 'Cur', 'informational')).toEqual({ kind: 'full' });
        expect(store.state.queue).toHaveLength(3);
    });

    test('another curator\'s jobs and other job types cover nothing here', async () => {
        const store = makeStore([
            Object.assign({}, nr, { curatorId: '999', filter: 'all_but_recommended' }),
            { id: 'job_mi', type: 'mi', curatorId: 'mi', appids: ['1'] }
        ]);
        expect(await build(store, makeEnum([])).stage('123', 'Cur', 'informational'))
            .toMatchObject({ kind: 'added', filter: 'informational' });
    });

    test('reports kind:full for a new curator once the cap is reached', async () => {
        const store = makeStore([
            { id: 'a', curatorId: '1', filter: 'all_but_recommended' },
            { id: 'b', curatorId: '2', filter: 'all_but_recommended' },
            { id: 'c', curatorId: '3', filter: 'all_but_recommended' }
        ]);
        const svc = build(store, makeEnum([]));
        const outcome = await svc.stage('9', 'New', 'not_recommended');
        expect(outcome).toEqual({ kind: 'full' });
        expect(store.state.queue).toHaveLength(3); // nothing added
    });

    test('the gesture jobs take no place under the cap', async () => {
        const store = makeStore([
            { id: 'job_mi', type: 'mi', curatorId: 'mi', appids: ['1'] },
            { id: 'job_mi_undo', type: 'miundo', curatorId: 'miundo', appids: ['2'] },
            { id: 'a', curatorId: '1', filter: 'all_but_recommended' },
            { id: 'b', curatorId: '2', filter: 'all_but_recommended' }
        ]);
        const svc = build(store, makeEnum([]));
        expect(await svc.stage('9', 'New', 'not_recommended')).toMatchObject({ kind: 'added' });
        expect(await svc.stage('10', 'Next', 'not_recommended')).toEqual({ kind: 'full' });
    });

    test('a job of a type this build does not know still counts', async () => {
        const store = makeStore([
            { id: 'x', type: 'future', curatorId: 'x' },
            { id: 'a', curatorId: '1', filter: 'all_but_recommended' },
            { id: 'b', curatorId: '2', filter: 'all_but_recommended' }
        ]);
        const svc = build(store, makeEnum([]));
        expect(await svc.stage('9', 'New', 'not_recommended')).toEqual({ kind: 'full' });
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
        const res = await build(store, enumerator).resolve('123', 'j1', 'Cur', 'not_recommended');

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
        await build(store, enumerator).resolve('123', 'j1', 'Cur', 'not_recommended');

        expect(enumerator.calls).toBe(1);
        expect(store.state.cachePut).toMatchObject({ total: 3, name: 'Cur', apps });
        expect(store.state.updates.at(-1).patch).toMatchObject({ status: 'pending', total: 2 });
    });

    test('job removed mid-enumeration: bail without writing cursor or status', async () => {
        const store = makeStore([]); // job no longer present
        store.state.cache = { apps }; store.state.cacheFresh = true;
        await build(store, makeEnum(apps)).resolve('123', 'j1', 'Cur', 'not_recommended');

        expect(store.state.updates).toHaveLength(0);
        expect(store.state.cursors.j1).toBeUndefined();
    });

    test('enumeration failure drops the job and reports { error:true } (never auto-ignores)', async () => {
        const store = makeStore([seedJob()]);
        store.state.cache = null; store.state.cacheFresh = false;
        const enumerator = { calls: 0, async enumerate() { this.calls++; throw new Error('boom'); }, filterAppids: () => [] };
        const res = await build(store, enumerator).resolve('123', 'j1', 'Cur', 'not_recommended');

        expect(enumerator.calls).toBe(1);
        expect(res).toEqual({ error: true });
        expect(store.state.removed).toContain('j1'); // dead job removed, not left at pending 0/—
        expect(store.state.updates).toHaveLength(0);  // never flipped to drainable
    });

    test('a pause landed mid-enumeration survives resolve (status stays paused)', async () => {
        // The applet's Pause is clickable while the job is still
        // 'enumerating' — resolve must not clobber that intent back to pending.
        const store = makeStore([seedJob({ status: 'paused' })]);
        store.state.cache = { apps }; store.state.cacheFresh = true;
        const res = await build(store, makeEnum(apps)).resolve('123', 'j1', 'Cur', 'not_recommended');

        expect(res).toEqual({ ok: true });
        expect(store.state.queue[0]).toMatchObject({ status: 'paused', total: 2, appids: [10, 11] });
        expect(store.state.cursors.j1).toBe(0); // list still resolved + cursor reset
    });

    test('empty list (parsed 0 / nothing under filter) drops the job and reports { error:true }', async () => {
        const store = makeStore([seedJob()]);
        // Fresh cache with apps, but the requested filter matches none of them.
        store.state.cache = { apps: [{ appid: 10, type: 'informational' }] }; store.state.cacheFresh = true;
        const res = await build(store, makeEnum([])).resolve('123', 'j1', 'Cur', 'not_recommended');

        expect(res).toEqual({ error: true });
        expect(store.state.removed).toContain('j1');
        expect(store.state.updates).toHaveLength(0);
    });
});

// The cross on a queued row of the curator droplist.
test.describe('EnqueueService.removeQueued (unit)', () => {
    const nr = { id: 'j1', curatorId: '123', filter: 'not_recommended', status: 'pending' };
    const inf = { id: 'j2', curatorId: '123', filter: 'informational', status: 'pending' };

    test('removes this curator\'s job of that filter through Store.removeJob, and only it', async () => {
        const other = { id: 'j3', curatorId: '999', filter: 'not_recommended', status: 'pending' };
        const store = makeStore([nr, inf, other]);
        expect(await build(store, makeEnum([])).removeQueued('123', 'not_recommended')).toEqual({ kind: 'removed' });
        expect(store.state.removed).toEqual(['j1']);   // via removeJob: progress keys go with it
        expect(store.state.queue.map(j => j.id)).toEqual(['j2', 'j3']);
    });

    test('a job removed elsewhere meanwhile is a null no-op', async () => {
        const store = makeStore([inf]);
        expect(await build(store, makeEnum([])).removeQueued('123', 'not_recommended')).toBeNull();
        expect(store.state.removed).toHaveLength(0);
    });

    test('with the first type removed, the other type can be added again', async () => {
        const store = makeStore([nr, inf]);
        const svc = build(store, makeEnum([]));
        expect(await svc.stage('123', 'Cur', 'all_but_recommended')).toBeNull();   // covered
        await svc.removeQueued('123', 'not_recommended');
        expect(await svc.stage('123', 'Cur', 'all_but_recommended'))
            .toMatchObject({ kind: 'added', filter: 'not_recommended' });
    });
});
