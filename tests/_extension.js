// Shared helpers for any test that needs to talk to the extension itself
// (read/write chrome.storage.local, open chrome-extension:// pages).
//
// These rely on the test-flavor build (`node build.js --test`) which adds an
// empty MV3 service worker so context.serviceWorkers() exposes the extension.

async function getExtensionId(context) {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    // sw.url() looks like: chrome-extension://abcdef.../src/background-test.js
    return sw.url().split('/')[2];
}

async function getServiceWorker(context) {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    return sw;
}

// Write keys into chrome.storage.local. Pass a plain object: { ilap_q_master: false, ... }
async function setExtensionStorage(context, data) {
    const sw = await getServiceWorker(context);
    await sw.evaluate(
        (payload) => new Promise((resolve) => chrome.storage.local.set(payload, resolve)),
        data
    );
}

// Read keys from chrome.storage.local. Pass null for everything, an array for some,
// or an object with defaults. Returns the result object.
async function getExtensionStorage(context, keys = null) {
    const sw = await getServiceWorker(context);
    return sw.evaluate(
        (k) => new Promise((resolve) => chrome.storage.local.get(k, resolve)),
        keys
    );
}

async function clearExtensionStorage(context) {
    const sw = await getServiceWorker(context);
    await sw.evaluate(() => new Promise((resolve) => chrome.storage.local.clear(resolve)));
}

function popupUrl(extensionId) {
    return `chrome-extension://${extensionId}/ui/popup.html`;
}

module.exports = {
    getExtensionId,
    getServiceWorker,
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
    popupUrl,
};
