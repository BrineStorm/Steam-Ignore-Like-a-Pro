const fs = require('fs');
const { test, expect, AUTH_FILE } = require('../_fixtures.js');
const { setExtensionStorage, clearExtensionStorage } = require('../_extension.js');
const { randomAppPage } = require('../_app-pool.js');
const { readQueue, readLog, logEntry } = require('./_helpers.js');
const {
    readUserdata,
    readSid,
    ignore,
    unignore,
    pollUserdata,
    ensureNotIgnored,
} = require('../_steam-live.js');

// LIVE curator-drain specs — REAL ignores against the logged-in Steam account,
// with NO network stubs (unlike drain.spec.js). They validate the two empirical
// assumptions the unit tests can only postulate:
//
//   1. the region-lock ⇔ 400 ⇔ appdetails-success:false correlation the 400-
//      classifier stands on: a real POST for Spacewar (480) must 400, and the
//      drainer must classify+skip it (not burn it as a systemic failure) while
//      the rest of the queue really ignores — proving the `status === 400` gate
//      end-to-end against live Steam;
//   2. that a freshly-ignored game staged for undo is actually un-ignored (the
//      userdata-lag guard's user-visible contract), not stranded ignored with
//      its log entry burned.
//
// Skipped without a saved session (they can't run offline), and under Firefox
// (one real ignore per browser is enough; the correlation is browser-agnostic).
//
// The authenticated same-origin helpers (userdata reads, the pre-clean, the
// un-ignore) live in tests/_steam-live.js — sw-live.spec.js drives the same
// account the same way. Each test un-ignores its own appid in a finally;
// globalTeardown is only a backstop. Spacewar is never really ignored (it 400s),
// so it never enters any cleanup diff.

const REGION_LOCKED = '480';   // Spacewar — ignore-400s in every region; appdetails success:false (probed)
const NORMAL_LOCK = '440';     // Team Fortress 2 — free + global, ignore succeeds (region-lock test)
const NORMAL_UNDO = '570';     // Dota 2 — free + global (undo test)

function curatorJob(over = {}) {
    return Object.assign({
        id: 'job_live_1',
        curatorId: '990099',
        curatorName: 'Live Drain',
        filter: 'not_recommended',
        appids: [],
        total: 0,
        status: 'pending',
        addedAt: Date.now(),
    }, over);
}

test.describe('Curator — LIVE drain against the real account', () => {

    test('a region-locked appid (Spacewar 480) is classified & skipped; the rest of the queue really ignores', async ({ page, context, browserName }) => {
        test.skip(!fs.existsSync(AUTH_FILE), 'no saved Steam session');
        test.skip(browserName === 'firefox', 'live real-ignore test runs under chromium only');
        test.setTimeout(3 * 60 * 1000);

        await clearExtensionStorage(context);
        await page.goto(randomAppPage());

        // Guard against a vacuous run: userdata must read as logged-in, else the
        // ignore POSTs / checks below would silently no-op against an empty set.
        const auth = await readUserdata(page);
        test.skip(!auth || auth.ownedCount === 0, 'page session not authenticated for the userdata API');
        const sid = await readSid(page);
        test.skip(!sid, 'no sessionid on the page');

        try {
            // Clean slate: a pre-ignored appid dedupe-skips (no POST, no log
            // append), which would make the "really ignored" assertions vacuous.
            await ensureNotIgnored(page, sid, NORMAL_LOCK);

            // Region-locked appid FIRST, so we also prove a lock doesn't block
            // the appid queued behind it. Reload so the drainer boots onto the
            // seeded queue (drain.spec's deterministic pattern).
            await setExtensionStorage(context, {
                ilap_master_enabled: true,
                ilap_curator_queue: [curatorJob({
                    appids: [REGION_LOCKED, NORMAL_LOCK], total: 2,
                })],
            });
            await page.reload();

            // The whole job drains and is removed (it neither stalls on the lock
            // nor MAX_FAILS-burns it — either would leave the job behind).
            await expect
                .poll(async () => (await readQueue(context)).length, { timeout: 60000 })
                .toBe(0);

            // Durable evidence (the ephemeral skip counter dies with the job):
            // 480 is recorded as a region-lock refusal, NORMAL_LOCK as a real
            // ignore. `skipped:'unavailable'` is reachable ONLY via the
            // classifier's status===400 + appdetails-success:false branch, so
            // this is the end-to-end proof the 400-gate fired correctly.
            const log = await readLog(context);
            const locked = logEntry(log, REGION_LOCKED);
            const normal = logEntry(log, NORMAL_LOCK);
            expect(locked, '480 must be logged, not silently dropped').toBeTruthy();
            expect(locked.skipped).toBe('unavailable');
            expect(normal, 'the normal appid must be logged as a real ignore').toBeTruthy();
            expect(normal.skipped).toBeUndefined();

            // And it truly landed on the account: NORMAL_LOCK appears in live
            // userdata (after propagation), the region-locked one never does.
            const snap = await pollUserdata(page, ids => ids.has(NORMAL_LOCK));
            const ids = new Set(snap ? snap.ids : []);
            expect(ids.has(NORMAL_LOCK)).toBe(true);
            expect(ids.has(REGION_LOCKED)).toBe(false);
        } finally {
            await unignore(page, sid, NORMAL_LOCK).catch(() => {});
            await clearExtensionStorage(context);
        }
    });

    test('a freshly-ignored game staged for undo is really un-ignored and its log entry marked', async ({ page, context, browserName }) => {
        test.skip(!fs.existsSync(AUTH_FILE), 'no saved Steam session');
        test.skip(browserName === 'firefox', 'live real-ignore test runs under chromium only');
        test.setTimeout(3 * 60 * 1000);

        await clearExtensionStorage(context);
        await page.goto(randomAppPage());

        const auth = await readUserdata(page);
        test.skip(!auth || auth.ownedCount === 0, 'page session not authenticated for the userdata API');
        const sid = await readSid(page);
        test.skip(!sid, 'no sessionid on the page');

        try {
            // Deterministic setup: really ignore NORMAL_UNDO and seed its log
            // entry DIRECTLY, bypassing the curator drainer (whose userdata
            // dedupe flakes on Steam's eventually-consistent userdata nodes —
            // that is the curator drainer's concern, covered by the region-lock
            // test; here the target is the UNDO path). Staged IMMEDIATELY after
            // the ignore, so live userdata is most likely still lagging it — the
            // exact bug window the fresh-log guard exists for. Whether the guard
            // fires (userdata stale) or the normal inverse-dedupe path does
            // (userdata caught up), the OUTCOME is identical: a real remove POST.
            const ok = await ignore(page, sid, NORMAL_UNDO);
            expect(ok, 'the setup ignore POST must succeed').toBe(true);

            const ts = Date.now();
            await setExtensionStorage(context, {
                ilap_master_enabled: true,
                ilap_ignore_log: [{ appid: NORMAL_UNDO, ts, source: 'mi' }],
                ilap_curator_queue: [{
                    id: 'job_live_undo', type: 'undo', curatorId: 'undo', curatorName: '',
                    appids: [NORMAL_UNDO], total: 1, status: 'pending',
                    snapshotTs: Date.now(), addedAt: Date.now(),
                }],
            });
            await page.reload();
            await expect
                .poll(async () => (await readQueue(context)).length, { timeout: 60000 })
                .toBe(0);

            // The log entry survives (kept, not deleted) and is marked undone —
            // NOT prematurely marked on a skipped POST (that's the stranding bug).
            const afterUndo = logEntry(await readLog(context), NORMAL_UNDO);
            expect(afterUndo, 'the log entry must survive the undo').toBeTruthy();
            expect(typeof afterUndo.undoneAt).toBe('number');

            // And the un-ignore truly landed: the game is gone from live userdata.
            const snap = await pollUserdata(page, ids => !ids.has(NORMAL_UNDO));
            expect(new Set(snap ? snap.ids : []).has(NORMAL_UNDO)).toBe(false);
        } finally {
            await unignore(page, sid, NORMAL_UNDO).catch(() => {});
            await clearExtensionStorage(context);
        }
    });
});
