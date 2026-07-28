const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
        // Appids whose appdetails probe answers success:false (region-locked);
        // everything else probes available.
        unavailableApps: opts.unavailableApps || [],
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
                return Promise.resolve({
                    ok: true, status: 200,
                    json: async () => ({ rgIgnoredApps: state.ignoredApps }),
                });
            }
            if (url.startsWith(ACCOUNT_URL)) {
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
    };
}

const job = (over) => ({
    id: 'j1', curatorId: 'c1', status: 'pending',
    appids: ['10', '11'], total: 2, ...(over || {}),
});

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
        expect(env.data().ilap_ignore_log.map((e) => e.appid)).toEqual(['10', '11']);
        expect(env.data().ilap_ignore_log[0].curatorId).toBe('c1');
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
                    // Alpha's name carries a control char + a whitespace run: the
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
        expect(env.data().ilap_ignore_log.map((e) => [e.appid, e.source, e.name || null])).toEqual([
            ['10', 'mi', 'Al pha One'], ['11', 'mi', 'Beta'],
        ]);
    });

    test('a gate-stopped route (no sid / master off) drains nothing and schedules no wake-up', async () => {
        // The gate refuses every slot without a session or with the master off,
        // so a pass could only reach that refusal after taking a lease and
        // spending a userdata GET — and re-arming the alarm would repeat both
        // forever. The drainer now asks the gate's verdict BEFORE opening a
        // pass, and syncAlarm treats the stop like the halt flag: no alarm at
        // all. Both recovery writes (ilap_sw_sid, ilap_master_enabled) are in
        // the onChanged filter, so the route revives on a real change, not on a
        // poll — which the sid half asserts below.
        const env = loadBackground({
            ilap_master_enabled: true,
            ilap_curator_queue: [job()],
        });
        await env.settle();
        expect(env.posts).toEqual([]);
        expect(env.data().ilap_curator_queue).toHaveLength(1);
        expect(env.alarms[ALARM]).toBeUndefined();
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
        expect(env.data().ilap_ignore_log.map((e) => [e.appid, e.skipped || null])).toEqual([
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
