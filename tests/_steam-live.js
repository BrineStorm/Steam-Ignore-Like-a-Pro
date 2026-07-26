// Authenticated Steam helpers for the LIVE specs — the ones that hit the real
// account with no network stubs (curator/drain-live.spec.js, curator/sw-live.spec.js).
//
// Every call here runs as a SAME-ORIGIN fetch inside a loaded store page
// (page.evaluate), exactly like the extension's own requests. A standalone
// `request.newContext({ storageState })` — and even the browser context's shared
// `context.request` — reads dynamicstore ANONYMOUSLY, which would make every
// userdata assertion pass vacuously; only a real page-context fetch carries the
// live session. So each of these takes a `page` that is already on a store page.

// { ids: string[], ownedCount } from live dynamicstore/userdata, or null.
function readUserdata(page) {
    return page.evaluate(async () => {
        try {
            const r = await fetch('/dynamicstore/userdata/?_=' + Date.now(),
                { credentials: 'include', headers: { Accept: 'application/json' } });
            if (!r.ok) return null;
            const j = await r.json();
            const ig = j && j.rgIgnoredApps;
            return {
                ids: ig ? Object.keys(ig).map(String) : [],
                ownedCount: (j.rgOwnedApps || []).length,
            };
        } catch (e) { return null; }
    });
}

// The page's CSRF sessionid (same value the extension reads from the cookie).
function readSid(page) {
    return page.evaluate(() => {
        const m = document.cookie.match(/(?:^|;\s*)sessionid=([^;]+)/);
        return (m && m[1]) || window.g_sessionID || null;
    });
}

// Ignore / un-ignore one appid from the page context (same endpoint; remove=1
// un-ignores). Used for deterministic test setup, NOT through the drainer.
function postIgnore(page, sid, appid, remove) {
    return page.evaluate(async ({ sid, appid, remove }) => {
        try {
            const fields = remove
                ? { sessionid: sid, appid: String(appid), snr: '1_account_notinterested_', remove: '1' }
                : { sessionid: sid, appid: String(appid), snr: '', ignore_reason: '0' };
            const r = await fetch('/recommended/ignorerecommendation/', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                body: new URLSearchParams(fields).toString(),
            });
            if (!r.ok) return false;
            const j = await r.json().catch(() => null);
            return !!(j && j.success);
        } catch (e) { return false; }
    }, { sid, appid, remove: !!remove });
}
const ignore = (page, sid, appid) => postIgnore(page, sid, appid, false);
const unignore = (page, sid, appid) => postIgnore(page, sid, appid, true);

// Poll live userdata (it lags an ignore/un-ignore POST by seconds) until the
// ignore-set satisfies `predicate`, or the timeout lapses. Last snapshot back.
async function pollUserdata(page, predicate, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await readUserdata(page);
        if (last && predicate(new Set(last.ids))) return last;
        await new Promise(r => setTimeout(r, 1000));
    }
    return last;
}

// Un-ignore an appid AND wait for the removal to reach userdata, so the
// drainer's dedupe read (which also lags the POST) won't still see it ignored
// and skip the POST with no log append. The whole point of the pre-clean is to
// force a real ignore, so the clean state must be visible before we seed.
async function ensureNotIgnored(page, sid, appid) {
    await unignore(page, sid, appid);
    await pollUserdata(page, ids => !ids.has(appid), 15000);
}

module.exports = {
    readUserdata,
    readSid,
    ignore,
    unignore,
    pollUserdata,
    ensureNotIgnored,
};
