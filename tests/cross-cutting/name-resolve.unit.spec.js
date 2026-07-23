const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// window.ILAP.resolveGameName (src/utils.js) — async name resolution: the five
// DOM strategies first, then the store's appdetails endpoint when they ALL miss
// (some React capsules — e.g. the front-page release-calendar carousel — carry
// no alt text, no title node, no name slug, so the DOM has nothing to extract).
// utils.js is loaded in Node (vm + a window stub, mirroring the sanitize-name
// unit) with fetch stubbed, so the fallback contract is asserted without a
// browser or Steam.
function loadILAP(fetchStub) {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'utils.js'),
        'utf8'
    );
    const sandbox = {
        window: {},
        document: { cookie: '', body: {} },
        fetch: fetchStub,
        AbortController,
        setTimeout,
        clearTimeout
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP;
}

// Counting fetch stub with a scripted response (or rejection).
function makeFetch(responder) {
    const calls = [];
    const stub = (url, options) => {
        calls.push(url);
        return responder(url, options);
    };
    stub.calls = calls;
    return stub;
}

const okJson = (payload) => Promise.resolve({ ok: true, json: async () => payload });

// A capsule whose title node the CssClassesStrategy finds — the DOM path hits.
function capsuleWithTitle(name) {
    const titleEl = { textContent: name };
    return {
        closest: () => null,
        parentElement: null,
        querySelector: () => titleEl,
        querySelectorAll: () => []
    };
}

// The bug shape: a bare <a href="/app/ID?snr=..."><img></a> React capsule —
// no alt, no title node, no href slug. Every DOM strategy misses.
function bareCapsule() {
    return {
        closest: () => null,
        parentElement: null,
        querySelector: () => null,
        querySelectorAll: () => []
    };
}

test.describe('resolveGameName — DOM first, appdetails fallback (unit)', () => {

    test('DOM name wins and appdetails is never called', async () => {
        const fetchStub = makeFetch(() => { throw new Error('must not fetch'); });
        const ILAP = loadILAP(fetchStub);

        const name = await ILAP.resolveGameName('111', capsuleWithTitle('Portal 2'));
        expect(name).toBe('Portal 2');
        expect(fetchStub.calls.length).toBe(0);
    });

    test('nameless capsule falls back to appdetails and sanitizes the name', async () => {
        const fetchStub = makeFetch(() =>
            okJson({ '3950130': { success: true, data: { name: 'Cool <Game>' } } })
        );
        const ILAP = loadILAP(fetchStub);

        const name = await ILAP.resolveGameName('3950130', bareCapsule());
        // Sanitized like every stored name — tag delimiters never survive.
        expect(name).toBe('Cool Game');
        expect(fetchStub.calls.length).toBe(1);
        expect(fetchStub.calls[0]).toContain('/api/appdetails');
        expect(fetchStub.calls[0]).toContain('appids=3950130');
    });

    test('appdetails success:false keeps the AppID fallback', async () => {
        const ILAP = loadILAP(makeFetch(() =>
            okJson({ '222': { success: false } })
        ));
        expect(await ILAP.resolveGameName('222', bareCapsule())).toBe('AppID 222');
    });

    test('non-ok response keeps the AppID fallback', async () => {
        const ILAP = loadILAP(makeFetch(() =>
            Promise.resolve({ ok: false, json: async () => ({}) })
        ));
        expect(await ILAP.resolveGameName('333', bareCapsule())).toBe('AppID 333');
    });

    test('network failure keeps the AppID fallback', async () => {
        const ILAP = loadILAP(makeFetch(() => Promise.reject(new Error('offline'))));
        expect(await ILAP.resolveGameName('444', bareCapsule())).toBe('AppID 444');
    });

    test('getGameName keeps its synchronous contract', () => {
        const ILAP = loadILAP(makeFetch(() => { throw new Error('must not fetch'); }));
        const name = ILAP.getGameName('555', bareCapsule());
        expect(typeof name).toBe('string');
        expect(name).toBe('AppID 555');
    });
});
