// Shared helpers for any test that needs to talk to the extension itself
// (read/write chrome.storage.local, open extension pages).
//
// Chromium: relies on the test-flavor build (`node build.js --test`) which
// adds an empty MV3 service worker so context.serviceWorkers() exposes the
// extension; storage calls are evaluated inside that worker.
//
// Firefox: has no service-worker handle, and a tab cannot be navigated to a
// moz-extension:// page (Firefox blocks top-level navigation to privileged
// extension pages). So there is no extension context to evaluate in directly.
// Instead the test-flavor build injects a content script
// (src/test-storage-bridge.js) that relays chrome.storage.local over
// window.postMessage; the helpers drive it from a store.steampowered.com
// "bridge tab" kept open per context. Because the bridge tab is never
// interacted with, its widget stays passive and never writes storage.

// A static store page carries the injected bridge content script without
// touching search history or recommendations, and renders the same whether or
// not the session is logged in.
const BRIDGE_URL = 'https://store.steampowered.com/about/';

function isFirefoxContext(context) {
    // Every helper here funnels through this check, so it is where a context
    // that never launched surfaces. Name that case: the bare property read threw
    // "Cannot read properties of null (reading '_ilapFirefoxUuid')" from inside
    // whichever storage helper ran first, which reads like a helper bug and
    // buries the real one — the per-test fixture timed out before handing over a
    // context (on Firefox: the RDP add-on install or the bridge-tab warm-up).
    if (!context) {
        throw new Error(
            'extension helper got no browser context — the test fixture failed to launch. '
            + 'On Firefox this is usually installTemporaryAddon or the bridge tab timing out; '
            + 'check the timeout of the hook that called this.'
        );
    }
    return !!context._ilapFirefoxUuid;
}

async function getExtensionId(context) {
    if (isFirefoxContext(context)) return context._ilapFirefoxUuid;
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    // sw.url() looks like: chrome-extension://abcdef.../src/background-test.js
    return sw.url().split('/')[2];
}

async function getServiceWorker(context) {
    if (isFirefoxContext(context)) {
        throw new Error('getServiceWorker is Chromium-only; Firefox has no extension SW handle');
    }
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    return sw;
}

// Round-trip one storage op through the Firefox bridge content script. The
// content script listens for a { __ilapStore: 'req' } message on the page and
// posts back a matching { __ilapStore: 'res' } once chrome.storage responds.
function bridgeRequest(page, msg) {
    return page.evaluate((m) => new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
        function onMsg(e) {
            const d = e.data;
            if (!d || d.__ilapStore !== 'res' || d.id !== id) return;
            window.removeEventListener('message', onMsg);
            clearTimeout(timer);
            d.error ? reject(new Error(d.error)) : resolve(d.result);
        }
        const timer = setTimeout(() => {
            window.removeEventListener('message', onMsg);
            reject(new Error('storage bridge timed out (content script not ready?)'));
        }, 8000);
        window.addEventListener('message', onMsg);
        window.postMessage(Object.assign({ __ilapStore: 'req', id }, m), '*');
    }), msg);
}

// Firefox storage transport: a store page opened once per context and reused,
// carrying the injected bridge content script. Created lazily AFTER the
// context's initial page exists, so it never becomes context.pages()[0] (the
// `page` fixture takes index 0). Cookies are already injected by the fixture,
// so the store page loads logged-in.
async function getBridgePage(context) {
    if (context._ilapBridgePage && !context._ilapBridgePage.isClosed()) {
        return context._ilapBridgePage;
    }
    const page = await context.newPage();
    await page.goto(BRIDGE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
    });
    // Wait until the bridge content script answers before returning, so the
    // first storage op doesn't race content-script injection.
    for (let i = 0; i < 40; i++) {
        try {
            await bridgeRequest(page, { op: 'get', keys: [] });
            context._ilapBridgePage = page;
            return page;
        } catch (e) {
            await page.waitForTimeout(250);
        }
    }
    throw new Error('Firefox storage bridge never became ready on the store tab');
}

// Write keys into chrome.storage.local. Pass a plain object: { ilap_q_master: false, ... }
async function setExtensionStorage(context, data) {
    if (isFirefoxContext(context)) {
        const page = await getBridgePage(context);
        await bridgeRequest(page, { op: 'set', payload: data });
        return;
    }
    const sw = await getServiceWorker(context);
    await sw.evaluate(
        (payload) => new Promise((resolve) => chrome.storage.local.set(payload, resolve)),
        data
    );
}

// Read keys from chrome.storage.local. Pass null for everything, an array for some,
// or an object with defaults. Returns the result object.
async function getExtensionStorage(context, keys = null) {
    if (isFirefoxContext(context)) {
        const page = await getBridgePage(context);
        return bridgeRequest(page, { op: 'get', keys });
    }
    const sw = await getServiceWorker(context);
    return sw.evaluate(
        (k) => new Promise((resolve) => chrome.storage.local.get(k, resolve)),
        keys
    );
}

async function clearExtensionStorage(context) {
    if (isFirefoxContext(context)) {
        const page = await getBridgePage(context);
        await bridgeRequest(page, { op: 'clear' });
        return;
    }
    const sw = await getServiceWorker(context);
    await sw.evaluate(() => new Promise((resolve) => chrome.storage.local.clear(resolve)));
}

function popupUrl(extensionId) {
    // Chromium IDs are 32 lowercase letters; the Firefox handle is a UUID.
    const scheme = extensionId.includes('-') ? 'moz-extension' : 'chrome-extension';
    return `${scheme}://${extensionId}/ui/popup.html`;
}

module.exports = {
    getExtensionId,
    getServiceWorker,
    getBridgePage,
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
    popupUrl,
};
