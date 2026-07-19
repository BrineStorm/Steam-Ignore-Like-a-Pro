const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// UndoService staging as Node units — no browser. The snapshot semantics (a
// static appid list frozen at staging time) and the outcome branching
// (added / empty / exists / full) are the contract the popup droplist and the
// drainer both rely on. Store + log are stubs; the log's pure selectors are
// the REAL ones from src/ignore-log.js so the two modules can't drift.

function loadModules() {
    const sandbox = {
        window: {},
        Math, Date, Promise, Object, Array, String, Set, JSON,
        setTimeout, clearTimeout,
    };
    vm.createContext(sandbox);
    for (const rel of [['src', 'ignore-log.js'], ['src', 'undo-service.js']]) {
        const code = fs.readFileSync(path.join(__dirname, '..', '..', ...rel), 'utf8');
        vm.runInContext(code, sandbox);
    }
    return sandbox.window.ILAP;
}

// In-memory Store stub with the real mutateQueue contract: the mutator gets a
// copy and returns the next array (or a non-array to skip the write).
function makeStore(queue) {
    return {
        queue,
        mutateQueue(mutator) {
            const next = mutator(this.queue.slice());
            if (Array.isArray(next)) this.queue = next;
            return Promise.resolve(this.queue);
        },
    };
}

function makeLog(ILAP, entries) {
    return {
        getLog: async () => entries,
        snapshotLastN: ILAP.IgnoreLog.snapshotLastN,
        snapshotSince: ILAP.IgnoreLog.snapshotSince,
    };
}

const e = (appid, ts, over = {}) => Object.assign({ appid: String(appid), ts, source: 'mi' }, over);

test.describe('UndoService (unit)', () => {

    test('stageLastN stages a pending undo job with a unique newest-first snapshot', async () => {
        const ILAP = loadModules();
        const store = makeStore([]);
        const log = makeLog(ILAP, [e('1', 10), e('2', 20), e('1', 30), e('3', 40, { undoneAt: 45 })]);
        const svc = new ILAP.UndoService({ store, log, maxJobs: 3 });

        const before = Date.now();
        const outcome = await svc.stageLastN(10);
        expect(outcome).toEqual({ kind: 'added', total: 2 });

        const job = store.queue[0];
        expect(job.type).toBe('undo');
        expect(job.curatorId).toBe('undo');           // lease key: ilap_curator_lock_undo
        expect(job.status).toBe('pending');
        expect(job.appids).toEqual(['1', '2']);       // newest first, '1' deduped, undone '3' skipped
        expect(job.total).toBe(2);
        expect(job.snapshotTs).toBeGreaterThanOrEqual(before);
    });

    test('stageLastN clamps to what the log holds', async () => {
        const ILAP = loadModules();
        const store = makeStore([]);
        const svc = new ILAP.UndoService({ store, log: makeLog(ILAP, [e('1', 10)]), maxJobs: 3 });
        const outcome = await svc.stageLastN(1000);
        expect(outcome).toEqual({ kind: 'added', total: 1 });
    });

    test('empty scope → empty outcome, queue untouched', async () => {
        const ILAP = loadModules();
        const store = makeStore([]);
        const svc = new ILAP.UndoService({ store, log: makeLog(ILAP, []), maxJobs: 3 });
        expect(await svc.stageLastN(10)).toEqual({ kind: 'empty' });
        expect(store.queue).toEqual([]);
    });

    test('one undo job at a time → exists', async () => {
        const ILAP = loadModules();
        const store = makeStore([{ id: 'job_undo_1', type: 'undo', curatorId: 'undo', appids: ['9'], status: 'pending' }]);
        const svc = new ILAP.UndoService({ store, log: makeLog(ILAP, [e('1', 10)]), maxJobs: 3 });
        expect(await svc.stageLastN(1)).toEqual({ kind: 'exists' });
        expect(store.queue.length).toBe(1);
    });

    test('queue at the job cap → full', async () => {
        const ILAP = loadModules();
        const store = makeStore([
            { id: 'a', curatorId: '1', status: 'pending' },
            { id: 'b', curatorId: '2', status: 'pending' },
            { id: 'c', curatorId: '3', status: 'pending' },
        ]);
        const svc = new ILAP.UndoService({ store, log: makeLog(ILAP, [e('1', 10)]), maxJobs: 3 });
        expect(await svc.stageLastN(1)).toEqual({ kind: 'full' });
        expect(store.queue.length).toBe(3);
    });

    test('stageSince snapshots only the requested window', async () => {
        const ILAP = loadModules();
        const store = makeStore([]);
        const now = Date.now();
        const log = makeLog(ILAP, [
            e('1', now - 10 * 3600000),   // 10 h ago — outside a 6 h window
            e('2', now - 3600000),        // 1 h ago
            e('3', now - 60000),          // 1 min ago
        ]);
        const svc = new ILAP.UndoService({ store, log, maxJobs: 3 });
        const outcome = await svc.stageSince(6 * 3600000);
        expect(outcome).toEqual({ kind: 'added', total: 2 });
        expect(store.queue[0].appids).toEqual(['3', '2']);
    });
});
