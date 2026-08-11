const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The curator storage model (src/curator/store.js) keeps its decision logic in
// three pure helpers — evictCache (TTL + LRU), lockFree (lease takeability),
// isFresh — so they unit-test in Node without chrome.storage. The queue RMW
// path (mutateQueue serialization, cursor keys) is unit-tested below against an
// async in-memory chrome.storage stub; the rest is exercised via the drainer E2E.
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

// Load the store against an async chrome.storage.local stub. Every get/set/remove
// completes on a macrotask (setTimeout 0), so an UNserialized read-modify-write
// genuinely interleaves — exactly the lost-update race mutateQueue must close.
function loadStoreWithChrome(initial) {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'curator', 'store.js'),
        'utf8'
    );
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const norm = (keys) => (Array.isArray(keys) ? keys : [keys]);
    let data = clone(initial || {});
    const local = {
        get: (keys, cb) => setTimeout(() => {
            const out = {};
            for (const k of norm(keys)) if (k in data) out[k] = clone(data[k]);
            cb(out);
        }, 0),
        set: (obj, cb) => setTimeout(() => {
            for (const k of Object.keys(obj)) data[k] = clone(obj[k]);
            if (cb) cb();
        }, 0),
        remove: (keys, cb) => setTimeout(() => {
            for (const k of norm(keys)) delete data[k];
            if (cb) cb();
        }, 0),
    };
    const sandbox = { window: {}, chrome: { storage: { local } }, setTimeout, Date, Math, JSON };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return { Store: sandbox.window.ILAP.Curator.Store, data: () => data };
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

    test('miSourceLabel maps an MI reason to its Last-Ignored label', () => {
        // One mapping for both drain hosts (the content-script wiring in
        // drainer.js and the SW's saveStats shim): reason 2 is the
        // Already-Played swipe, everything else is the default ignore.
        expect(S.miSourceLabel(2)).toBe('Played Elsewhere');
        expect(S.miSourceLabel('2')).toBe('Played Elsewhere');   // meta survives a JSON round-trip
        expect(S.miSourceLabel(0)).toBe('Default Ignore');
        expect(S.miSourceLabel(undefined)).toBe('Default Ignore');
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

test.describe('Curator storage — serialized queue writes (unit)', () => {

    test('20 concurrent updateJob patches all land (no lost update)', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{ id: 'a', status: 'pending' }],
        });
        // Without the mutateQueue chain these overlapping get→set pairs would
        // read the same base record and clobber each other's fields.
        await Promise.all(Array.from({ length: 20 }, (_, i) =>
            Store.updateJob('a', { ['f' + i]: true })
        ));
        const job = data().ilap_curator_queue[0];
        for (let i = 0; i < 20; i++) expect(job['f' + i]).toBe(true);
    });

    test('concurrent updateJob + removeJob lose neither effect', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [
                { id: 'a', status: 'pending' },
                { id: 'b', status: 'pending' },
            ],
            ilap_curator_cursor_b: 5,
        });
        await Promise.all([
            Store.updateJob('a', { status: 'paused' }),
            Store.removeJob('b'),
        ]);
        const q = data().ilap_curator_queue;
        expect(q.map(j => j.id)).toEqual(['a']);
        expect(q[0].status).toBe('paused');
        // The removed job's progress cursor is cleaned up with it.
        expect(data().ilap_curator_cursor_b).toBeUndefined();
    });

    test('updateJob accepts a function patch and no-ops on a missing job', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{ id: 'a', status: 'paused' }],
        });
        const updated = await Store.updateJob('a', (j) => ({
            status: j.status === 'paused' ? 'pending' : 'paused',
        }));
        expect(updated.status).toBe('pending');
        expect(data().ilap_curator_queue[0].status).toBe('pending');

        const missing = await Store.updateJob('nope', { status: 'paused' });
        expect(missing).toBeNull();
        expect(data().ilap_curator_queue).toHaveLength(1);
    });

    test('pause-button spam: 11 concurrent toggles land as exact click parity', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{ id: 'a', status: 'pending' }],
        });
        // Models a user hammering Pause/Resume: every toggle is a function patch
        // evaluated inside the serialized RMW, so each click sees the state left
        // by the previous one. 11 toggles from 'pending' → odd parity → 'paused'.
        // (Unserialized, overlapping toggles read the same base status and
        // collapse — e.g. two clicks become one toggle.)
        await Promise.all(Array.from({ length: 11 }, () =>
            Store.updateJob('a', (j) => ({ status: j.status === 'paused' ? 'pending' : 'paused' }))
        ));
        expect(data().ilap_curator_queue[0].status).toBe('paused');
    });

    test('cursor keys: setCursor/getCursor roundtrip, null when unset', async () => {
        const { Store } = loadStoreWithChrome({ ilap_curator_queue: [{ id: 'j1' }] });
        expect(await Store.getCursor('j1')).toBeNull();
        expect(await Store.setCursor('j1', 7)).toBe(true);
        expect(await Store.getCursor('j1')).toBe(7);
    });

    test('setCursor refuses for a job not in the queue — a removed job cannot leak its key', async () => {
        const { Store, data } = loadStoreWithChrome({ ilap_curator_queue: [{ id: 'j1' }] });
        await Store.setCursor('j1', 3);
        // removeJob is the cursor key's ONLY cleanup path; a cursor write
        // landing after it (remove/resolve or remove/drain race) must not
        // recreate the key.
        await Store.removeJob('j1');
        expect(await Store.setCursor('j1', 4)).toBe(false);
        expect(data()['ilap_curator_cursor_j1']).toBeUndefined();
        expect(await Store.getCursor('j1')).toBeNull();
    });

    test('removeIfDrained drops a fully-drained job and cleans its progress keys', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{ id: 'j1', appids: ['10', '11'], status: 'pending' }],
            ilap_curator_cursor_j1: 2,
            ilap_curator_skipped_j1: 1,
        });
        expect(await Store.removeIfDrained('j1', 2)).toBe(true);
        expect(data().ilap_curator_queue).toEqual([]);
        expect(data().ilap_curator_cursor_j1).toBeUndefined();
        expect(data().ilap_curator_skipped_j1).toBeUndefined();
    });

    test('removeIfDrained keeps a job that grew past the drainer snapshot (MI append race)', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{ id: 'job_mi', type: 'mi', appids: ['10', '11'], status: 'pending' }],
            ilap_curator_cursor_job_mi: 1,
        });
        // The drainer would complete on a snapshot where cursor(1) reached the end,
        // but the fresh queue already carries an appended '11' → NOT drained: kept.
        expect(await Store.removeIfDrained('job_mi', 1)).toBe(false);
        expect(data().ilap_curator_queue).toHaveLength(1);
        expect(data().ilap_curator_queue[0].appids).toEqual(['10', '11']);
    });
});

test.describe('Curator storage — Manual-Ignore deferral job (unit)', () => {

    test('first swipe creates the MI job; later swipes append (append-or-create)', async () => {
        const { Store, data } = loadStoreWithChrome({});
        expect(await Store.enqueueMi({ appid: 10, name: 'A', reason: 0 })).toEqual({ kind: 'added', total: 1 });
        expect(await Store.enqueueMi({ appid: 11, name: 'B', reason: 2 })).toEqual({ kind: 'added', total: 2 });
        const q = data().ilap_curator_queue;
        expect(q).toHaveLength(1);
        const job = q[0];
        expect(job.type).toBe('mi');
        expect(job.curatorId).toBe(Store.MI_ID);
        expect(job.id).toBe(Store.MI_JOB_ID);
        expect(job.appids).toEqual(['10', '11']);         // string appids for the generic paths
        expect(job.total).toBe(2);
        expect(job.meta['10']).toEqual({ name: 'A', reason: 0 });
        expect(job.meta['11']).toEqual({ name: 'B', reason: 2 });   // per-appid name + reason
    });

    test('a re-swiped appid does not enqueue twice (no double-POST)', async () => {
        const { Store, data } = loadStoreWithChrome({});
        await Store.enqueueMi({ appid: 10, name: 'A', reason: 0 });
        expect(await Store.enqueueMi({ appid: 10, name: 'A', reason: 0 })).toEqual({ kind: 'added', total: 1 });
        expect(data().ilap_curator_queue[0].appids).toEqual(['10']);
    });

    test('a de-duped re-swipe still refreshes the meta (last gesture wins)', async () => {
        const { Store, data } = loadStoreWithChrome({});
        await Store.enqueueMi({ appid: 10, name: 'A', reason: 0 });
        // The per-tab session map blocks a re-swipe inside ONE tab; from a
        // second tab the same game can be swiped with the OTHER reason, and
        // that tab paints the badge its gesture chose. The queued entry must
        // follow, or the POST contradicts the badge the user is looking at.
        expect(await Store.enqueueMi({ appid: 10, name: 'A', reason: 2 }))
            .toEqual({ kind: 'added', total: 1 });
        const job = data().ilap_curator_queue[0];
        expect(job.appids).toEqual(['10']);                          // still one POST
        expect(job.meta['10']).toEqual({ name: 'A', reason: 2 });    // …with the newer reason
    });

    test('a re-swipe of an already-DRAINED appid enqueues again (undo → re-ignore)', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{
                id: 'job_mi', type: 'mi', curatorId: 'mi', appids: ['10', '11'],
                meta: { 10: { name: 'A', reason: 0 }, 11: { name: 'B', reason: 0 } },
                total: 2, status: 'pending',
            }],
            ilap_curator_cursor_job_mi: 1,   // '10' drained, '11' still pending
        });
        // '10' was ignored, then rolled back by an undo job — which clears its
        // badge and its session-map entry, so the tab lets the user swipe it
        // again. Drained entries stay in `appids` until the job completes, so
        // matching the whole array would drop that swipe while still answering
        // 'added': a badge for an ignore that never fires.
        expect(await Store.enqueueMi({ appid: 10, name: 'A', reason: 0 }))
            .toEqual({ kind: 'added', total: 3 });
        expect(data().ilap_curator_queue[0].appids).toEqual(['10', '11', '10']);

        // …while a still-PENDING appid is deduped as before — appending there
        // would genuinely double-POST the same game.
        expect(await Store.enqueueMi({ appid: 11, name: 'B', reason: 0 }))
            .toEqual({ kind: 'added', total: 3 });
        expect(data().ilap_curator_queue[0].appids).toEqual(['10', '11', '10']);
    });

    test('MI_MAX is a hard cap: a swipe past it is a silent no-op (kind:full)', async () => {
        const MI_MAX = loadStore().MI_MAX;   // pure load for the constant
        const appids = Array.from({ length: MI_MAX }, (_, i) => String(i));
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{
                id: 'job_mi', type: 'mi', curatorId: 'mi',
                appids, meta: {}, total: appids.length, status: 'pending',
            }],
        });
        expect(await Store.enqueueMi({ appid: 99999, name: 'Z', reason: 0 })).toEqual({ kind: 'full' });
        expect(data().ilap_curator_queue[0].appids).toHaveLength(MI_MAX); // unchanged
    });

    test('MI is the one type allowed to exceed MAX_JOBS (exclusive 4th slot)', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [
                { id: 'a', curatorId: '1', appids: ['1'], status: 'pending' },
                { id: 'b', curatorId: '2', appids: ['2'], status: 'pending' },
                { id: 'c', curatorId: '3', appids: ['3'], status: 'pending' },
            ],
        });
        expect(await Store.enqueueMi({ appid: 10, name: 'A', reason: 0 })).toEqual({ kind: 'added', total: 1 });
        const q = data().ilap_curator_queue;
        expect(q).toHaveLength(4);                         // over the cap, deliberately
        expect(q.filter(j => j.type === 'mi')).toHaveLength(1);
    });

    test('signalUnignored writes the un-ignore pulse (one appid or a whole list)', async () => {
        const { Store, data } = loadStoreWithChrome({});
        await Store.signalUnignored(292030);
        const pulse = data()[Store.UNIGNORE_PULSE_KEY];
        expect(pulse.appids).toEqual(['292030']);
        expect(typeof pulse.ts).toBe('number');
        // Default reason: the undo drain rolled it back on purpose. The MI
        // listener stays silent for this one — the user asked for it.
        expect(pulse.reason).toBe('undo');

        // A dropped MI ignore carries the reason that makes the tab explain
        // itself instead of silently un-badging the game.
        await Store.signalUnignored(480, 'failed');
        expect(data()[Store.UNIGNORE_PULSE_KEY]).toMatchObject({ appids: ['480'], reason: 'failed' });

        // A removed MI job drops its whole undrained tail — one write rather
        // than N onChanged fan-outs across every open tab.
        await Store.signalUnignored([10, '11'], 'failed');
        expect(data()[Store.UNIGNORE_PULSE_KEY])
            .toMatchObject({ appids: ['10', '11'], reason: 'failed' });
    });

    test('signalUndoFailed reports a rollback that will never land', async () => {
        const { Store, data } = loadStoreWithChrome({});
        await Store.signalUndoFailed();
        // No appid: nothing on the page is wrong (the game IS still ignored),
        // so there is nothing to correct — just something to say. The default
        // reason is the one that says it.
        expect(data()[Store.UNDO_FAILED_KEY]).toMatchObject({ reason: 'failed' });
        expect(typeof data()[Store.UNDO_FAILED_KEY].ts).toBe('number');
    });

    test('removing an MI job un-badges its UNDRAINED tail only', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{
                id: 'job_mi', type: 'mi', curatorId: 'mi', appids: ['10', '11', '12'],
                meta: {}, total: 3, status: 'pending',
            }],
            ilap_curator_cursor_job_mi: 1,      // '10' was really ignored
            ilap_curator_skipped_job_mi: 1,
        });
        await Store.removeJob('job_mi');
        expect(data().ilap_curator_queue).toEqual([]);
        expect(data().ilap_curator_cursor_job_mi).toBeUndefined();
        expect(data().ilap_curator_skipped_job_mi).toBeUndefined();
        // '10' landed, so its badge is honest and stays. '11'/'12' were badged
        // optimistically for POSTs that will now never fire — the queue-stuck
        // card tells the user to remove the job, so this is the routine path.
        // Reason 'removed', not 'failed': the user did this, so the tab drops
        // the badges silently instead of blaming Steam for refusing an ignore
        // it was never asked to perform.
        expect(data()[Store.UNIGNORE_PULSE_KEY])
            .toMatchObject({ appids: ['11', '12'], reason: 'removed' });
    });

    test('removing a curator job pulses nothing (no optimistic badges to correct)', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [
                { id: 'j1', curatorId: 'c1', appids: ['10', '11'], status: 'pending' }],
        });
        await Store.removeJob('j1');
        expect(data().ilap_curator_queue).toEqual([]);
        expect(data()[Store.UNIGNORE_PULSE_KEY]).toBeUndefined();
    });

    test('a swipe appended concurrently with completion is never lost (enqueueMi vs removeIfDrained)', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{
                id: 'job_mi', type: 'mi', curatorId: 'mi', appids: ['10'],
                meta: { 10: { name: 'A', reason: 0 } }, total: 1, status: 'pending',
            }],
            ilap_curator_cursor_job_mi: 1,   // '10' drained → the drainer would complete
        });
        // Both funnel through the same serialized queueChain, so whichever wins the
        // swipe survives: enqueueMi-first → removeIfDrained sees the grown job and
        // keeps it; removeIfDrained-first → the job is dropped and enqueueMi recreates it.
        await Promise.all([
            Store.removeIfDrained('job_mi', 1),
            Store.enqueueMi({ appid: 11, name: 'B', reason: 0 }),
        ]);
        const mi = (data().ilap_curator_queue || []).find(j => j.type === 'mi');
        expect(mi).toBeTruthy();            // an MI job still exists
        expect(mi.appids).toContain('11');  // the swipe was never wiped
    });

    test('enqueueMiUndo creates its OWN job — direction is a property of the job', () => {
        // Not a flag on an MI entry: the drainer reads isUndo from job.type and it
        // governs the whole pass (strict userdata, inverse dedupe, probeLogin on an
        // empty set). A mixed job would force MI onto the strict path permanently.
        return (async () => {
            const { Store, data } = loadStoreWithChrome({});
            const out = await Store.enqueueMiUndo({ appid: 480 });
            expect(out).toMatchObject({ kind: 'added', total: 1 });
            const q = data().ilap_curator_queue;
            expect(q).toHaveLength(1);
            expect(q[0]).toMatchObject({
                id: Store.MIUNDO_JOB_ID, type: 'miundo',
                curatorId: Store.MIUNDO_ID, appids: ['480'], status: 'pending',
            });
            // Its own lease id, so it hands off independently of the MI job.
            expect(q[0].curatorId).not.toBe(Store.MI_ID);
        })();
    });

    test('MIUNDO_MAX caps the un-ignore job on its OWN budget', async () => {
        // Its own cap, counted over its own job: a full ignore queue must not
        // refuse the rollbacks that are the way OUT of one, and vice versa.
        const S = loadStore();
        const appids = Array.from({ length: S.MIUNDO_MAX }, (_, i) => String(i));
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{
                id: S.MIUNDO_JOB_ID, type: 'miundo', curatorId: S.MIUNDO_ID,
                appids, meta: {}, total: appids.length, status: 'pending',
            }],
        });
        expect(await Store.enqueueMiUndo({ appid: 99999 })).toEqual({ kind: 'full' });
        expect(data().ilap_curator_queue[0].appids).toHaveLength(S.MIUNDO_MAX);

        // …and a swipe still goes through: the ignore job is empty, and the two
        // caps are independent (this is what makes the two "queue is stuck"
        // cards different cards — each names its own job).
        expect(await Store.enqueueMi({ appid: 12345, name: 'A', reason: 0 }))
            .toEqual({ kind: 'added', total: 1 });
    });

    test('a full IGNORE job does not block the rollbacks that empty it', async () => {
        const S = loadStore();
        const appids = Array.from({ length: S.MI_MAX }, (_, i) => String(i));
        const { Store } = loadStoreWithChrome({
            ilap_curator_queue: [{
                id: S.MI_JOB_ID, type: 'mi', curatorId: S.MI_ID,
                appids, meta: {}, total: appids.length, status: 'pending',
            }],
        });
        expect(await Store.enqueueMi({ appid: 99999, name: 'Z', reason: 0 })).toEqual({ kind: 'full' });
        expect(await Store.enqueueMiUndo({ appid: '0' })).toMatchObject({ kind: 'added' });
    });

    test('an ignore job and an un-ignore job coexist without touching each other', async () => {
        const { Store, data } = loadStoreWithChrome({});
        await Store.enqueueMi({ appid: 10, name: 'A', reason: 2 });
        await Store.enqueueMiUndo({ appid: 20 });
        const q = data().ilap_curator_queue;
        expect(q.map(j => j.type).sort()).toEqual(['mi', 'miundo']);
        expect(q.find(j => j.type === 'mi').appids).toEqual(['10']);
        expect(q.find(j => j.type === 'miundo').appids).toEqual(['20']);
    });

    test('each un-ignore entry carries its OWN gesture time, not one job-level snapshot', async () => {
        // The job auto-fills for as long as it lives, so a single job-level
        // snapshotTs would be the moment the FIRST gesture created it — a game
        // ignored after that and un-ignored by a later gesture would read as
        // "re-ignored after the snapshot" and be skipped by the drainer.
        const { Store, data } = loadStoreWithChrome({});
        await Store.enqueueMiUndo({ appid: 10 });
        const first = data().ilap_curator_queue[0].meta['10'].ts;
        await new Promise(r => setTimeout(r, 5));
        await Store.enqueueMiUndo({ appid: 11 });
        const second = data().ilap_curator_queue[0].meta['11'].ts;
        expect(typeof first).toBe('number');
        expect(second).toBeGreaterThanOrEqual(first);
    });

    test('a re-gesture on a still-pending appid does not double-queue it', async () => {
        const { Store, data } = loadStoreWithChrome({});
        await Store.enqueueMiUndo({ appid: 10 });
        const out = await Store.enqueueMiUndo({ appid: 10 });
        expect(out.kind).toBe('added');   // accepted, but…
        expect(data().ilap_curator_queue[0].appids).toEqual(['10']);  // …not appended twice
    });

    test('cancelMiEntry marks a still-pending swipe instead of splicing it out', async () => {
        // Splicing would slide entry '12' into index 1, which the cursor has
        // already passed — the drainer would skip a game it never sent.
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{
                id: 'job_mi', type: 'mi', curatorId: 'mi',
                appids: ['10', '11', '12'], meta: { 11: { name: 'B', reason: 2 } },
                total: 3, status: 'pending',
            }],
            ilap_curator_cursor_job_mi: 1,
        });
        expect(await Store.cancelMiEntry(11)).toBe(true);
        const mi = data().ilap_curator_queue[0];
        expect(mi.appids).toEqual(['10', '11', '12']);   // indices untouched
        expect(mi.meta['11']).toMatchObject({ name: 'B', reason: 2, cancelled: true });
    });

    test('cancelMiEntry refuses an entry the drain has already passed', async () => {
        // The ignore was sent — there is nothing to cancel, and reporting true
        // would un-badge a game that IS ignored. The caller must fall back to a
        // real rollback instead.
        const { Store } = loadStoreWithChrome({
            ilap_curator_queue: [{
                id: 'job_mi', type: 'mi', curatorId: 'mi',
                appids: ['10', '11'], meta: {}, total: 2, status: 'pending',
            }],
            ilap_curator_cursor_job_mi: 2,
        });
        expect(await Store.cancelMiEntry(10)).toBe(false);
        expect(await Store.cancelMiEntry(11)).toBe(false);
    });

    test('cancelMiEntry on an appid that was never swiped (or no MI job) is false', async () => {
        const { Store } = loadStoreWithChrome({});
        expect(await Store.cancelMiEntry(10)).toBe(false);
        await Store.enqueueMi({ appid: 10, name: 'A', reason: 0 });
        expect(await Store.cancelMiEntry(99)).toBe(false);
    });

    test('re-swiping a cancelled game revives the entry (meta is rewritten whole)', async () => {
        // The de-dup keeps the appid where it is, so the revival has to come from
        // the meta rewrite — otherwise the swipe would be silently cancelled.
        const { Store, data } = loadStoreWithChrome({});
        await Store.enqueueMi({ appid: 10, name: 'A', reason: 0 });
        expect(await Store.cancelMiEntry(10)).toBe(true);
        const out = await Store.enqueueMi({ appid: 10, name: 'A', reason: 2 });
        expect(out.kind).toBe('added');
        const mi = data().ilap_curator_queue[0];
        expect(mi.appids).toEqual(['10']);
        expect(mi.meta['10'].cancelled).toBeUndefined();
        expect(mi.meta['10'].reason).toBe(2);
    });

    test('cancelMiEntry never touches the un-ignore job', async () => {
        const { Store, data } = loadStoreWithChrome({});
        await Store.enqueueMiUndo({ appid: 10 });
        expect(await Store.cancelMiEntry(10)).toBe(false);
        expect(data().ilap_curator_queue[0].meta['10'].cancelled).toBeUndefined();
    });

    test('removing an un-ignore job with work left reports the stranded rollbacks', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{
                id: 'job_mi_undo', type: 'miundo', curatorId: 'miundo',
                appids: ['10', '11'], meta: {}, total: 2, status: 'pending',
            }],
            ilap_curator_cursor_job_mi_undo: 1,
        });
        await Store.removeJob('job_mi_undo');
        // Nothing is un-badged — the games stay ignored, which is what their
        // badges say — but the rollback the user gestured for is gone, and this
        // pulse is what drops the pending mark from those badges.
        expect(data()[Store.UNIGNORE_PULSE_KEY]).toBeUndefined();
        // Reason 'removed', so the marks come off SILENTLY: the user dropped the
        // job themselves, and "Steam refused some rollbacks" would blame Steam
        // for what they just did. Same distinction the MI tail's pulse makes.
        expect(data()[Store.UNDO_FAILED_KEY]).toMatchObject({ reason: 'removed' });
    });

    test('removing a FULLY DRAINED un-ignore job reports nothing', async () => {
        const { Store, data } = loadStoreWithChrome({
            ilap_curator_queue: [{
                id: 'job_mi_undo', type: 'miundo', curatorId: 'miundo',
                appids: ['10'], meta: {}, total: 1, status: 'pending',
            }],
            ilap_curator_cursor_job_mi_undo: 1,   // every rollback landed
        });
        await Store.removeJob('job_mi_undo');
        expect(data()[Store.UNDO_FAILED_KEY]).toBeUndefined();
    });
});
