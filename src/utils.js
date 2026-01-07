(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.SESSION_IGNORED_KEY = 'ilap_session_ignored_games';

    window.ILAP.getSessionID = function() {
        if (window.g_sessionID) return window.g_sessionID;
        const match = document.cookie.match(/sessionid=([^;]+)/);
        return match ? match[1] : null;
    };

    window.ILAP.apiIgnoreGame = async function(appid, reason = 0) {
        const sessionid = this.getSessionID();
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
    };

    /**
     * Updated: Removed time from history entry, limited by logic in popup
     */
    window.ILAP.saveStats = function(lastGameName, source = "Unknown") {
        if (chrome?.storage?.local) {
            chrome.storage.local.get(['ilap_ignored_history', 'ilap_ignored_count'], (result) => {
                let history = result.ilap_ignored_history || [];
                let totalCount = result.ilap_ignored_count || 0;

                // Entry without time as requested
                const newEntry = { name: lastGameName, source: source };

                history.unshift(newEntry);
                if (history.length > 20) history.pop(); 

                chrome.storage.local.set({
                    'ilap_ignored_count': totalCount + 1,
                    'ilap_ignored_history': history,
                    'ilap_last_ignored_name': lastGameName
                });
            });
        }
    };

    /**
     * Improved robust game name extraction
     */
    window.ILAP.getGameName = function(appid, contextElement) {
        if (contextElement) {
            // 1. Check for standard title containers in store rows/grids
            const titleSelectors = [
                '.app_name', 
                '.title', 
                '.match_name', 
                '[class*="StoreSaleWidgetTitle"]',
                '.tab_item_name'
            ];
            
            for (let selector of titleSelectors) {
                const el = contextElement.querySelector(selector) || contextElement.closest(selector);
                if (el && el.textContent.trim()) return el.textContent.trim();
            }

            // 2. Check images with alt
            const img = contextElement.querySelector('img[alt]');
            if (img && img.alt && img.alt.trim()) return img.alt.trim();

            // 3. Check for app page header if we are inside the app page
            const h1 = document.querySelector('.apphub_AppName');
            if (h1 && window.location.pathname.includes(appid)) return h1.textContent.trim();

            // 4. Fallback: Parse name from URL slug
            const href = contextElement.getAttribute('href') || '';
            const urlMatch = href.match(/\/app\/\d+\/([^\/?]+)/);
            if (urlMatch && urlMatch[1]) {
                return urlMatch[1].replace(/_/g, ' ').replace(/%20/g, ' ').trim();
            }
        }
        return `AppID ${appid}`;
    };

})();