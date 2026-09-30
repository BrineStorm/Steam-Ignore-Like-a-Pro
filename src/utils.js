// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The content script's Steam session, ignore POST and stats writer. The
    // Steam reads live in steam-net.js, name resolution in game-name.js.

    const SessionService = {
        getID() {
            // The isolated world cannot see the page's g_sessionID: the cookie is
            // the only readable source.
            //
            // Anchored to a cookie boundary. Unanchored, the first cookie whose
            // NAME merely ENDS in "sessionid" wins — any *.steampowered.com
            // subdomain can set one, and it would land in the CSRF field of every
            // ignore POST, which Steam answers with a silent 400.
            const match = document.cookie.match(/(?:^|;\s*)sessionid=([^;]+)/);
            return match ? match[1] : null;
        }
    };

    class SessionStateService {
        set(key, value) { sessionStorage.setItem(key, value); }
        get(key) { return sessionStorage.getItem(key); }
        remove(key) { sessionStorage.removeItem(key); }
    }

    class ResourceService {
        getIconUrl(fileName) { return chrome.runtime.getURL(`./assets/icons/${fileName}`); }
    }

    const sanitizeName = window.ILAP.Sanitizer.sanitizeName;

    const Net = window.ILAP.SteamNet;
    const fetchWithTimeout = Net.fetchWithTimeout;

    // Lenient userdata read: an empty Set on failure, for callers where missing
    // data only disables an optimization (DQ confirmation). Never for undo.
    async function fetchIgnoredApps() {
        return (await Net.fetchIgnoredAppsStrict()) || new Set();
    }

    // Login state from two signals: the store header (free, but frozen at page
    // load) and a live probe (steam-net.js).
    const SteamAuth = {
        // true/false from the store header; null when the header isn't rendered
        // at all (unknown surface) → caller falls back to the live probe.
        isLoggedInDom() {
            if (document.querySelector('#account_pulldown, #global_actions .user_avatar')) return true;
            return document.getElementById('global_action_menu') ? false : null;
        },
        probeLogin: Net.probeLogin,
        // For the UI locks (widget launcher, curator button): the header when it
        // rendered, the live probe only without one. True only on a confirmed
        // session.
        async resolveLogin() {
            const dom = this.isLoggedInDom();
            if (dom !== null) return dom;
            return (await this.probeLogin()) === true;
        },
        // For the ignore side (rate gate, Manual-Ignore gestures): the header is
        // trusted only when it rendered signed-IN, since a page opened before
        // signing in elsewhere reads logged-out forever; anything else asks the
        // cached probe. true / false / null (could not ask).
        async hasLiveSession() {
            if (this.isLoggedInDom() === true) return true;
            return Net.probeLoginCached();
        }
    };

    // The ignore endpoint, this world's copy (see steam-net.js for why). Resolves
    //   { ok, rateLimited, retryAfterMs, status }
    // rateLimited: a 429, which throttles the account; callers report it to the
    // gate. status: 0 when the request never completed; the drainer's 400
    // classifier reads it.
    async function post(fields) {
        const sessionid = SessionService.getID();
        if (!sessionid) return Net.ignoreFailed();

        // Encoded per field, so no cookie value can break the body's structure.
        const body = new URLSearchParams(Object.assign({ sessionid }, fields)).toString();
        try {
            const response = await fetchWithTimeout(Net.IGNORE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                body: body
            });
            return Net.ignoreResult(response);
        } catch (e) { return Net.ignoreFailed(); }
    }

    const SteamAPI = {
        ignore(appid, reason) {
            return post(Net.ignoreFields(appid, reason));
        },

        // Paced through the gate like an ignore.
        unignore(appid) {
            return post(Net.unignoreFields(appid));
        }
    };

    // === Stats ===
    // The record's shape is stats.js's; only this read-modify-write is this world's.
    const StatsLogic = window.ILAP.StatsLogic;

    const StatsManager = {
        // One chain for every write to the record, so overlapping saves cannot
        // read the same count and lose an increment.
        _serial: window.ILAP.serialChain(),

        save(gameName, source) {
            const safeName = sanitizeName(gameName);
            return this._write((result) => StatsLogic.nextState(result, safeName, source));
        },

        // Counted but not shown: a drained curator ignore.
        bumpCount() {
            return this._write(StatsLogic.countState);
        },

        // The mirror, for a confirmed un-ignore.
        dropCount() {
            return this._write(StatsLogic.uncountState);
        },

        // Queue one read-modify-write; `next` maps the stored record to the write.
        _write(next) {
            if (!chrome?.storage?.local || !chrome?.runtime?.id) {
                console.warn("[ILAP] Extension context is inactive. Stats not saved.");
                return Promise.resolve();
            }
            return this._serial(() => this._commit(next)).catch(() => {});
        },

        _commit(next) {
            return new Promise(resolve => {
                try {
                    chrome.storage.local.get([StatsLogic.HISTORY_KEY, StatsLogic.COUNT_KEY], (result) => {
                        // Inside the callback as well, because the outer catch
                        // only covers the synchronous get() call. A throw in
                        // here — next() over a corrupt record, or set() on a
                        // context invalidated since the _write guard ran — would
                        // leave this promise forever pending, and _serial is a
                        // chain: every later stats write in this page would
                        // silently never run, the drainer's awaited saveStats
                        // among them (it would hang mid-job, draining latched).
                        try {
                            if (chrome.runtime.lastError) return resolve();
                            chrome.storage.local.set(next(result), resolve);
                        } catch (e) {
                            console.warn("[ILAP] Stats write failed:", e);
                            resolve();
                        }
                    });
                } catch (e) {
                    console.warn("[ILAP] Failed to access storage:", e);
                    resolve();
                }
            });
        }
    };

    // === Public Facade ===
    window.ILAP = window.ILAP || {};
    window.ILAP.getSessionID = SessionService.getID;
    window.ILAP.apiIgnoreGame = SteamAPI.ignore;
    window.ILAP.apiUnignoreGame = SteamAPI.unignore;
    window.ILAP.fetchIgnoredApps = fetchIgnoredApps;
    window.ILAP.fetchIgnoredAppsStrict = Net.fetchIgnoredAppsStrict;
    window.ILAP.classifyRefusal = Net.classifyRefusal;
    window.ILAP.SteamAuth = SteamAuth;
    window.ILAP.saveStats = (name, source) => StatsManager.save(name, source);
    window.ILAP.bumpIgnoredCount = () => StatsManager.bumpCount();
    window.ILAP.dropIgnoredCount = () => StatsManager.dropCount();
    window.ILAP.SessionStateService = SessionStateService;
    window.ILAP.ResourceService = ResourceService;
    window.ILAP.fetchWithTimeout = fetchWithTimeout;

})();