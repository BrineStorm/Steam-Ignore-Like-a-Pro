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

    window.ILAP.saveStats = function(lastGameName, source = "Unknown") {
        if (chrome?.storage?.local) {
            chrome.storage.local.get(['ilap_ignored_history', 'ilap_ignored_count'], (result) => {
                let history = result.ilap_ignored_history || [];
                let totalCount = result.ilap_ignored_count || 0;

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
     * Optimized game name extraction for App Pages and Lists
     */
    window.ILAP.getGameName = function(appid, contextElement) {
        // 1. Priority: App Page Title (for Explore Queue)
        const pageTitle = document.getElementById('appHubAppName') || document.querySelector('.apphub_AppName');
        if (pageTitle && pageTitle.textContent.trim()) {
            return pageTitle.textContent.trim();
        }

        if (contextElement) {
            // 2. Standard list/grid selectors
            const titleSelectors = ['.app_name', '.title', '[class*="StoreSaleWidgetTitle"]', '.tab_item_name'];
            for (let s of titleSelectors) {
                const el = contextElement.querySelector(s);
                if (el && el.textContent.trim()) return el.textContent.trim();
            }

            // 3. Img Alt
            const img = contextElement.querySelector('img[alt]');
            if (img && img.alt) return img.alt.trim();
        }

        return `AppID ${appid}`;
    };

})();