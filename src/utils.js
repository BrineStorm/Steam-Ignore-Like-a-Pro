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

    // Plain-text boundary normalizer for names captured from Steam's DOM (game
    // titles, curator names) before they are persisted to storage. Render paths
    // already escape, but stripping tag delimiters + control chars and clamping
    // length HERE means a future render path that forgets to escape can't become
    // a stored-XSS sink, and a pathological name can't bloat storage.
    const NAME_MAX_LEN = 120;
    function sanitizeName(str, maxLen) {
        return String(str == null ? '' : str)
            .replace(/[<>]/g, '')                    // no tag delimiters survive
            .replace(/\p{Cc}/gu, ' ')                 // drop control chars
            .replace(/\s+/g, ' ')                    // collapse runs of whitespace
            .trim()
            .slice(0, maxLen || NAME_MAX_LEN);
    }

    // Every Steam fetch gets a hard deadline: a hung request (server not
    // answering, half-dead connection) must fail like a network error rather
    // than hold its caller forever — most critically the curator drainer, whose
    // `draining` latch a hung ignore POST would otherwise wedge until reload
    // (the lease would expire and hand off to another tab, but THIS tab would
    // never drain again). Callers already treat a throw as failure, and an
    // abort throws, so no call site needs extra handling.
    const FETCH_TIMEOUT_MS = 10000;
    function fetchWithTimeout(url, options, timeoutMs) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs || FETCH_TIMEOUT_MS);
        // The timer is deliberately NOT cleared when fetch() resolves: fetch()
        // resolves at HEADERS, while body reads (res.json()) run afterwards
        // under the same signal — a server that sends headers then stalls the
        // body must hit the same deadline. Once the body has been consumed the
        // late abort() is a no-op (at worst it cancels an unread body).
        return fetch(url, Object.assign({}, options, { signal: ctl.signal }))
            .catch(err => { clearTimeout(timer); throw err; });
    }

    // Authoritative ignore-state source: Steam's own dynamic store. Same-origin
    // GET (read-only — NOT an ignore API call); rgIgnoredApps is the map of every
    // ignored appid. Shared by the DQ ignore-confirmation and the curator drainer's
    // drain-time dedupe. Any failure (network/parse/non-ok/timeout) resolves to an
    // empty Set so callers treat it as "nothing confirmed ignored yet" and carry on.
    const USERDATA_URL = 'https://store.steampowered.com/dynamicstore/userdata/';
    async function fetchIgnoredApps() {
        try {
            const res = await fetchWithTimeout(`${USERDATA_URL}?_=${Date.now()}`, {
                credentials: 'include', cache: 'no-store'
            });
            if (!res.ok) return new Set();
            const data = await res.json();
            const ignored = data && data.rgIgnoredApps;
            return new Set(ignored ? Object.keys(ignored).map(String) : []);
        } catch (e) {
            return new Set();
        }
    }

    // Login-state source for gating the on-page UI. Two signals, because a page
    // can outlive its login state (opened before the user signed in elsewhere):
    // the store header DOM (free, but frozen at page load) and a live same-origin
    // probe — /account/ redirects to the login page when the session cookies are
    // absent (steamLoginSecure is HttpOnly, so the cookie can't be read directly).
    const ACCOUNT_URL = 'https://store.steampowered.com/account/';
    const SteamAuth = {
        // true/false from the store header; null when the header isn't rendered
        // at all (unknown surface) → caller falls back to the live probe.
        isLoggedInDom() {
            if (document.querySelector('#account_pulldown, #global_actions .user_avatar')) return true;
            return document.getElementById('global_action_menu') ? false : null;
        },
        // Live check against the CURRENT cookies (a read, not an ignore call).
        // null when the request itself failed (offline) — keep the current state.
        async probeLogin() {
            try {
                const res = await fetchWithTimeout(ACCOUNT_URL, { credentials: 'include', cache: 'no-store' });
                if (!res.ok) return null;
                return !res.url.includes('/login');
            } catch (e) { return null; }
        },
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

    const SteamAPI = {
        // Resolves { ok, rateLimited, retryAfterMs }:
        //   ok          — the ignore landed;
        //   rateLimited — the server answered 429 (throttling the ACCOUNT, not
        //                 this appid). Gated callers report it to the IgnoreGate
        //                 so every source in every tab backs off together;
        //   retryAfterMs — parsed Retry-After when the 429 carried one, else 0
        //                 (an HTTP-date Retry-After parses to 0 and the gate's
        //                 own exponential backoff decides).
        // A network failure / dead session is { ok:false, rateLimited:false }.
        async ignore(appid, reason) {
            const sessionid = SessionService.getID();
            if (!sessionid) return { ok: false, rateLimited: false, retryAfterMs: 0 };

            // URLSearchParams encodes each field, so the cookie-sourced sessionid
            // can't break the body's key=value&… structure (it's hex today, but
            // this closes the injection question at the boundary regardless).
            const body = new URLSearchParams({
                sessionid, appid, snr: '', ignore_reason: reason
            }).toString();
            try {
                const response = await fetchWithTimeout('https://store.steampowered.com/recommended/ignorerecommendation/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                    body: body
                });
                if (response.status === 429) {
                    const ra = parseInt(response.headers.get('Retry-After'), 10);
                    return { ok: false, rateLimited: true, retryAfterMs: ra > 0 ? ra * 1000 : 0 };
                }
                return { ok: response.ok, rateLimited: false, retryAfterMs: 0 };
            } catch (e) { return { ok: false, rateLimited: false, retryAfterMs: 0 }; }
        }
    };

    // === Stats Domain ===

    const HISTORY_LIMIT = 20; // max entries kept in ilap_ignored_history

    const StatsLogic = {
        increment(currentCount) {
            return (currentCount || 0) + 1;
        },
        pushHistory(currentHistory, name, source) {
            const history = [{ name, source }, ...(currentHistory || [])];
            return history.slice(0, HISTORY_LIMIT);
        }
    };

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
                    chrome.storage.local.get(['ilap_ignored_history', 'ilap_ignored_count'], (result) => {
                        if (chrome.runtime.lastError) return resolve();

                        const newCount = StatsLogic.increment(result.ilap_ignored_count);
                        const newHistory = StatsLogic.pushHistory(result.ilap_ignored_history, safeName, source);

                        chrome.storage.local.set({
                            'ilap_ignored_count': newCount,
                            'ilap_ignored_history': newHistory,
                            'ilap_last_ignored_name': safeName
                        }, resolve);
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

    // Collision-resistant per-context owner id for storage leases/slots (the
    // curator drain lease, the DQ registry slot); the prefix names the subsystem.
    const newOwnerId = (prefix) =>
        prefix + Math.random().toString(36).slice(2) + Date.now().toString(36);

    // === Public Facade ===
    window.ILAP = window.ILAP || {};
    window.ILAP.SESSION_IGNORED_KEY = 'ilap_session_ignored_games';
    
    window.ILAP.getSessionID = SessionService.getID;
    window.ILAP.apiIgnoreGame = SteamAPI.ignore;
    window.ILAP.fetchIgnoredApps = fetchIgnoredApps;
    window.ILAP.SteamAuth = SteamAuth;
    window.ILAP.saveStats = (name, source) => StatsManager.save(name, source);
    window.ILAP.getGameName = (appid, el) => extractorProvider.get(appid, el);
    window.ILAP.SessionStateService = SessionStateService;
    window.ILAP.ResourceService = ResourceService;
    window.ILAP.sanitizeName = sanitizeName;
    window.ILAP.fetchWithTimeout = fetchWithTimeout;
    window.ILAP.newOwnerId = newOwnerId;

})();