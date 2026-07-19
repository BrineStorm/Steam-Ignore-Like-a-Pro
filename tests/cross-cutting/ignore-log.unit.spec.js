const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ilap_ignore_log model (src/ignore-log.js) as Node units — no browser. The
// pure selectors drive the undo snapshots, the drainer's "last user intent
// wins" skip and the curator re-stage warning; the storage half is the same
// serialized-RMW pattern as the curator Store, checked against an async
// chrome stub so overlapping appends can't lose entries.

function loadIgnoreLog(storage) {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'ignore-log.js'), 'utf8');
    const chrome = {
        storage: {
            local: {
                get: (keys, cb) => setTimeout(() => {
                    const out = {};
                    (Array.isArray(keys) ? keys : [keys]).forEach(k => {
                        if (k in storage) out[k] = storage[k];
                    });
                    cb(out);
                }, 1),
                set: (obj, cb) => setTimeout(() => {
                    Object.assign(storage, JSON.parse(JSON.stringify(obj)));
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
        expect(storage[Log.LOG_KEY][0].skipped).toBe('unavailable');
    });

    test('appended trims oldest past the cap', () => {
        const Log = loadIgnoreLog({});
        const log = [e('1', 1), e('2', 2), e('3', 3)];
        const next = Log.appended(log, e('4', 4), 3);
        expect(next.map(x => x.appid)).toEqual(['2', '3', '4']);
    });

    test('append: concurrent appends all land (serialized RMW), bad entries dropped', async () => {
        const storage = {};
        const Log = loadIgnoreLog(storage);
        await Promise.all([
            ...Array.from({ length: 20 }, (_, i) => Log.append({ appid: String(i), source: 'eq' })),
            Log.append(null),               // no entry
            Log.append({ source: 'dq' }),   // no appid (DQ parser miss) — dropped
        ]);
        const log = storage[Log.LOG_KEY];
        expect(log.length).toBe(20);
        expect(new Set(log.map(x => x.appid)).size).toBe(20); // nothing lost or duplicated
        expect(log.every(x => typeof x.ts === 'number')).toBe(true);
    });

    test('append strips tag delimiters from the stored name (fallback path)', async () => {
        // The vm sandbox has no window.ILAP.sanitizeName (utils.js isn't loaded),
        // so this exercises the minimal local fallback: no < or > survives.
        const storage = {};
        const Log = loadIgnoreLog(storage);
        await Log.append({ appid: '10', name: ' <b>Game</b> ', source: 'mi' });
        expect(storage[Log.LOG_KEY][0].name).toBe('bGame/b');
    });

    test('markUndone persists through storage', async () => {
        const storage = {};
        const Log = loadIgnoreLog(storage);
        await Log.append({ appid: '5', source: 'curator', curatorId: '42' });
        await Log.markUndone('5', Date.now() + 1000);
        const entry = storage[Log.LOG_KEY][0];
        expect(entry.curatorId).toBe('42');
        expect(typeof entry.undoneAt).toBe('number');
    });
});
