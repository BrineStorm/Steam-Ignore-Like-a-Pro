(function() {
    'use strict';

    // === Internal Services ===

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

    const StatsService = {
        save(gameName, source) {
            if (!chrome?.storage?.local) return;
            
            chrome.storage.local.get(['ilap_ignored_history', 'ilap_ignored_count'], (result) => {
                let history = result.ilap_ignored_history || [];
                let totalCount = result.ilap_ignored_count || 0;

                const newEntry = { name: gameName, source: source };
                history.unshift(newEntry);
                if (history.length > 20) history.pop(); 

                chrome.storage.local.set({
                    'ilap_ignored_count': totalCount + 1,
                    'ilap_ignored_history': history,
                    'ilap_last_ignored_name': gameName
                });
            });
        }
    };

    class GameNameExtractor {
        static get(appid, contextElement) {
            // 1. Store Page Title
            const pageTitle = document.getElementById('appHubAppName') || document.querySelector('.apphub_AppName');
            if (pageTitle && pageTitle.textContent.trim()) {
                return pageTitle.textContent.trim();
            }

            if (!contextElement) return `AppID ${appid}`;

            // 2. Define Root Context
            const cardRoot = this._findRoot(contextElement);
            const clean = (text) => text ? text.trim() : "";

            // 3. Strategy A: CSS Classes
            const titleSelectors = [
                '.app_name', '.tab_item_name', '[class*="StoreSaleWidgetTitle"]', 
                '.title', 'h4', '.capsule_name'
            ];
            for (let s of titleSelectors) {
                const el = cardRoot.querySelector(s);
                if (el && clean(el.textContent)) return clean(el.textContent);
            }

            // 4. Strategy B: Alt Tags (High Priority)
            const imgs = cardRoot.querySelectorAll('img[alt]');
            for (const img of imgs) {
                const alt = clean(img.alt);
                if (this._isValidAlt(alt)) return alt;
            }

            // 5. Strategy C: Smart Contextual Search (Target Links)
            return this._findGameLinkText(cardRoot, appid) || 
                   this._findGenericText(cardRoot, contextElement) || 
                   `AppID ${appid}`;
        }

        static _findRoot(el) {
            return el.closest(`
                .tab_item, .game_capsule, .store_main_capsule, .dailydeal_cap,
                [class*="ImpressionTrackedElement"], div[class*="StoreSaleWidget"], 
                a.item, [class*="SaleSectionCtn"]
            `) || el.parentElement?.parentElement || el.parentElement || el;
        }

        static _isValidAlt(alt) {
            if (!alt) return false;
            const lower = alt.toLowerCase();
            return !lower.startsWith('screenshot') && !lower.includes('review');
        }

        // NEW: Prioritize elements that are actually links to the game
        static _findGameLinkText(root, appid) {
            // Find all links pointing to this AppID
            const links = root.querySelectorAll(`a[href*="/app/${appid}"]`);
            for (const link of links) {
                // Ignore if it contains an image (it's the capsule, not the title)
                if (link.querySelector('img')) continue;
                
                const text = link.textContent.trim();
                if (text && text.length > 1) return text;
            }
            return null;
        }

        static _findGenericText(root, contextEl) {
            const candidates = root.querySelectorAll('div, a');
            
            for (const el of candidates) {
                if (el === contextEl || el.contains(contextEl)) continue;
                
                const cls = (el.className || "").toLowerCase();
                const tagName = el.tagName.toLowerCase();

                // === FILTERING ===
                if (cls.includes('ilap') || el.closest('.ilap-ignored-overlay')) continue;
                if (cls.match(/discount|review|platform|wishlist|deck|btn|button|tag/)) continue;
                
                if (tagName === 'a') {
                     if (el.querySelector('img')) continue; 
                     if (el.innerHTML.trim() === '') continue; 
                }

                const text = el.textContent.trim();
                
                // Added "on wishlist" to filter
                if (text.toLowerCase().match(/add to wishlist|in library|on wishlist|free|play now/)) continue;

                if (text.length > 1 && text.length < 100 && !text.includes('%') && !/^\d+[.,]\d{2}.*$/.test(text)) {
                    return text;
                }
            }
            return null;
        }
    }

    // === Public Facade (Backward Compatibility) ===
    window.ILAP = window.ILAP || {};
    window.ILAP.SESSION_IGNORED_KEY = 'ilap_session_ignored_games';
    
    // Exposed Methods
    window.ILAP.getSessionID = SessionService.getID;
    window.ILAP.apiIgnoreGame = SteamAPI.ignore;
    window.ILAP.saveStats = StatsService.save;
    window.ILAP.getGameName = (appid, el) => GameNameExtractor.get(appid, el);

})();