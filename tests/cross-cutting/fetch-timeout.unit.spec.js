const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// fetchWithTimeout (src/steam-net.js, re-exported on the utils.js facade) as a
// Node unit — no browser. Every Steam fetch goes through it so a hung request
// fails like a network error instead of holding its caller forever (audit #3:
// e.g. the drainer's `draining` latch). Load the pair in vm with a
// signal-honouring fetch stub and drive the exported helper + the
// fetchIgnoredApps failure contract.

function loadIlap(fetchImpl, setTimeoutImpl) {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'utils.js'), 'utf8');
    const sandbox = {
        window: {},
        console,
        fetch: fetchImpl,
        AbortController,
        setTimeout: setTimeoutImpl || setTimeout, clearTimeout,
        Date, Math, Object, Promise, Set, String, RegExp,
    };
    vm.createContext(sandbox);
    // escape.js owns the shared string helpers (escapeHTML + sanitizeName) for
    // all three worlds, stats.js the Last-Ignored record shape for the two that
    // write it, steam-net.js the Steam reads for the two that fetch; all three
    // load before utils.js wherever it runs — the sandbox mirrors that.
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'escape.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'stats.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'steam-net.js'), 'utf8'), sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP;
}

// A fetch that never resolves but honours options.signal like the real one.
function hangingFetch(url, opts) {
    return new Promise((resolve, reject) => {
        if (opts && opts.signal) {
            opts.signal.addEventListener('abort', () => {
                const e = new Error('The operation was aborted');
                e.name = 'AbortError';
                reject(e);
            });
        }
    });
}

// A fetch that resolves at headers but whose body read (json) never settles —
// the "server sent headers then stalled the body" case. json() honours the
// same signal the real streaming body would.
function stalledBodyFetch(url, opts) {
    return Promise.resolve({
        ok: true,
        json: () => new Promise((resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
                const e = new Error('The operation was aborted');
                e.name = 'AbortError';
                reject(e);
            });
        })
    });
}

test.describe('fetchWithTimeout (unit)', () => {

    test('a hung request is aborted at the deadline (rejects, does not hang)', async () => {
        const ILAP = loadIlap(hangingFetch);
        await expect(ILAP.fetchWithTimeout('https://x/', {}, 50)).rejects.toThrow(/abort/i);
    });

    test('a fast response passes through untouched', async () => {
        const ILAP = loadIlap((url, opts) =>
            Promise.resolve({ ok: true, echoedSignal: !!(opts && opts.signal) }));
        const res = await ILAP.fetchWithTimeout('https://x/', {}, 50);
        expect(res.ok).toBe(true);
        expect(res.echoedSignal).toBe(true); // the deadline signal reached fetch
    });

    test('a stalled BODY hits the same deadline — res.json() rejects, does not hang', async () => {
        // Regression: the timer used to be cleared when fetch() resolved (at
        // HEADERS), leaving the body read unprotected forever.
        const ILAP = loadIlap(stalledBodyFetch);
        const res = await ILAP.fetchWithTimeout('https://x/', {}, 50);
        expect(res.ok).toBe(true);
        await expect(res.json()).rejects.toThrow(/abort/i);
    });

    test('fetchIgnoredApps resolves to an empty Set when the body stalls', async () => {
        // fetchIgnoredApps uses the default 10 s deadline — clamp the sandbox
        // setTimeout so the unit stays instant without touching the contract.
        const fastSetTimeout = (fn, ms) => setTimeout(fn, Math.min(ms || 0, 50));
        const ILAP = loadIlap(stalledBodyFetch, fastSetTimeout);
        const ignored = await ILAP.fetchIgnoredApps();
        expect(ignored instanceof Set).toBe(true);
        expect(ignored.size).toBe(0);
    });

    test('fetchIgnoredApps treats an abort like any failure — resolves to an empty Set', async () => {
        // The timeout surfaces as a thrown AbortError; the existing catch must
        // swallow it into the "nothing confirmed ignored yet" contract.
        const ILAP = loadIlap(() => {
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            return Promise.reject(e);
        });
        const ignored = await ILAP.fetchIgnoredApps();
        expect(ignored instanceof Set).toBe(true);
        expect(ignored.size).toBe(0);
    });
});
