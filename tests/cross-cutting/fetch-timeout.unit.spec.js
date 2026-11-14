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
        // The last total, which an all-empty read is held against.
        chrome: { storage: { local: { get: (k, cb) => cb(loadIlap.storage || {}) } }, runtime: {} },
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

    test('the same read has the wishlist; a failed read is null, never an empty wishlist', async () => {
        const body = { rgIgnoredApps: { 10: 0 }, rgWishlist: [20, 30] };
        const ILAP = loadIlap(() => Promise.resolve({ ok: true, json: async () => body }));
        expect([...(await ILAP.fetchIgnoredAppsStrict()).wishlist]).toEqual(['20', '30']);
        expect([...(await ILAP.fetchWishlist())]).toEqual(['20', '30']);
        expect(await ILAP.isWishlisted(20)).toBe(true);
        expect(await ILAP.isWishlisted('10')).toBe(false);
        const down = loadIlap(() => Promise.resolve({ ok: false }));
        expect(await down.fetchWishlist()).toBe(null);
        expect(await down.isWishlisted(20)).toBe(null);
    });

    test('an answer with no wishlist reads as unknown, never as an empty one', async () => {
        // A Steam-side change of the shape must stop the automated ignores, not
        // let them take every wishlisted game.
        const ILAP = loadIlap(() => Promise.resolve({ ok: true, json: async () => ({ rgIgnoredApps: { 10: 0 } }) }));
        const strict = await ILAP.fetchIgnoredAppsStrict();
        expect([...strict.keys()]).toEqual(['10']);
        expect(strict.wishlist).toBe(null);
        expect(await ILAP.fetchWishlist()).toBe(null);
        expect(await ILAP.isWishlisted(20)).toBe(null);
    });

    test('an answer with no ignore list is a failed read, never an empty list', async () => {
        // The undo drainer takes "not in the map" for "already rolled back": a
        // renamed list read as empty would mark a whole undo job done with no POST.
        const read = (body) => loadIlap(() => Promise.resolve({ ok: true, json: async () => body }))
            .fetchIgnoredAppsStrict();
        for (const shape of [undefined, null, 0, '10']) {
            expect(await read({ rgIgnoredApps: shape, rgWishlist: [], rgOwnedApps: [1] })).toBe(null);
        }
        expect(await read({ rgWishlist: [], rgOwnedApps: [1] })).toBe(null);
        // An account with nothing ignored: Steam sends {} or [].
        expect((await read({ rgIgnoredApps: {}, rgWishlist: [], rgOwnedApps: [1] })).size).toBe(0);
        expect((await read({ rgIgnoredApps: [], rgWishlist: [], rgOwnedApps: [1] })).size).toBe(0);
        // The lenient read stays an empty Set on it.
        const lenient = loadIlap(() => Promise.resolve({ ok: true, json: async () => ({ rgWishlist: [] }) }));
        expect((await lenient.fetchIgnoredApps()).size).toBe(0);
    });

    test('the same read has the library; a missing list or a failed read is null, never an empty library', async () => {
        // A Steam-side change of the shape must stop the automated ignores, not
        // let them take every game the user owns.
        const read = (body) => loadIlap(() => Promise.resolve({ ok: true, json: async () => body }))
            .fetchIgnoredAppsStrict();
        expect([...(await read({ rgIgnoredApps: {}, rgWishlist: [], rgOwnedApps: [40, 50] })).owned]).toEqual(['40', '50']);
        expect((await read({ rgIgnoredApps: {}, rgWishlist: [], rgOwnedApps: [] })).owned.size).toBe(0);
        for (const shape of [undefined, null, {}, '40']) {
            const strict = await read({ rgIgnoredApps: { 10: 0 }, rgWishlist: [], rgOwnedApps: shape });
            expect(strict.owned).toBe(null);
            // The wishlist from the same answer is still read.
            expect(strict.wishlist.size).toBe(0);
        }
        const down = loadIlap(() => Promise.resolve({ ok: false }));
        expect(await down.fetchIgnoredAppsStrict()).toBe(null);
    });

    test('a 429 on a page\'s userdata read raises the shared penalty, whoever reads', async () => {
        // The swipe's reason read, the HIGH level's account read, the EQ and DQ
        // wishlist reads: none passes a hook of its own.
        const ILAP = loadIlap(() => Promise.resolve({ ok: false, status: 429, headers: { get: () => '7' } }));
        const penalties = [];
        ILAP.IgnoreGate = { reportRateLimited: async (ms) => { penalties.push(ms); } };
        expect(await ILAP.fetchIgnoredAppsStrict()).toBe(null);
        expect(await ILAP.fetchWishlist()).toBe(null);
        expect((await ILAP.fetchIgnoredApps()).size).toBe(0);
        expect(penalties).toEqual([7000, 7000, 7000]);
        // A caller with a hook of its own keeps it.
        const own = [];
        await ILAP.fetchIgnoredAppsStrict({ onRateLimited: async (ms) => { own.push(ms); } });
        expect(own).toEqual([7000]);
        expect(penalties.length).toBe(3);
    });

    test('the strict read keeps each game\'s ignore reason; the lenient one only the appids', async () => {
        // The MI dedupe compares reasons: a swipe with the other one is a change
        // of reason Steam accepts, not a duplicate.
        const body = { rgIgnoredApps: { 10: 0, 20: 2 } };
        const ILAP = loadIlap(() => Promise.resolve({ ok: true, json: async () => body }));
        const strict = await ILAP.fetchIgnoredAppsStrict();
        expect([...strict.entries()]).toEqual([['10', 0], ['20', 2]]);
        const lenient = await ILAP.fetchIgnoredApps();
        expect(lenient instanceof Set).toBe(true);
        expect([...lenient]).toEqual(['10', '20']);
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

// The ignore POST's form fields are data in steam-net.js, shared by the tab's POST
// (utils.js) and the worker's (background.js). A slip there breaks both worlds at
// once, so the exact bodies the tab sends are pinned here; background.unit pins
// the worker's.
test.describe('ignore POST fields (unit)', () => {
    function loadWithCookie(posts) {
        const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'utils.js'), 'utf8');
        const sandbox = {
            window: {}, console, AbortController, URLSearchParams, performance,
            document: { cookie: 'foo=1; sessionid=abc123' },
            fetch: async (url, opts) => { posts.push({ url, body: opts.body }); return { ok: true, status: 200 }; },
            setTimeout, clearTimeout, Date, Math, Object, Promise, Set, String, RegExp,
        };
        vm.createContext(sandbox);
        for (const f of ['escape.js', 'stats.js', 'steam-net.js']) {
            vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', f), 'utf8'), sandbox);
        }
        vm.runInContext(code, sandbox);
        return sandbox.window.ILAP;
    }

    // Steam's creator ignore answers JSON. What creatorResult makes of each
    // answer decides a drop for good, so every branch is pinned. Measured live,
    // a followed creator answers 400 with { success: { success: 2 } }.
    test('creatorResult: what each answer of the creator ignore reads as', async () => {
        const ILAP = loadWithCookie([]);
        const answer = (status, body, retryAfter) => ({
            ok: status >= 200 && status < 300, status,
            headers: { get: (h) => (h === 'Retry-After' ? retryAfter || null : null) },
            json: async () => { if (body === undefined) throw new SyntaxError('not JSON'); return body; },
        });
        const read = (...a) => ILAP.SteamNet.creatorResult(answer(...a));

        expect(await read(200, { success: 1 })).toMatchObject({ ok: true, rateLimited: false });
        expect(await read(200, { success: { success: 1 } })).toMatchObject({ ok: true });
        expect((await read(200, { success: 1 })).refused).toBeFalsy();
        // A 200 that does not say success, or no JSON at all, is a refusal.
        expect(await read(200, { success: 2 })).toMatchObject({ ok: false, refused: true, status: 200 });
        expect(await read(200, { success: { success: 15 } })).toMatchObject({ ok: false, refused: true });
        expect(await read(200, undefined)).toMatchObject({ ok: false, refused: true });
        // A 429 throttles the account and is never a refusal of the creator.
        const limited = await read(429, undefined, '7');
        expect(limited).toMatchObject({ ok: false, rateLimited: true, retryAfterMs: 7000 });
        expect(limited.refused).toBeFalsy();
        // Any other 4xx is a refusal, a 5xx is not (it is retried).
        expect(await read(400, undefined)).toMatchObject({ ok: false, refused: true, status: 400 });
        expect(await read(400, { success: { success: 2 } })).toMatchObject({ ok: false, refused: true, status: 400 });
        expect(await read(403, undefined)).toMatchObject({ ok: false, refused: true, status: 403 });
        const server = await read(502, undefined);
        expect(server).toMatchObject({ ok: false, rateLimited: false, status: 502 });
        expect(server.refused).toBeFalsy();
    });

    test('an ignore and its rollback send exactly the fields Steam expects', async () => {
        const posts = [];
        const ILAP = loadWithCookie(posts);
        await ILAP.apiIgnoreGame('620', 2);
        await ILAP.apiUnignoreGame('620');
        const fields = posts.map(p => Object.fromEntries(new URLSearchParams(p.body)));
        expect(posts.every(p => p.url === ILAP.SteamNet.IGNORE_URL)).toBe(true);
        expect(fields[0]).toEqual({ sessionid: 'abc123', appid: '620', snr: '', ignore_reason: '2' });
        expect(fields[1]).toEqual({ sessionid: 'abc123', appid: '620', snr: '1_account_notinterested_', remove: '1' });
    });
});

// What a store page's readers get from userdata: the wishlist guard must not
// take an anonymous answer for an account with nothing on its wishlist.
test.describe('the tab readers on an all-empty answer (unit)', () => {
    const empty = async () => ({ ok: true, json: async () => ({ rgIgnoredApps: {}, rgWishlist: [], rgOwnedApps: [] }) });
    const total = (t, ago = 0) => ({ ilap_ignored_total: { total: t, tallyAt: 0, ts: Date.now() - ago } });
    test.afterEach(() => { loadIlap.storage = null; });

    test('with a total read lately it is no read, for every reader', async () => {
        loadIlap.storage = total(20);
        const ILAP = loadIlap(empty);
        expect(await ILAP.fetchIgnoredAppsStrict()).toBe(null);
        expect(await ILAP.fetchWishlist()).toBe(null);
        expect(await ILAP.isWishlisted(10)).toBe(null);
        expect([...(await ILAP.fetchIgnoredApps())]).toEqual([]);
    });

    test('with no total, or one of nothing, it is what the account has', async () => {
        const none = await loadIlap(empty).fetchIgnoredAppsStrict();
        expect(none.size).toBe(0);
        expect(none.wishlist.size).toBe(0);
        loadIlap.storage = total(0);
        expect((await loadIlap(empty).fetchIgnoredAppsStrict()).size).toBe(0);
    });

    test('a read with anything in it never looks at the total', async () => {
        loadIlap.storage = total(20);
        const ILAP = loadIlap(async () => ({ ok: true, json: async () => ({ rgIgnoredApps: {}, rgWishlist: [5], rgOwnedApps: [] }) }));
        expect([...(await ILAP.fetchWishlist())]).toEqual(['5']);
    });
});
