(function() {
    'use strict';

    const SessionService = {
        getID() {
            if (window.g_sessionID) return window.g_sessionID;
            const match = document.cookie.match(/sessionid=([^;]+)/);
            return match ? match[1] : null;
        }
    };

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

    const StatsManager = {
        save(gameName, source) {
            if (!chrome?.storage?.local) return;
            
            chrome.storage.local.get(['ilap_ignored_history', 'ilap_ignored_count'], (result) => {
                const newCount = this._incrementCount(result.ilap_ignored_count);
                const newHistory = this._pushHistory(result.ilap_ignored_history, gameName, source);

                chrome.storage.local.set({
                    'ilap_ignored_count': newCount,
                    'ilap_ignored_history': newHistory,
                    'ilap_last_ignored_name': gameName
                });
            });
        },

        _incrementCount(currentCount) {
            return (currentCount || 0) + 1;
        },

        // SRP FIX: Pure function, no mutation of input array
        _pushHistory(currentHistory, name, source) {
            const history = [{ name, source }, ...(currentHistory || [])];
            return history.slice(0, 20);
        }
    };

    class NameExtractionStrategyProvider {
        constructor() {
            this.strategies = [
                this._strategyPageTitle,
                this._strategyCssClasses,
                this._strategyAltTags,
                this._strategyGenericText
            ];
        }

        get(appid, contextElement) {
            const root = this._findRoot(contextElement);
            
            for (const strategy of this.strategies) {
                const name = strategy.call(this, appid, contextElement, root);
                if (name) return this._cleanUpName(name);
            }
            
            return `AppID ${appid}`;
        }

        _findRoot(el) {
            if (!el) return document.body;
            return el.closest(`
                .tab_item, .game_capsule, .store_main_capsule, .dailydeal_cap,
                [class*="ImpressionTrackedElement"], div[class*="StoreSaleWidget"], 
                a.item, [class*="SaleSectionCtn"]
            `) || el.parentElement?.parentElement || el.parentElement || el;
        }

        _cleanUpName(name) {
            return name.replace(/\s*-?\s*screenshot\s*\d*$/i, '').trim();
        }

        _cleanText(text) {
            return text ? text.trim() : "";
        }

        _strategyPageTitle(appid, contextElement, root) {
            const pageTitle = document.getElementById('appHubAppName') || document.querySelector('.apphub_AppName');
            if (pageTitle && this._cleanText(pageTitle.textContent)) {
                return this._cleanText(pageTitle.textContent);
            }
            return null;
        }

        _strategyCssClasses(appid, contextElement, root) {
            const titleSelectors = [
                '.app_name', '.tab_item_name', '[class*="StoreSaleWidgetTitle"]', 
                '.title', 'h4', '.capsule_name', '[class*="Hover_Title"]'
            ];
            for (let s of titleSelectors) {
                const el = root.querySelector(s);
                if (el && this._cleanText(el.textContent)) return this._cleanText(el.textContent);
            }
            return null;
        }

        _strategyAltTags(appid, contextElement, root) {
            const imgs = root.querySelectorAll('img[alt]');
            for (const img of imgs) {
                const alt = this._cleanText(img.alt);
                if (alt && !alt.toLowerCase().includes('screenshot') && !alt.toLowerCase().includes('review')) {
                    return alt;
                }
            }
            return null;
        }

        _strategyGenericText(appid, contextElement, root) {
            const links = root.querySelectorAll(`a[href*="/app/${appid}"]`);
            for (const link of links) {
                if (link.querySelector('img')) continue;
                const text = link.textContent.trim();
                if (text && text.length > 1) return text;
            }

            const candidates = root.querySelectorAll('div, a, span'); 
            for (const el of candidates) {
                if (el === contextElement || el.contains(contextElement)) continue;
                
                const cls = (el.className || "").toLowerCase();
                if (cls.includes('ilap') || el.closest('.ilap-ignored-overlay')) continue;
                if (cls.match(/discount|review|platform|wishlist|deck|btn|button|tag|price/)) continue;
                
                if (el.tagName.toLowerCase() === 'a' && el.querySelector('img')) continue;

                const text = el.textContent.trim();
                const lowerText = text.toLowerCase();
                
                if (lowerText.match(/add to wishlist|in library|on wishlist|free|play now|screenshot/)) continue;

                if (text.length > 1 && text.length < 100 && !text.includes('%') && !/^\d+[.,]\d{2}.*$/.test(text)) {
                    return text;
                }
            }
            return null;
        }
    }

    const extractorProvider = new NameExtractionStrategyProvider();

    window.ILAP = window.ILAP || {};
    window.ILAP.SESSION_IGNORED_KEY = 'ilap_session_ignored_games';
    
    window.ILAP.getSessionID = SessionService.getID;
    window.ILAP.apiIgnoreGame = SteamAPI.ignore;
    window.ILAP.saveStats = (name, source) => StatsManager.save(name, source);
    window.ILAP.getGameName = (appid, el) => extractorProvider.get(appid, el);

})();