// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // === Shared Infrastructure ===

    const SessionService = {
        getID() {
            // Content scripts run in the isolated world, so the page's
            // window.g_sessionID is never visible here — the cookie is the only
            // readable source. (An earlier g_sessionID fast-path was dead code.)
            const match = document.cookie.match(/sessionid=([^;]+)/);
            return match ? match[1] : null;
        }
    };

    /**
     * Shared session storage wrapper to prevent duplication across modules.
     */
    class SessionStateService {
        set(key, value) { sessionStorage.setItem(key, value); }
        get(key) { return sessionStorage.getItem(key); }
        remove(key) { sessionStorage.removeItem(key); }
    }

    class ResourceService {
        getIconUrl(fileName) { return chrome.runtime.getURL(`./assets/icons/${fileName}`); }
    }

    // The storage-boundary name normalizer has ONE definition, in src/escape.js
    // (loaded before this file in the content world, and reachable from the
    // popup + service worker, which never load utils.js). Re-exported at the
    // bottom as window.ILAP.sanitizeName for this file's long-standing callers.
    const sanitizeName = window.ILAP.Sanitizer.sanitizeName;

    // The Steam network reads (deadline wrapper, userdata, login probe,
    // appdetails classifier) have ONE definition, in src/steam-net.js — the
    // content script and the service worker are the only worlds that talk to
    // Steam, and both load it. Re-exported on the facade below so no caller
    // changes; see the note at the top of that file for what deliberately
    // stays duplicated (the ignore POST).
    const Net = window.ILAP.SteamNet;
    const fetchWithTimeout = Net.fetchWithTimeout;

    // The lenient flavour of the userdata read stays here: it encodes CALLER
    // policy, not network behaviour — an empty Set on failure is right where
    // missing data only disables an optimization (DQ ignore-confirmation,
    // curator dedupe — "nothing confirmed ignored yet", carry on), and wrong
    // for the undo drainer, which uses the strict one.
    async function fetchIgnoredApps() {
        return (await Net.fetchIgnoredAppsStrict()) || new Set();
    }

    // Login-state source for gating the on-page UI. Two signals, because a page
    // can outlive its login state (opened before the user signed in elsewhere):
    // the store header DOM (free, but frozen at page load) and a live same-origin
    // probe (steam-net.js, shared with the SW).
    const SteamAuth = {
        // true/false from the store header; null when the header isn't rendered
        // at all (unknown surface) → caller falls back to the live probe.
        isLoggedInDom() {
            if (document.querySelector('#account_pulldown, #global_actions .user_avatar')) return true;
            return document.getElementById('global_action_menu') ? false : null;
        },
        probeLogin: Net.probeLogin,
        // The login-gate policy shared by the widget launcher and the curator
        // button: trust the header DOM when it rendered (true/false — a false
        // header never triggers a probe), fall back to the live probe only when
        // there is no header to read. Resolves true only on a confirmed session;
        // a failed/offline probe resolves false (callers keep their locked default).
        async resolveLogin() {
            const dom = this.isLoggedInDom();
            if (dom !== null) return dom;
            return (await this.probeLogin()) === true;
        }
    };

    // The ignore endpoint, this world's copy (the SW has its own — see the note
    // at the top of steam-net.js for why this one POST stays duplicated).
    // Resolves { ok, rateLimited, retryAfterMs, status }:
    //   ok          — the call landed;
    //   rateLimited — the server answered 429 (throttling the ACCOUNT, not
    //                 this appid). Gated callers report it to the IgnoreGate
    //                 so every source in every tab backs off together;
    //   retryAfterMs — parsed Retry-After when the 429 carried one, else 0
    //                 (an HTTP-date Retry-After parses to 0 and the gate's
    //                 own exponential backoff decides);
    //   status      — the HTTP status (0 when the request never completed).
    //                 Only the curator drainer's 400-classifier reads it:
    //                 the region-lock ⇔ appdetails-success:false correlation
    //                 was established for HTTP 400 specifically, so a probe
    //                 must NOT fire on a timeout/5xx that merely looks like a
    //                 refusal.
    // A network failure / dead session is { ok:false, rateLimited:false }.
    const IGNORE_URL = 'https://store.steampowered.com/recommended/ignorerecommendation/';
    async function post(fields) {
        const sessionid = SessionService.getID();
        if (!sessionid) return { ok: false, rateLimited: false, retryAfterMs: 0, status: 0 };

        // URLSearchParams encodes each field, so the cookie-sourced sessionid
        // can't break the body's key=value&… structure (it's hex today, but
        // this closes the injection question at the boundary regardless).
        const body = new URLSearchParams(Object.assign({ sessionid }, fields)).toString();
        try {
            const response = await fetchWithTimeout(IGNORE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                body: body
            });
            if (response.status === 429) {
                const ra = parseInt(response.headers.get('Retry-After'), 10);
                return { ok: false, rateLimited: true, retryAfterMs: ra > 0 ? ra * 1000 : 0, status: 429 };
            }
            return { ok: response.ok, rateLimited: false, retryAfterMs: 0, status: response.status };
        } catch (e) { return { ok: false, rateLimited: false, retryAfterMs: 0, status: 0 }; }
    }

    const SteamAPI = {
        ignore(appid, reason) {
            return post({ appid, snr: '', ignore_reason: reason });
        },

        // Un-ignore: the SAME endpoint with remove=1 (the shape Steam's own
        // notinterested page fires, proven by the E2E cleanup hooks). Same
        // resolve contract as ignore() — the undo drainer paces these through
        // the IgnoreGate exactly like ignores (same endpoint, same rate risk).
        unignore(appid) {
            return post({ appid, snr: '1_account_notinterested_', remove: '1' });
        }
    };

    // === Stats Domain ===

    // The record's shape — key names, the 20-entry history cap and the two pure
    // transforms — has ONE definition, in src/stats.js (loaded before this file;
    // the service worker writes the same record for drained manual-ignore jobs
    // and cannot load utils.js). Only the chrome.storage read-modify-write below
    // is this world's own.
    const StatsLogic = window.ILAP.StatsLogic;

    const StatsManager = {
        // Serializes the read-modify-write so concurrent ignores can't lose an
        // increment: storage get/set are async, so two overlapping saves could
        // both read the same count and both write count+1. Each save waits for the
        // previous one's set() to complete before its own get() runs.
        _chain: Promise.resolve(),

        save(gameName, source) {
            if (!chrome?.storage?.local || !chrome?.runtime?.id) {
                console.warn("[ILAP] Extension context is inactive. Stats not saved.");
                return Promise.resolve();
            }

            // Names come from Steam's DOM — normalize to bounded plain text before
            // it ever reaches storage (see sanitizeName).
            const safeName = sanitizeName(gameName);

            // .catch keeps a single failed commit from wedging the whole chain.
            this._chain = this._chain.then(() => this._commit(safeName, source)).catch(() => {});
            return this._chain;
        },

        _commit(safeName, source) {
            return new Promise(resolve => {
                try {
                    chrome.storage.local.get([StatsLogic.HISTORY_KEY, StatsLogic.COUNT_KEY], (result) => {
                        if (chrome.runtime.lastError) return resolve();
                        chrome.storage.local.set(
                            StatsLogic.nextState(result, safeName, source), resolve);
                    });
                } catch (e) {
                    console.warn("[ILAP] Failed to access storage:", e);
                    resolve();
                }
            });
        }
    };

    // === Name Extraction Domain ===

    class NameCleaner {
        static cleanUp(name) {
            return name.replace(/\s*-?\s*screenshot\s*\d*$/i, '').trim();
        }
        static cleanText(text) {
            return text ? text.trim() : "";
        }
    }

    // Steam's hover-preview applet (Labs) renders action buttons — "Ignore game",
    // "Add to wishlist", "Add to cart" — as plain text inside the same popover as
    // the capsule. These labels must never be mistaken for a game's name.
    const ACTION_LABEL = /^(ignore( game)?|ignored|add to wishlist|on wishlist|wishlist|add to cart|in cart|follow(ing)?|play( now)?|install|buy now|buy)$/i;

    class PageTitleStrategy {
        extract(appid, contextElement, root) {
            if (root === document.body || root.id === 'page_root') {
                const pageTitle = document.getElementById('appHubAppName') || document.querySelector('.apphub_AppName');
                if (pageTitle && NameCleaner.cleanText(pageTitle.textContent)) {
                    return NameCleaner.cleanText(pageTitle.textContent);
                }
            }
            return null;
        }
    }

    class CssClassesStrategy {
        extract(appid, contextElement, root) {
            const titleSelectors = [
                '[class*="GameName"]', '[class*="AppName"]', '[class*="AppTitle"]',
                '.app_name', '.tab_item_name', '.capsule_name', '.home_smallcap_title',
                '[class*="StoreSaleWidgetTitle"]', '[class*="Hover_Title"]', 'h4', '.title'
            ];
            
            for (let s of titleSelectors) {
                const el = root.querySelector(s);
                const text = el && NameCleaner.cleanText(el.textContent);
                if (text && text.length > 1 && text.length < 80 && !/^\d/.test(text) && !ACTION_LABEL.test(text)) {
                    return text;
                }
            }
            return null;
        }
    }

    class AltTagsStrategy {
        extract(appid, contextElement, root) {
            const JUNK_PATTERNS = /^(capsule|header|image|cover|artwork|screenshot|review|logo|\d+)$/i;
            const imgs = root.querySelectorAll('img[alt]');
            for (const img of imgs) {
                const alt = NameCleaner.cleanText(img.alt);
                if (alt && alt.length > 2 && !JUNK_PATTERNS.test(alt) && !alt.toLowerCase().includes('screenshot') && !ACTION_LABEL.test(alt)) {
                    return alt;
                }
            }
            return null;
        }
    }

    class GenericTextStrategy {
        extract(appid, contextElement, root) {
            const links = root.querySelectorAll(`a[href*="/app/${appid}"]`);
            for (const link of links) {
                if (link.querySelector('img')) continue;
                const text = NameCleaner.cleanText(link.textContent);
                if (text && text.length > 1 && text.length < 80) return text;
            }

            const candidates = root.querySelectorAll('div, span, p');
            for (const el of candidates) {
                if (el.children.length > 0) continue;
                if (el === contextElement || el.contains(contextElement)) continue;
                if (el.closest('.ilap-ignored-overlay')) continue;

                const selfCls = (el.className || "").toLowerCase();
                const parentCls = (el.parentElement?.className || "").toLowerCase();
                const ancestorCls = selfCls + " " + parentCls;

                if (ancestorCls.match(/discount|price|currency|review|wishlist|btn|button|tag|badge|flag|rating|screenshot|release|date|platform|os_/)) continue;

                const text = NameCleaner.cleanText(el.textContent);
                if (!text || text.length <= 1 || text.length >= 80) continue;
                if (text.includes('%')) continue;
                if (ACTION_LABEL.test(text)) continue;

                return text;
            }
            return null;
        }
    }

    class UrlPathStrategy {
        extract(appid, contextElement, root) {
            const linkSelector = `a[href*="/app/${appid}"]`;
            const link = root.matches?.(linkSelector) ? root : 
                         root.querySelector(linkSelector) || 
                         (contextElement && contextElement.closest ? contextElement.closest(linkSelector) : null);
            
            if (link) {
                const url = link.getAttribute('href');
                const match = url.match(new RegExp(`/app/${appid}/([^/?]+)`));
                if (match && match[1]) {
                    let extracted = decodeURIComponent(match[1]).replace(/_/g, ' ');
                    extracted = NameCleaner.cleanText(extracted);
                    if (extracted.length > 1) return extracted;
                }
            }
            return null;
        }
    }

    class NameExtractionStrategyProvider {
        constructor(strategies) {
            this.strategies = strategies;
        }

        get(appid, contextElement) {
            const root = this._findRoot(contextElement);
            
            for (const strategy of this.strategies) {
                const name = strategy.extract(appid, contextElement, root);
                if (name) return NameCleaner.cleanUp(name);
            }
            
            return `AppID ${appid}`;
        }

        _findRoot(el) {
            if (!el) return document.body;
            
            const reactPanelWrapper = el.closest('div[class*="Panel"][role="button"]');
            if (reactPanelWrapper && reactPanelWrapper.querySelector('a[href*="/app/"]')) {
                return reactPanelWrapper;
            }

            const structuralRoot = el.closest('a[href*="/app/"], [data-ds-appid], [data-ds-itemkey]');
            if (structuralRoot) return structuralRoot;

            const legacyRoot = el.closest(`
                .tab_item, .game_capsule, .store_main_capsule, .dailydeal_cap,
                [class*="ImpressionTrackedElement"], div[class*="StoreSaleWidget"], 
                [class*="SaleSectionCtn"]
            `);
            if (legacyRoot) return legacyRoot;

            return el.parentElement?.parentElement || el.parentElement || el;
        }
    }

    const extractorProvider = new NameExtractionStrategyProvider([
        new PageTitleStrategy(),
        new CssClassesStrategy(),
        new AltTagsStrategy(),
        // UrlPath before GenericText: the href slug is a canonical, language-
        // independent name source, so it must win over scanning arbitrary text
        // (which otherwise picks up localized hover-applet button labels like
        // "Ignore game" / "Spiel ignorieren"). GenericText stays as last resort.
        new UrlPathStrategy(),
        new GenericTextStrategy()
    ]);

    // Some React storefront capsules (e.g. the front-page release-calendar
    // carousel) are a bare <a href="/app/ID?..."><img></a> — no alt text, no
    // title node, no name slug in the href — so every DOM strategy misses and
    // the stored name degrades to "AppID 12345". The store's own appdetails
    // endpoint is the only name source left. Same-origin GET, so the user's
    // language cookie localizes the name like a DOM-extracted one would be.
    const APPDETAILS_URL = 'https://store.steampowered.com/api/appdetails';
    async function fetchAppName(appid) {
        try {
            const res = await fetchWithTimeout(`${APPDETAILS_URL}?appids=${appid}&filters=basic`);
            if (!res.ok) return null;
            const data = await res.json();
            const entry = data && data[appid];
            const name = entry && entry.success && entry.data && entry.data.name;
            return name ? sanitizeName(name) : null;
        } catch (e) { return null; }
    }

    // Collision-resistant per-context owner id for storage leases/slots (the
    // curator drain lease, the DQ registry slot); the prefix names the subsystem.
    const newOwnerId = (prefix) =>
        prefix + Math.random().toString(36).slice(2) + Date.now().toString(36);

    // === Public Facade ===
    window.ILAP = window.ILAP || {};
    window.ILAP.SESSION_IGNORED_KEY = 'ilap_session_ignored_games';
    
    window.ILAP.getSessionID = SessionService.getID;
    window.ILAP.apiIgnoreGame = SteamAPI.ignore;
    window.ILAP.apiUnignoreGame = SteamAPI.unignore;
    window.ILAP.fetchIgnoredApps = fetchIgnoredApps;
    window.ILAP.fetchIgnoredAppsStrict = Net.fetchIgnoredAppsStrict;
    window.ILAP.classifyRefusal = Net.classifyRefusal;
    window.ILAP.SteamAuth = SteamAuth;
    window.ILAP.saveStats = (name, source) => StatsManager.save(name, source);
    window.ILAP.getGameName = (appid, el) => extractorProvider.get(appid, el);
    // Async flavour: DOM strategies first (synchronously, before the caller
    // mutates the container), appdetails fallback only when they all miss.
    // Callers whose surfaces always carry a name in the DOM stay on the sync
    // getGameName.
    window.ILAP.resolveGameName = async (appid, el) => {
        const name = extractorProvider.get(appid, el);
        if (name !== `AppID ${appid}`) return name;
        return (await fetchAppName(appid)) || name;
    };
    window.ILAP.SessionStateService = SessionStateService;
    window.ILAP.ResourceService = ResourceService;
    window.ILAP.sanitizeName = sanitizeName;
    window.ILAP.fetchWithTimeout = fetchWithTimeout;
    window.ILAP.newOwnerId = newOwnerId;

})();