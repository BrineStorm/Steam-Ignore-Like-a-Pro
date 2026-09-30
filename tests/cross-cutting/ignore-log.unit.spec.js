const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadEscape } = require('../_escape.js');

// The ignore log model (src/ignore-log.js) as Node units — no browser. The
// pure selectors drive the undo snapshots, the drainer's "last user intent
// wins" skip and the curator re-stage warning; the storage half is chunked
// across keys and serialized like the curator Store, checked against an async
// chrome stub so overlapping appends can't lose entries.

// `stats` is optional: pass one to count the storage reads a call actually
// makes (the drainer hooks cache a log snapshot, and the point of that cache is
// the read it does NOT do). `bus` is the onChanged fan-out: chrome delivers a
// change to EVERY context including the writer, so two instances sharing a
// storage and a bus are two worlds over one profile — a tab and the worker.
function loadIgnoreLog(storage, stats, bus) {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'ignore-log.js'), 'utf8');
    const listeners = bus || [];
    const fire = (keys) => {
        const changes = {};
        keys.forEach(k => { changes[k] = { newValue: storage[k] }; });
        listeners.forEach(cb => cb(changes, 'local'));
    };
    const chrome = {
        storage: {
            onChanged: { addListener: (cb) => listeners.push(cb) },
            local: {
                get: (keys, cb) => setTimeout(() => {
                    if (stats) stats.gets = (stats.gets || 0) + 1;
                    const out = {};
                    (Array.isArray(keys) ? keys : [keys]).forEach(k => {
                        if (k in storage) out[k] = storage[k];
                    });
                    cb(out);
                }, 1),
                set: (obj, cb) => setTimeout(() => {
                    Object.assign(storage, JSON.parse(JSON.stringify(obj)));
                    fire(Object.keys(obj));
                    cb && cb();
                }, 1),
                remove: (keys, cb) => setTimeout(() => {
                    const list = Array.isArray(keys) ? keys : [keys];
                    list.forEach(k => { delete storage[k]; });
                    fire(list);
                    cb && cb();
                }, 1),
            }
        }
    };
    const sandbox = {
        window: {}, chrome,
        Math, Date, Promise, Object, Array, String, Set, JSON,
        setTimeout, clearTimeout,
    };
    vm.createContext(sandbox);
    loadEscape(sandbox);
    // escape.js owns the shared string helpers (escapeHTML + sanitizeName)
    // for all three worlds and loads before everything else in each of them —
    // the sandbox mirrors that order.
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'escape.js'), 'utf8'), sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.IgnoreLog;
}

const e = (appid, ts, over = {}) => Object.assign({ appid: String(appid), ts, source: 'mi' }, over);

test.describe('IgnoreLog (unit)', () => {

    test('snapshotLastN: newest first, unique appids, undone entries skipped', () => {
        const Log = loadIgnoreLog({});
        const log = [
            e('1', 10),
            e('2', 20, { undoneAt: 25 }),   // already rolled back → not undoable
            e('3', 30),
            e('1', 40),                     // re-ignored: '1' must appear ONCE (newest)
            e('4', 50),
        ];
        expect(Log.snapshotLastN(log, 10)).toEqual(['4', '1', '3']);
        expect(Log.snapshotLastN(log, 2)).toEqual(['4', '1']);
        expect(Log.snapshotLastN([], 5)).toEqual([]);
    });

    test('snapshotSince: time-scoped, unique, undone skipped', () => {
        const Log = loadIgnoreLog({});
        const log = [
            e('1', 10),
            e('2', 100),
            e('3', 150, { undoneAt: 160 }),
            e('4', 200),
        ];
        expect(Log.snapshotSince(log, 100)).toEqual(['4', '2']);
        expect(Log.snapshotSince(log, 0)).toEqual(['4', '2', '1']);
        expect(Log.snapshotSince(log, 500)).toEqual([]);
    });

    test('undoableCount counts unique live appids', () => {
        const Log = loadIgnoreLog({});
        expect(Log.undoableCount([e('1', 1), e('1', 2), e('2', 3), e('3', 4, { undoneAt: 5 })])).toBe(2);
        expect(Log.undoableCount([])).toBe(0);
    });

    test('reIgnoredAfter: only a LIVE entry newer than the snapshot counts', () => {
        const Log = loadIgnoreLog({});
        const log = [e('1', 10), e('1', 50), e('2', 50, { undoneAt: 60 })];
        expect(Log.reIgnoredAfter(log, '1', 30)).toBe(true);   // re-ignored at 50 > 30
        expect(Log.reIgnoredAfter(log, '1', 50)).toBe(false);  // nothing strictly newer
        expect(Log.reIgnoredAfter(log, '2', 30)).toBe(false);  // newer but already undone
    });

    test('lastIgnoredAt: newest LIVE ignore ts, undone/skipped ignored', () => {
        const Log = loadIgnoreLog({});
        const log = [
            e('1', 10),
            e('1', 40),
            e('1', 90, { undoneAt: 95 }),           // undone → not a live ignore
            e('2', 20, { skipped: 'unavailable' }), // a refusal, not an ignore
            e('3', 30),
        ];
        expect(Log.lastIgnoredAt(log, '1')).toBe(40);  // newest live entry, not the undone 90
        expect(Log.lastIgnoredAt(log, '2')).toBe(0);   // only a skipped record
        expect(Log.lastIgnoredAt(log, '3')).toBe(30);
        expect(Log.lastIgnoredAt(log, '999')).toBe(0); // absent
        expect(Log.lastIgnoredAt([], '1')).toBe(0);
    });

    test('markedUndone: marks live entries up to the snapshot, leaves newer ones', () => {
        const Log = loadIgnoreLog({});
        const log = [e('1', 10), e('1', 40), e('1', 90), e('2', 20)];
        const next = Log.markedUndone(log, '1', 50, 1000);
        expect(next[0].undoneAt).toBe(1000);   // ts 10 ≤ 50
        expect(next[1].undoneAt).toBe(1000);   // ts 40 ≤ 50
        expect(next[2].undoneAt).toBeUndefined(); // ts 90 — after the snapshot, stays live
        expect(next[3].undoneAt).toBeUndefined(); // other appid untouched
    });

    test('lastUndoneForCurator: newest undoneAt within the window only', () => {
        const Log = loadIgnoreLog({});
        const log = [
            e('1', 10, { curatorId: '77', undoneAt: 900 }),
            e('2', 20, { curatorId: '77', undoneAt: 950 }),
            e('3', 30, { curatorId: '88', undoneAt: 990 }),  // other curator
            e('4', 40, { curatorId: '77' }),                 // never undone
        ];
        expect(Log.lastUndoneForCurator(log, '77', 100, 1000)).toBe(950);
        expect(Log.lastUndoneForCurator(log, '77', 40, 1000)).toBe(0);  // window too small
        expect(Log.lastUndoneForCurator(log, '99', 1000, 1000)).toBe(0);
    });

    test('skipped entries (region-locked, never ignored) are inert for every undo selector', () => {
        // A curator drain records a region-locked appid it stepped over as
        // { skipped: 'unavailable' } — a refusal, not an ignore. It must not
        // be undoable, must not read as a "re-ignored after the snapshot"
        // veto, and markedUndone must leave it untouched.
        const Log = loadIgnoreLog({});
        const log = [
            e('1', 10),
            e('480', 20, { skipped: 'unavailable', source: 'curator' }),
        ];
        expect(Log.snapshotLastN(log, 10)).toEqual(['1']);
        expect(Log.undoableCount(log)).toBe(1);
        expect(Log.reIgnoredAfter(log, '480', 5)).toBe(false);
        const next = Log.markedUndone(log, '480', 50, 1000);
        expect(next[1].undoneAt).toBeUndefined();
    });

    test('append persists the skipped marker', async () => {
        const storage = {};
        const Log = loadIgnoreLog(storage);
        await Log.append({ appid: '480', source: 'curator', curatorId: '42', skipped: 'unavailable' });
        expect((await Log.getLog())[0].skipped).toBe('unavailable');
    });

    test('appendPlan: fills the tail chunk, opens the next one, drops the oldest past the cap', () => {
        const Log = loadIgnoreLog({});
        const c = (seq) => Log.CHUNK_PREFIX + seq;
        // Room in the tail: one write, the index untouched.
        let plan = Log.appendPlan({ first: 0, last: 0 }, [e('1', 1)], e('2', 2), 2, 3);
        expect(Object.keys(plan.writes)).toEqual([c(0)]);
        expect(plan.removes).toEqual([]);
        // Tail full: a new chunk and a moved index.
        plan = Log.appendPlan({ first: 0, last: 0 }, [e('1', 1), e('2', 2)], e('3', 3), 2, 3);
        expect(plan.writes[c(1)].map(x => x.appid)).toEqual(['3']);
        expect(plan.writes[Log.INDEX_KEY]).toEqual({ first: 0, last: 1 });
        // A new chunk past maxChunks retires the oldest.
        plan = Log.appendPlan({ first: 0, last: 2 }, [e('5', 5), e('6', 6)], e('7', 7), 2, 3);
        expect(plan.removes).toEqual([c(0)]);
        expect(plan.writes[Log.INDEX_KEY]).toEqual({ first: 1, last: 3 });
    });

    test('a write touches one small chunk, and the log reads back whole across chunks', async () => {
        // The point of the chunks: a drain's append must not rewrite the log.
        const storage = {};
        const Log = loadIgnoreLog(storage);
        const n = Log.CHUNK_SIZE * 2 + 5;
        for (let i = 0; i < n; i++) await Log.append({ appid: String(i), source: 'curator' });
        expect(storage[Log.INDEX_KEY]).toEqual({ first: 0, last: 2 });
        expect(storage[Log.CHUNK_PREFIX + 2]).toHaveLength(5);
        const log = await Log.getLog();
        expect(log.map(x => x.appid)).toEqual(Array.from({ length: n }, (_, i) => String(i)));
    });

    test('a legacy single-array log becomes the chunked log, and its key is removed', async () => {
        const legacy = Array.from({ length: 150 }, (_, i) => e(String(i), i));
        const storage = { ilap_ignore_log: legacy };
        const Log = loadIgnoreLog(storage);
        expect((await Log.getLog()).map(x => x.appid)).toEqual(legacy.map(x => x.appid));
        expect(storage.ilap_ignore_log).toBeUndefined();
        expect(storage[Log.INDEX_KEY]).toEqual({ first: 0, last: 1 });
        // Writes carry on from the migrated tail.
        await Log.append({ appid: 'next', source: 'mi' });
        const log = await Log.getLog();
        expect(log).toHaveLength(151);
        expect(log[150].appid).toBe('next');
    });

    test('a legacy array next to chunks replaces them (how a spec seeds the log)', async () => {
        const storage = {};
        const Log = loadIgnoreLog(storage);
        for (let i = 0; i < 3; i++) await Log.append({ appid: 'old' + i, source: 'eq' });
        storage.ilap_ignore_log = [e('seeded', 1)];
        expect((await Log.getLog()).map(x => x.appid)).toEqual(['seeded']);
        storage.ilap_ignore_log = [];
        expect(await Log.getLog()).toEqual([]);
    });

    test('append: concurrent appends all land (serialized RMW), bad entries dropped', async () => {
        const storage = {};
        const Log = loadIgnoreLog(storage);
        await Promise.all([
            ...Array.from({ length: 20 }, (_, i) => Log.append({ appid: String(i), source: 'eq' })),
            Log.append(null),               // no entry
            Log.append({ source: 'dq' }),   // no appid (DQ parser miss) — dropped
        ]);
        const log = await Log.getLog();
        expect(log.length).toBe(20);
        expect(new Set(log.map(x => x.appid)).size).toBe(20); // nothing lost or duplicated
        expect(log.every(x => typeof x.ts === 'number')).toBe(true);
    });

    test('append normalizes the stored name through the shared sanitizer', async () => {
        // The log used to carry its OWN reduced copy of the normalizer (tags +
        // trim only) for the worlds that don't load utils.js; it now calls the
        // one definition in escape.js, so control chars and whitespace runs are
        // collapsed here too — the drift this consolidation removed.
        const storage = {};
        const Log = loadIgnoreLog(storage);
        await Log.append({ appid: '10', name: ' <b>Game</b> ', source: 'mi' });
        expect((await Log.getLog())[0].name).toBe('bGame/b');
        await Log.append({ appid: '11', name: 'Half\tLife' + String.fromCharCode(0) + '2', source: 'mi' });
        expect((await Log.getLog())[1].name).toBe('Half Life 2');
    });

    test('markUndone persists through storage, rewriting only the chunk it touches', async () => {
        const storage = {};
        const Log = loadIgnoreLog(storage);
        await Log.append({ appid: '5', source: 'curator', curatorId: '42' });
        for (let i = 0; i < Log.CHUNK_SIZE; i++) await Log.append({ appid: 'x' + i, source: 'eq' });
        const secondChunk = storage[Log.CHUNK_PREFIX + 1];
        await Log.markUndone('5', Date.now() + 1000);
        const entry = (await Log.getLog())[0];
        expect(entry.curatorId).toBe('42');
        expect(typeof entry.undoneAt).toBe('number');
        expect(storage[Log.CHUNK_PREFIX + 1]).toBe(secondChunk);   // not rewritten
    });

    test('drainerHooks: one log snapshot per pass, not one read per appid', async () => {
        // The drainer asks lastIgnoredAt/wasReIgnoredAfter per ENTRY, and an undo
        // job is up to the whole undoable list — unshared, that is a full chunk
        // read and a full array rebuild per appid, i.e. O(n²) over the log.
        const storage = {};
        const stats = {};
        const Log = loadIgnoreLog(storage, stats);
        await Log.append({ appid: '1', ts: 1000, source: 'mi' });
        const hooks = Log.drainerHooks();

        stats.gets = 0;
        for (let i = 0; i < 10; i++) expect(await hooks.wasReIgnoredAfter('1', 2000)).toBe(false);
        const shared = stats.gets;
        expect(shared).toBeLessThanOrEqual(2);   // the index read plus the chunk read, once
    });

    test('drainerHooks: the snapshot never outlives a write, this context or another', async () => {
        // The cache must not blind the two guards it feeds: a re-ignore landing
        // mid-pass is exactly what wasReIgnoredAfter exists to catch, and it can
        // arrive from a tab draining MI while the worker drains the undo job.
        const storage = {};
        const bus = [];
        const Log = loadIgnoreLog(storage, null, bus);
        await Log.append({ appid: '1', ts: 1000, source: 'mi' });
        const hooks = Log.drainerHooks();
        expect(await hooks.wasReIgnoredAfter('1', 2000)).toBe(false);   // snapshot taken
        expect(await hooks.lastIgnoredAt('1')).toBe(1000);

        // Another context's append — it reaches this one only as onChanged.
        const foreign = loadIgnoreLog(storage, null, bus);
        await foreign.append({ appid: '1', ts: 3000, source: 'mi' });
        expect(await hooks.wasReIgnoredAfter('1', 2000)).toBe(true);
        expect(await hooks.lastIgnoredAt('1')).toBe(3000);

        // ...and this context's own, which drops the snapshot up front.
        await hooks.append({ appid: '1', ts: 5000, source: 'mi' });
        expect(await hooks.lastIgnoredAt('1')).toBe(5000);
    });
});
