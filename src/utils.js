(function() {
    'use strict';

    window.SPT = window.SPT || {};
    window.SPT.SESSION_IGNORED_KEY = 'spt_session_ignored_games';

    window.SPT.getSessionID = function() {
        if (window.g_sessionID) return window.g_sessionID;
        const match = document.cookie.match(/sessionid=([^;]+)/);
        return match ? match[1] : null;
    };

    window.SPT.saveStats = function(lastGameName, source = "Unknown") {
        if (chrome && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(['spt_ignored_count'], (result) => {
                if (chrome.runtime.lastError) return;

                let currentCount = result.spt_ignored_count || 0;
                currentCount++;

                chrome.storage.local.set({
                    'spt_ignored_count': currentCount,
                    'spt_last_ignored_name': lastGameName,
                    'spt_last_ignored_source': source
                });
            });
        }
    };

    window.SPT.getGameName = function(appid, contextElement) {
        let gameName = `AppID ${appid}`;
        
        if (contextElement) {
            // === 1. SPECIAL CASE: Expanded Display (Big Banner) ===
            // User Request: Use the 'alt' attribute of the image inside this container
            const expandedContainer = contextElement.closest('[class*="LibraryAssetExpandedDisplay"]');
            if (expandedContainer) {
                const imgWithAlt = expandedContainer.querySelector('img[alt]');
                if (imgWithAlt && imgWithAlt.alt) {
                    return imgWithAlt.alt.trim();
                }
            }

            // === 2. Standard Widget Logic (Grids, Search, etc.) ===
            let titleElement = contextElement.closest('div[class*="salepreviewwidgets_SaleItemBrowserRow"]')?.querySelector('div[class*="StoreSaleWidgetTitle"]');
            
            if (!titleElement) {
                titleElement = contextElement.querySelector('div[class*="StoreSaleWidgetTitle"]');
            }

            if (titleElement) {
                gameName = titleElement.textContent.trim();
            } 
            // === 3. Fallback: Parse URL Slug ===
            else {
                const href = contextElement.getAttribute('href');
                if (href) {
                    const nameMatch = href.match(/\/app\/\d+\/([^\/?]+)/);
                    if (nameMatch && nameMatch[1]) {
                        gameName = nameMatch[1].replace(/_/g, ' ').trim();
                    }
                }
            }
        }

        return gameName;
    };

})();