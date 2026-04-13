(function() {
    'use strict';

    // === Shared Infrastructure ===

    const SessionService = {
        getID() {
            if (window.g_sessionID) return window.g_sessionID;
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

    const SteamAPI = {
        async ignore(appid, reason) {
            const sessionid = SessionService.getID();
            if (!sessionid) return false;

            const body = `sessionid=${sessionid}&appid=${appid}&snr=&ignore_reason=${reason}`;
            try {
                const response = await fetch('https://store.steampowered.com/recommended/ignorerecommendation/', { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, 
                    body: body 
                });
                return response.ok;
            } catch (e) { return false; }
        }
    };

    // === Stats Domain (SRP Fix) ===

    const StatsLogic = {
        increment(currentCount) {
            return (currentCount || 0) + 1;
        },
        pushHistory(currentHistory, name, source) {
            const history = [{ name, source }, ...(currentHistory || [])];
            return history.slice(0, 20);
        }
    };

    const StatsManager = {
        save(gameName, source) {
            if (!chrome?.storage?.local || !chrome?.runtime?.id) {
                console.warn("[ILAP] Extension context is inactive. Stats not saved.");
                return;
            }
            
            try {
                chrome.storage.local.get(['ilap_ignored_history', 'ilap_ignored_count'], (result) => {
                    if (chrome.runtime.lastError) return;

                    const newCount = StatsLogic.increment(result.ilap_ignored_count);
                    const newHistory = StatsLogic.pushHistory(result.ilap_ignored_history, gameName, source);

                    chrome.storage.local.set({
                        'ilap_ignored_count': newCount,
                        'ilap_ignored_history': newHistory,
                        'ilap_last_ignored_name': gameName
                    });
                });
            } catch (e) {
                console.warn("[ILAP] Failed to access storage:", e);
            }
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
                if (text && text.length > 1 && text.length < 80 && !/^\d/.test(text)) {
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
                if (alt && alt.length > 2 && !JUNK_PATTERNS.test(alt) && !alt.toLowerCase().includes('screenshot')) {
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
        new GenericTextStrategy(),
        new UrlPathStrategy()
    ]);

    // === Public Facade ===
    window.ILAP = window.ILAP || {};
    window.ILAP.SESSION_IGNORED_KEY = 'ilap_session_ignored_games';
    
    window.ILAP.getSessionID = SessionService.getID;
    window.ILAP.apiIgnoreGame = SteamAPI.ignore;
    window.ILAP.saveStats = (name, source) => StatsManager.save(name, source);
    window.ILAP.getGameName = (appid, el) => extractorProvider.get(appid, el);
    window.ILAP.SessionStateService = SessionStateService; 

})();