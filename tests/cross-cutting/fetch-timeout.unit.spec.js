const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// fetchWithTimeout (src/utils.js) as a Node unit — no browser. Every Steam
// fetch goes through it so a hung request fails like a network error instead
// of holding its caller forever (audit #3: e.g. the drainer's `draining`
// latch). Load utils.js in vm with a signal-honouring fetch stub and drive
// the exported helper + the fetchIgnoredApps failure contract.

function loadIlap(fetchImpl) {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'utils.js'), 'utf8');
    const sandbox = {
        window: {},
        console,
        fetch: fetchImpl,
        AbortController,
        setTimeout, clearTimeout,
        Date, Math, Object, Promise, Set, String, RegExp,
    };
    vm.createContext(sandbox);
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
