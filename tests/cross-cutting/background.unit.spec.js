const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { logFromStorage } = require('../_ignore-log.js');

// Phase-3 SW drain (src/background.js) as a Node unit — no browser. The --test
// build swaps the background out entirely, so E2E never exercises this file;
// here the REAL modules (gate.js, curator/store.js, curator/drainer.js,
// ignore-log.js, migrate.js) are loaded through a stubbed importScripts into a
// worker-shaped sandbox (self, no document), with chrome.storage/alarms and
// fetch faked. Guards the SW-host contract:
//   - a queued job drains from the "worker" alone: sessionid comes from the
//     ilap_sw_sid cache, POSTs are paced by the real gate, the alarm is cleared
//     once the queue empties;
//   - no cached sid → no ignore POST (the gate's no-session stop applies);
//   - two consecutive failed POSTs halt the SW route (ilap_sw_halt) BEFORE the
//     drainer's MAX_FAILS skip can burn an appid; a fresh sid write (the
//     content script's page-boot cache) clears the way and the job completes;
//   - a 400 classified as a region-locked appid (appdetails success:false) is
//     skipped in one attempt, counted + logged, and never charges the halt;
//   - a long 429 penalty is never slept through: no slot is claimed and the
//     retry alarm lands at the penalty's end;
//   - a live foreign lease is respected (no steal, no POST), alarm re-armed;
//   - the alarm handler itself kicks a drain pass.

const IGNORE_URL = 'https://store.steampowered.com/recommended/ignorerecommendation/';
const USERDATA_URL = 'https://store.steampowered.com/dynamicstore/userdata/';
const ACCOUNT_URL = 'https://store.steampowered.com/account/';
const APPDETAILS_URL = 'https://store.steampowered.com/api/appdetails';
const ALARM = 'ilap_sw_drain';

function loadBackground(initial, opts) {
    opts = opts || {};
    const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
    const data = { ...(initial || {}) };
    const changedListeners = [];
    const alarmListeners = [];
    const alarms = {};
    const posts = [];
    const state = {
        // Per-call ignore-POST outcome (receives the parsed body); tests swap
        // it mid-run.
        postResult: opts.postResult || (() => ({ ok: true, status: 200 })),
        ignoredApps: opts.ignoredApps || {},
        // Userdata GETs so far, and the status to answer them with (none: 200).
        reads: 0,
        userdataStatus: opts.userdataStatus || 0,
        // Appids whose appdetails probe answers success:false (region-locked);
        // everything else probes available.
        unavailableApps: opts.unavailableApps || [],
        // Whether the /account/ login probe can reach Steam at all; tests flip
        // it mid-run to simulate an outage and its recovery.
        accountFails: opts.accountFails || (() => false),
    };

    const fireChanged = (changes) =>
        setTimeout(() => changedListeners.forEach((fn) => fn(changes, 'local')), 0);

    const local = {
        get: (query, cb) => setTimeout(() => {
            const out = {};
            if (query && typeof query === 'object' && !Array.isArray(query)) {
                for (const k of Object.keys(query)) out[k] = (k in data) ? clone(data[k]) : query[k];
            } else {
                for (const k of (Array.isArray(query) ? query : [query])) {
                    if (k in data) out[k] = clone(data[k]);
                }
            }
            cb(out);
        }, 0),
        set: (obj, cb) => setTimeout(() => {
            const changes = {};
            for (const k of Object.keys(obj)) {
                changes[k] = { oldValue: clone(data[k]), newValue: clone(obj[k]) };
                data[k] = clone(obj[k]);
            }
            if (cb) cb();
            fireChanged(changes);
        }, 0),
        remove: (keys, cb) => setTimeout(() => {
            const changes = {};
            for (const k of (Array.isArray(keys) ? keys : [keys])) {
                if (k in data) { changes[k] = { oldValue: clone(data[k]) }; delete data[k]; }
            }
            if (cb) cb();
            fireChanged(changes);
        }, 0),
    };

    const parseBody = (body) => {
        const out = {};
        for (const [k, v] of new URLSearchParams(body)) out[k] = v;
        return out;
    };

    const sandbox = {
        chrome: {
            storage: { local, onChanged: { addListener: (fn) => changedListeners.push(fn) } },
            alarms: {
                create: (name, info) => { alarms[name] = { ...info }; },
                clear: (name) => { delete alarms[name]; },
                onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
            },
            runtime: {
                onInstalled: { addListener: () => {} },
                onStartup: { addListener: () => {} },
            },
        },
        fetch: (url, options) => {
            if (url.startsWith(USERDATA_URL)) {
                state.reads += 1;
                if (state.userdataStatus) {
                    return Promise.resolve({
                        ok: false, status: state.userdataStatus,
                        headers: { get: () => null },
                        json: async () => ({}),
                    });
                }
                return Promise.resolve({
                    ok: true, status: 200,
                    json: async () => ({ rgIgnoredApps: state.ignoredApps, rgWishlist: [], rgOwnedApps: [] }),
                });
            }
            if (url.startsWith(ACCOUNT_URL)) {
                // `accountFails` is the network being down, which the login
                // check must report apart from a logout (see the offline test).
                if (state.accountFails()) return Promise.reject(new Error('offline'));
                return Promise.resolve({
                    ok: true, status: 200,
                    url: opts.loggedIn === false ? ACCOUNT_URL + 'login/' : url,
                });
            }
            if (url.startsWith(APPDETAILS_URL)) {
                const appid = (url.match(/appids=(\d+)/) || [])[1];
                return Promise.resolve({
                    ok: true, status: 200,
                    json: async () => ({
                        [appid]: state.unavailableApps.includes(appid)
                            ? { success: false }
                            : { success: true, data: {} },
                    }),
                });
            }
            if (url === IGNORE_URL) {
                const body = parseBody(options.body);
                posts.push(body);
                const r = state.postResult(body);
                return Promise.resolve({
                    ok: r.ok, status: r.status,
                    headers: { get: () => r.retryAfter || null },
                    json: async () => ({ success: r.ok }),
                });
            }
            return Promise.reject(new Error('unexpected fetch: ' + url));
        },
        setTimeout, clearTimeout, setInterval, clearInterval,
        AbortController, URLSearchParams,
        Promise, Date, Math, JSON, Object, Array, String, Number, Set, parseInt,
    };
    sandbox.self = sandbox;
    vm.createContext(sandbox);

    // importScripts resolves siblings of src/background.js.
    sandbox.importScripts = (...files) => {
        for (const f of files) {
            const p = path.join(__dirname, '..', '..', 'src', f);
            vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: f });
        }
    };
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'background.js'), 'utf8');
    vm.runInContext(code, sandbox, { filename: 'background.js' });

    const until = async (cond, ms) => {
        const deadline = Date.now() + (ms || 8000);
        while (Date.now() < deadline) {
            if (cond()) return;
            await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error('condition not met within ' + (ms || 8000) + ' ms');
    };

    return {
        data: () => data,
        posts,
        alarms,
        state,
        until,
        // External write that behaves like another context's chrome.storage.set.
        write: (obj) => new Promise((r) => local.set(obj, r)),
        // Silent mutation (no onChanged) — isolates the alarm-handler path.
        poke: (obj) => Object.assign(data, obj),
        fireAlarm: (name) => alarmListeners.forEach((fn) => fn({ name })),
        settle: (ms) => new Promise((r) => setTimeout(r, ms || 600)),
        // The worker's modules, and one more of src/ run into it (a popup
        // module standing in for the popup).
        ILAP: sandbox.ILAP,
        load: (file) => sandbox.importScripts(file),
    };
}

const job = (over) => ({
    id: 'j1', curatorId: 'c1', status: 'pending',
    appids: ['10', '11'], total: 2, ...(over || {}),
});

// The ignore log as storage keeps it: chunks of 100, oldest first.
const logKeys = (entries) => {
    const out = {};
    let seq = 0;
    for (let i = 0; i < entries.length; i += 100) out['ilap_ignore_log_c' + seq++] = entries.slice(i, i + 100);
    out.ilap_ignore_log_index = { first: 0, last: Math.max(0, seq - 1) };
    return out;
};

test.describe('SW drain host (unit)', () => {

    test('drains a queued job with the cached sessionid; alarm cleared when done', async () => {
        const env = loadBackground({
            ilap_master_enabled: true,
            ilap_sw_sid: 'sess-1',
            ilap_curator_queue: [job()],
        });
        await env.until(() => (env.data().ilap_curator_queue || []).length === 0, 15000);
        expect(env.posts.map((p) => p.appid)).toEqual(['10', '11']);
        expect(env.posts[0].sessionid).toBe('sess-1');
        expect(env.posts[0].ignore_reason).toBe('0');
        // The drained ignores landed in the undo log, attributed to the curator.
        expect(logFromStorage(env.data()).map((e) => e.appid)).toEqual(['10', '11']);
        expect(logFromStorage(env.data())[0].curatorId).toBe('c1');
        // …and in the popup's total, through the SW's count-only shim. Its games
        // stay out of the history, and the finished job lands there as one entry,
        // written after the queue empties.
        expect(env.data().ilap_ignored_count).toBe(2);
        await env.until(() => !!env.data().ilap_ignored_history);
        expect(env.data().ilap_ignored_history).toEqual([{ name: 'c1', source: 'Curator', filter: '', jobId: 'j1' }]);
        expect(env.data().ilap_last_ignored_name).toBe('c1');
        // Queue empty → no retry alarm left behind, cursor key removed.
        await env.until(() => !env.alarms[ALARM]);
        expect(env.data().ilap_curator_cursor_j1).toBeUndefined();
    });

    test('an MI job drains through the SW: per-entry reason, Last-Ignored stats, source:mi log', async () => {
        // A deferred manual swipe (type:'mi') inherited by the SW must POST with
        // the entry's own reason (0 default / 2 played-elsewhere), stamp Last
        // Ignored via the SW stats shim, and log the ignore attributed to MI with
        // its name — none of which curator/undo drains do.
        const env = loadBackground({
            ilap_master_enabled: true,
            ilap_sw_sid: 'sess-1',
            ilap_curator_queue: [{
                id: 'job_mi', curatorId: 'mi', type: 'mi', status: 'pending',
                appids: ['10', '11'], total: 2,
                meta: {
                    // Alpha's name has a control char + a whitespace run: the
                    // SW's stats shim normalizes through the shared sanitizer
                    // (escape.js), not a reduced local copy of it.
                    10: { name: 'Al' + String.fromCharCode(0) + 'pha   One', reason: 0 },
                    11: { name: 'Beta', reason: 2 },
                },
            }],
        });
        await env.until(() => (env.data().ilap_curator_queue || []).length === 0, 15000);
        expect(env.posts.map((p) => [p.appid, p.ignore_reason])).toEqual([['10', '0'], ['11', '2']]);
        // Last Ignored, count and history written by the SW stats shim.
        expect(env.data().ilap_last_ignored_name).toBe('Beta');
        expect(env.data().ilap_ignored_count).toBe(2);
        expect(env.data().ilap_ignored_history.map((h) => h.name)).toEqual(['Beta', 'Al pha One']);
        // Undo log attributes them to MI (name + source), not curator.
        expect(logFromStorage(env.data()).map((e) => [e.appid, e.source, e.name || null])).toEqual([
            ['10', 'mi', 'Al pha One'], ['11', 'mi', 'Beta'],
        ]);
    });

    test('an undo job drains through the SW: remove=1 POSTs and the total comes back down', async () => {
        // The mirror of the first test's count-only shim: a confirmed rollback
        // takes its ignore out of the popup's total (dropCount → uncountState)
        // and, like a curator job, lands in the history as one entry.
        const env = loadBackground({
            ilap_master_enabled: true,
            ilap_sw_sid: 'sess-1',
            ilap_ignored_count: 5,
            ilap_curator_queue: [{
                id: 'job_undo_1', curatorId: 'undo', type: 'undo', status: 'pending',
                appids: ['10', '11'], total: 2, snapshotTs: Date.now(),
            }],
        }, { ignoredApps: { 10: 1, 11: 1 } });   // both still ignored → both roll back
        await env.until(() => (env.data().ilap_curator_queue || []).length === 0, 15000);
        expect(env.posts.map((p) => [p.appid, p.remove])).toEqual([['10', '1'], ['11', '1']]);
        expect(env.data().ilap_ignored_count).toBe(3);
        await env.until(() => !!env.data().ilap_ignored_history);
        expect(env.data().ilap_ignored_history).toEqual([{ name: 'undo', source: 'Undo', jobId: 'job_undo_1' }]);
    });

    test('a session-less route drains nothing, spends nothing, and keeps re-asking', async () => {
        // The gate refuses every slot without a session, so a pass could only
        // reach that refusal after taking a lease and spending a userdata GET.
        // The drainer asks the gate's verdict BEFORE opening a pass, so neither
        // is spent — but the alarm stays armed, because a sign-in does not
        // reliably write anything this worker listens for (see the logout test
        // below). The sid write asserted at the end is the fast path, not the
        // only one.
        const env = loadBackground({
            ilap_master_enabled: true,
            ilap_curator_queue: [job()],
        });
        await env.settle();
        expect(env.posts).toEqual([]);
        expect(env.data().ilap_curator_queue).toHaveLength(1);
        expect(env.alarms[ALARM]).toBeDefined();
        // No lease was taken and no cursor written: the pass stopped before both.
        expect(env.data().ilap_curator_lock_c1).toBeUndefined();
        expect(env.data().ilap_curator_cursor_j1).toBeUndefined();

        // The content script's page-boot sid cache revives it through onChanged.
        await env.write({ ilap_sw_sid: 'sess-1' });
        await env.until(() => (env.data().ilap_curator_queue || []).length === 0, 15000);
        expect(env.posts.map((p) => p.appid)).toEqual(['10', '11']);
    });

    test('master off stops the pass without a userdata read or a retry alarm', async () => {
        const env = loadBackground({
            ilap_master_enabled: false,
            ilap_sw_sid: 'sess-1',
            ilap_curator_queue: [job()],
        });
        await env.settle();
        expect(env.posts).toEqual([]);
        expect(env.alarms[ALARM]).toBeUndefined();
        expect(env.data().ilap_curator_queue).toHaveLength(1);

        // Re-enabling the master is an onChanged write the drainer listens for.
        await env.write({ ilap_master_enabled: true });
        await env.until(() => (env.data().ilap_curator_queue || []).length === 0, 15000);
        expect(env.posts.map((p) => p.appid)).toEqual(['10', '11']);
    });

    test('two consecutive failed POSTs halt the SW route before any appid is burned; a fresh sid revives it', async () => {
        const env = loadBackground({
            ilap_master_enabled: true,
            ilap_sw_sid: 'stale',
            ilap_curator_queue: [job()],
        }, { postResult: () => ({ ok: false, status: 400 }) });

        await env.until(() => env.data().ilap_sw_halt === true, 15000);
        await env.settle(); // let the stopped pass unwind fully
        // Exactly the two probing failures — the halt engaged before MAX_FAILS
        // (3) could skip the appid, so the cursor never moved.
        expect(env.posts).toHaveLength(2);
        expect(env.posts.every((p) => p.appid === '10')).toBe(true);
        expect(env.data().ilap_curator_cursor_j1 || 0).toBe(0);
        expect(env.data().ilap_curator_queue).toHaveLength(1);

        // The content script's page-boot cache: new sid, halt cleared → the
        // onChanged kick resumes and the job completes.
        env.state.postResult = () => ({ ok: true, status: 200 });
        await env.write({ ilap_sw_sid: 'fresh', ilap_sw_halt: false });
        await env.until(() => (env.data().ilap_curator_queue || []).length === 0, 15000);
        const after = env.posts.slice(2);
        expect(after.map((p) => p.appid)).toEqual(['10', '11']);
        expect(after.every((p) => p.sessionid === 'fresh')).toBe(true);
    });

    test('a region-locked 400 is skipped in one attempt without halting; the rest of the queue drains', async () => {
        // Phase 3.1: appid '480' 400s permanently (no store object in the
        // account's region — the appdetails probe answers success:false), so
        // the SW must classify it per-appid: skip it after ONE POST, keep the
        // halt counter untouched (two adjacent region locks used to false-halt
        // the whole route), record it in the log and finish the job honestly.
        const env = loadBackground({
            ilap_master_enabled: true,
            ilap_sw_sid: 'sess-1',
            ilap_curator_queue: [job({ appids: ['480', '292030', '11'], total: 3 })],
        }, {
            postResult: (p) => (p.appid === '480' || p.appid === '292030')
                ? { ok: false, status: 400 }
                : { ok: true, status: 200 },
            unavailableApps: ['480', '292030'],
        });
        await env.until(() => (env.data().ilap_curator_queue || []).length === 0, 15000);
        // One attempt per region-locked appid — no MAX_FAILS retries, and two
        // ADJACENT locks did not halt the route.
        expect(env.posts.map((p) => p.appid)).toEqual(['480', '292030', '11']);
        expect(env.data().ilap_sw_halt).toBeFalsy();
        // The log keeps the honest record: two skipped markers, one real ignore.
        expect(logFromStorage(env.data()).map((e) => [e.appid, e.skipped || null])).toEqual([
            ['480', 'unavailable'], ['292030', 'unavailable'], ['11', null],
        ]);
        // The per-job skip counter is cleaned up with the finished job
        // (removeJob's key removal lands just after the queue write, so poll).
        await env.until(() => env.data().ilap_curator_skipped_j1 === undefined);
        await env.until(() => !env.alarms[ALARM]);
    });

    test('a long 429 penalty is not slept through: no slot claimed, alarm lands at the penalty end', async () => {
        const until = Date.now() + 120000;
        const env = loadBackground({
            ilap_master_enabled: true,
            ilap_sw_sid: 'sess-1',
            ilap_curator_queue: [job()],
            ilap_ignore_gate_penalty: { until, level: 1 },
        });
        await env.until(() => !!env.alarms[ALARM]);
        await env.settle();
        expect(env.posts).toEqual([]);
        expect(env.alarms[ALARM].when).toBeGreaterThanOrEqual(until);
        // The backoff pre-check refused WITHOUT claiming a gate slot.
        expect(env.data().ilap_ignore_gate).toBeUndefined();
    });

    test('the backoff pre-check counts the slower gap while the user browses', async () => {
        // A last slot 18 s out: one plain gap still fits the 20 s budget, the
        // 3 s gap of an active user does not, and a curator job takes that one.
        const last = Date.now() + 18000;
        const env = loadBackground({
            ilap_master_enabled: true,
            ilap_sw_sid: 'sess-1',
            ilap_curator_queue: [job()],
            ilap_ignore_gate: last,
            ilap_user_active_at: Date.now(),
        });
        await env.until(() => !!env.alarms[ALARM]);
        await env.settle();
        expect(env.posts).toEqual([]);
        expect(env.data().ilap_ignore_gate).toBe(last);
    });

    test('the alarm handler kicks a drain pass', async () => {
        const until = Date.now() + 120000;
        const env = loadBackground({
            ilap_master_enabled: true,
            ilap_sw_sid: 'sess-1',
            ilap_curator_queue: [job({ appids: ['10'], total: 1 })],
            ilap_ignore_gate_penalty: { until, level: 1 },
        });
        await env.until(() => !!env.alarms[ALARM]);
        await env.settle();
        expect(env.posts).toEqual([]);
        // Penalty gone (silently, so only the alarm can wake the drain) → fire it.
        env.poke({ ilap_ignore_gate_penalty: null });
        env.fireAlarm(ALARM);
        await env.until(() => (env.data().ilap_curator_queue || []).length === 0, 15000);
        expect(env.posts.map((p) => p.appid)).toEqual(['10']);
    });

    test('a halted route keeps ONE slow alarm, and firing it is the retry', async () => {
        // The sibling of the test above, for the stop that DOES write storage.
        // The halt counter cannot tell a sessionid no page has refreshed from a
        // connection that was down for twenty seconds — both arrive as a failed
        // POST — so it fails closed on both. Clearing the alarm as well used to
        // make "closed" mean "until the user opens a store page", which with no
        // tab open is "never": the queue sat there silently. One hourly retry
        // costs at most two refused POSTs and cannot burn an appid (the halt
        // engages below MAX_FAILS).
        let offline = true;
        const env = loadBackground({
            ilap_master_enabled: true,
            ilap_sw_sid: 'sess-1',
            ilap_curator_queue: [job()],
        }, { postResult: () => (offline ? { ok: false, status: 0 } : { ok: true, status: 200 }) });

        await env.until(() => env.data().ilap_sw_halt === true, 15000);
        await env.settle();
        expect(env.posts).toHaveLength(2);           // halted before MAX_FAILS
        expect(env.data().ilap_curator_cursor_j1 || 0).toBe(0);

        // Armed, and far out: this is the slow retry, not the 60 s standby one.
        expect(env.alarms[ALARM], 'a halted route with work left must keep an alarm').toBeDefined();
        expect(env.alarms[ALARM].when).toBeGreaterThan(Date.now() + 30 * 60 * 1000);

        // The connection is back, and nothing wrote storage to say so. Firing the
        // alarm clears the halt, and the write it makes is what kicks the pass.
        offline = false;
        env.fireAlarm(ALARM);
        await env.until(() => env.data().ilap_sw_halt === false, 10000);
        await env.until(() => (env.data().ilap_curator_queue || []).length === 0, 15000);
        expect(env.posts.slice(2).map((p) => p.appid)).toEqual(['10', '11']);
    });

    test('a retry that still fails re-halts and arms the next hour', async () => {
        // The other half of the hourly retry. If the cause was permanent — a
        // sessionid no page has refreshed, Steam withdrawing the CORS echo the
        // worker's fetch rests on — clearing the flag must cost at most two more
        // refused POSTs and put the route back to sleep. Not stay awake retrying,
        // and not end up awake with no alarm at all.
        const env = loadBackground({
            ilap_master_enabled: true,
            ilap_sw_sid: 'stale',
            ilap_curator_queue: [job()],
        }, { postResult: () => ({ ok: false, status: 0 }) });

        await env.until(() => env.data().ilap_sw_halt === true, 15000);
        await env.settle();
        expect(env.posts).toHaveLength(2);           // halted below MAX_FAILS
        expect(env.alarms[ALARM]).toBeDefined();

        env.fireAlarm(ALARM);
        // Cleared, spent on two more refusals, halted again.
        await env.until(() => env.data().ilap_sw_halt === false, 10000);
        await env.until(() => env.data().ilap_sw_halt === true, 15000);
        await env.settle();
        expect(env.posts).toHaveLength(4);           // two per retry, never more
        expect(env.data().ilap_curator_cursor_j1 || 0).toBe(0);   // no appid burned
        expect(env.alarms[ALARM], 're-halted with work left must re-arm').toBeDefined();
        expect(env.alarms[ALARM].when).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
    });

    test('an unreachable login probe keeps the retry alarm — the drain is not stranded by a blip', async () => {
        // The one stop this worker parks on recovers through a storage write it
        // already listens for: 'disabled' → ilap_master_enabled. A NETWORK
        // outage has no such write — nothing fires onChanged when the connection
        // returns — so dropping the alarm on it would strand the drain until a
        // store tab happened to open, which is precisely the case this worker
        // exists to cover. The alarm stays armed and re-asks.
        let offline = true;
        const env = loadBackground({
            ilap_master_enabled: true,
            ilap_sw_sid: 'sess-1',
            ilap_curator_queue: [job()],
        }, { accountFails: () => offline });

        // Refused, but still scheduled to re-ask.
        await env.until(() => !!env.alarms[ALARM]);
        await env.settle();
        expect(env.posts).toEqual([]);
        expect(env.data().ilap_curator_cursor_j1).toBeUndefined();

        // Connection back — and nothing wrote storage to say so. The alarm is
        // the only thing that can notice, and it does.
        offline = false;
        env.fireAlarm(ALARM);
        await env.until(() => (env.data().ilap_curator_queue || []).length === 0, 15000);
        expect(env.posts.map((p) => p.appid)).toEqual(['10', '11']);
    });

    test('a confirmed logout keeps it too — a sign-in need not write storage', async () => {
        // The tempting shortcut is to park on 'no-session' because signing in
        // refreshes ilap_sw_sid. It does not, reliably: that write is
        // change-only (curator/drainer.js), and the verdict is a live probe now
        // rather than "is a sessionid cached" — so a session that comes back
        // under the SAME sessionid produces no write, no onChanged, no kick.
        // Only the master toggle is a stop this worker can be woken from.
        const env = loadBackground({
            ilap_master_enabled: true,
            ilap_sw_sid: 'sess-1',
            ilap_curator_queue: [job()],
        }, { loggedIn: false });
        await env.settle();
        expect(env.posts).toEqual([]);
        expect(env.alarms[ALARM]).toBeDefined();
        // ...and the master toggle still is: that one parks the alarm outright
        // (asserted by the master-off test above).
    });

    test('a live foreign lease is respected: no steal, no POST, alarm re-armed', async () => {
        const env = loadBackground({
            ilap_master_enabled: true,
            ilap_sw_sid: 'sess-1',
            ilap_curator_queue: [job()],
            ilap_curator_lock_c1: { owner: 'tab-1', expiresAt: Date.now() + 60000 },
        });
        await env.until(() => !!env.alarms[ALARM]);
        await env.settle();
        expect(env.posts).toEqual([]);
        expect(env.data().ilap_curator_lock_c1.owner).toBe('tab-1');
    });
});

// Rolling back thousands of games takes hours, and the user goes on using
// Steam meanwhile: pauses the job, ignores other games, drops it and stages it
// again. The real worker, through what happens to such a job.
// A pass that stopped with the job still queued waits for what stopped it. A
// worker back every MIN_PASS_GAP_MS spends one full userdata read each time.
test.describe('SW drain host: an all-empty read (unit)', () => {
    test('with a total read lately no entry of an automated job goes out', async () => {
        const env = loadBackground({
            ilap_master_enabled: true, ilap_sw_sid: 'sess-1',
            ilap_ignored_total: { total: 20, tallyAt: 0, ts: Date.now() },
            ilap_curator_queue: [{ id: 'j1', type: 'preset', curatorId: 'preset_x', presetKey: 'x', presetRev: 'r',
                status: 'pending', appids: ['10'], total: 1 }],
        });
        await env.settle(1500);
        expect(env.state.reads).toBe(1);
        expect(env.posts).toEqual([]);
    });
});

test.describe('SW drain host: a stopped pass stays stopped (unit)', () => {
    const preset = () => ({ id: 'j1', type: 'preset', curatorId: 'preset_x', presetKey: 'x', presetRev: 'r',
        status: 'pending', appids: ['10', '11'], total: 2 });

    test('under a long 429 penalty it reads nothing and the alarm waits for the penalty', async () => {
        const until = Date.now() + 200000;
        const env = loadBackground({
            ilap_master_enabled: true, ilap_sw_sid: 'sess-1',
            ilap_curator_queue: [preset()],
            ilap_ignore_gate_penalty: { until, level: 5 },
        });
        await env.settle(5000);
        expect(env.state.reads).toBe(0);
        expect(env.posts).toEqual([]);
        expect(env.alarms[ALARM].when).toBeGreaterThanOrEqual(until);
        expect(env.data().ilap_curator_lock_preset_x).toBeUndefined();
    });

    test('a 429 on the read itself raises the penalty, and the read is not asked again', async () => {
        const env = loadBackground({
            ilap_master_enabled: true, ilap_sw_sid: 'sess-1', ilap_curator_queue: [preset()],
        }, { userdataStatus: 429 });
        await env.settle(4000);
        expect(env.state.reads).toBe(1);
        expect(env.posts).toEqual([]);
        expect(env.data().ilap_ignore_gate_penalty.level).toBe(1);
    });

    test('a read that failed some other way is tried again no sooner than a standby tick', async () => {
        const env = loadBackground({
            ilap_master_enabled: true, ilap_sw_sid: 'sess-1', ilap_curator_queue: [preset()],
        }, { userdataStatus: 500 });
        await env.settle(5000);
        expect(env.state.reads).toBe(1);
        expect(env.posts).toEqual([]);
    });

    test('a visible run in a tab costs no reads while its stamp is fresh', async () => {
        const env = loadBackground({
            ilap_master_enabled: true, ilap_sw_sid: 'sess-1', ilap_curator_queue: [preset()],
            ilap_ignore_foreground_at: Date.now(),
        });
        const stamp = setInterval(() => env.poke({ ilap_ignore_foreground_at: Date.now() }), 500);
        await env.settle(4000);
        clearInterval(stamp);
        expect(env.state.reads).toBe(0);
        expect(env.posts).toEqual([]);
    });
});

test.describe('SW drain host — a long undo job (unit)', () => {
    const DAY = 24 * 3600 * 1000;
    const UNDO_ID = 'job_undo_1';
    // Steam's list follows every POST, as the live account's does.
    const steam = (ref) => (body) => {
        const apps = ref.env.state.ignoredApps;
        if (body.remove === '1') delete apps[body.appid];
        else apps[body.appid] = Number(body.ignore_reason || 0);
        return { ok: true, status: 200 };
    };
    // A game the user ignores elsewhere: Steam's list and the log gain it. The
    // append goes past the drainer's hooks, as a tab's does, and reaches them
    // as onChanged.
    const ignoreElsewhere = (env, appid) => {
        env.state.ignoredApps[appid] = 0;
        return env.ILAP.IgnoreLog.append({ appid, source: 'mi' });
    };
    // Pause and Resume, written as the popup writes them.
    const setStatus = (env, status) => env.write({
        ilap_curator_queue: env.data().ilap_curator_queue.map(j => (j.id === UNDO_ID ? { ...j, status } : j)),
    });
    const rolledBack = (env) => env.posts.filter(p => p.remove === '1').map(p => p.appid);
    const live = (env, appid) => logFromStorage(env.data()).some(e => e.appid === appid && !e.undoneAt && !e.skipped);
    const drained = (env) => env.until(() => (env.data().ilap_curator_queue || []).length === 0, 30000);

    // Six games the worker ignored a day ago, and the job that rolls them back, newest first.
    const GAMES = ['1', '2', '3', '4', '5', '6'];
    function start(over) {
        const ref = {};
        const old = Date.now() - DAY;
        ref.env = loadBackground({
            ilap_master_enabled: true,
            ilap_sw_sid: 'sess-1',
            ...logKeys(GAMES.map((appid, i) => ({ appid, ts: old + i, source: 'curator', curatorId: 'c1' }))),
            ilap_curator_queue: [{
                id: UNDO_ID, curatorId: 'undo', type: 'undo', status: 'pending',
                appids: [...GAMES].reverse(), total: GAMES.length, snapshotTs: Date.now(), ...(over || {}),
            }],
        }, { ignoredApps: Object.fromEntries(GAMES.map(a => [a, 0])), postResult: steam(ref) });
        return ref.env;
    }

    test('paused, with games ignored meanwhile and one of its own ignored again, it resumes on the rest only', async () => {
        const env = start();
        await env.until(() => rolledBack(env).length >= 2, 15000);
        await setStatus(env, 'paused');
        await env.settle(1500);
        const sent = rolledBack(env).length;
        // While it waits, the game it would roll back next is ignored again, and a new one.
        const next = [...GAMES].reverse()[sent];
        await ignoreElsewhere(env, next);
        await ignoreElsewhere(env, '99');
        await env.settle(1500);
        expect(rolledBack(env)).toHaveLength(sent);   // the pause holds

        await setStatus(env, 'pending');
        await drained(env);
        // Each game once, and the one ignored again never: the later intent wins.
        const posts = rolledBack(env);
        expect(new Set(posts).size).toBe(posts.length);
        expect([...posts].sort()).toEqual(GAMES.filter(a => a !== next).sort());
        expect(Object.keys(env.state.ignoredApps).sort()).toEqual([next, '99'].sort());
        // The log agrees: the two ignored meanwhile are undoable, the rest rolled back.
        for (const a of GAMES) expect(live(env, a), a).toBe(a === next);
        expect(live(env, '99')).toBe(true);
    });

    test('removed midway and staged again, it rolls back only what is left, a game ignored since included', async () => {
        const env = start();
        await env.until(() => rolledBack(env).length >= 2, 15000);
        await env.ILAP.Curator.Store.removeJob(UNDO_ID);
        await env.settle(1500);
        const sent = rolledBack(env).length;
        expect(env.data()['ilap_curator_cursor_' + UNDO_ID]).toBeUndefined();

        await ignoreElsewhere(env, '7');
        env.load('undo-service.js');
        const Store = env.ILAP.Curator.Store;
        const service = new env.ILAP.UndoService({ store: Store, log: env.ILAP.IgnoreLog, maxJobs: Store.MAX_JOBS });
        const staged = await service.stageLastN(100);
        expect(staged).toEqual({ kind: 'added', total: GAMES.length - sent + 1 });
        await drained(env);

        // Nothing rolled back twice, nothing left on Steam's list or live in the log.
        const posts = rolledBack(env);
        expect(new Set(posts).size).toBe(posts.length);
        expect([...posts].sort()).toEqual([...GAMES, '7'].sort());
        expect(env.state.ignoredApps).toEqual({});
        for (const a of [...GAMES, '7']) expect(live(env, a), a).toBe(false);
    });

    test('at the log cap, ignores made while it waits push its games out of the log, and it still rolls them back', async () => {
        const env = start({ status: 'paused' });
        const cap = env.ILAP.IgnoreLog.LOG_CAP;
        const old = Date.now() - DAY;
        // A full log with the job's six games at its oldest end.
        const full = GAMES.map((appid, i) => ({ appid, ts: old + i, source: 'curator', curatorId: 'c1' }))
            .concat(Array.from({ length: cap - GAMES.length }, (_, i) => ({ appid: String(100000 + i), ts: old + 10 + i, source: 'curator' })));
        env.poke(logKeys(full));
        // One more ignore opens a chunk and retires the oldest, the six with it.
        await ignoreElsewhere(env, '99');
        expect(env.data().ilap_ignore_log_c0).toBeUndefined();
        for (const a of GAMES) expect(logFromStorage(env.data()).some(e => e.appid === a), a).toBe(false);

        await setStatus(env, 'pending');
        await drained(env);
        expect(rolledBack(env)).toEqual([...GAMES].reverse());
        expect(env.state.ignoredApps).toEqual({ 99: 0 });
        expect(live(env, '99')).toBe(true);
    });
});
