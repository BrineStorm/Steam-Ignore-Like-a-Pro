// Shared helpers for the Phase-2 curator ignore-queue E2E specs.
//
// The two Steam route stubs live in tests/_steam-routes.js — Manual Ignore
// needs the same pair now that a swipe drains through this very drainer.
const { interceptIgnoreApi, routeUserdata } = require('../_steam-routes.js');
const { getExtensionStorage } = require('../_extension.js');

// --- queue / log readers (both LIVE specs assert on these) ------------------

async function readQueue(context) {
    const res = await getExtensionStorage(context, 'ilap_curator_queue');
    return Array.isArray(res.ilap_curator_queue) ? res.ilap_curator_queue : [];
}

async function readLog(context) {
    const res = await getExtensionStorage(context, 'ilap_ignore_log');
    return Array.isArray(res.ilap_ignore_log) ? res.ilap_ignore_log : [];
}

// Newest log entry for an appid, or null (the log is oldest→newest).
function logEntry(log, appid) {
    return [...log].reverse().find(e => e && String(e.appid) === String(appid)) || null;
}

module.exports = { interceptIgnoreApi, routeUserdata, readQueue, readLog, logEntry };
