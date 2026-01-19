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
     * Optimized game name extraction.
     * Fixed logic to avoid "Add to wishlist" or "Screenshot" text.
     */
    window.ILAP.getGameName = function(appid, contextElement) {
        // 1. High Priority: App Page Title (Store Page)
        const pageTitle = document.getElementById('appHubAppName') || document.querySelector('.apphub_AppName');
        if (pageTitle && pageTitle.textContent.trim()) {
            return pageTitle.textContent.trim();
        }

        if (!contextElement) return `AppID ${appid}`;

        // 2. Define search root (The whole card)
        const cardRoot = contextElement.closest(`
            .tab_item, 
            .game_capsule, 
            .store_main_capsule,
            .dailydeal_cap,
            [class*="ImpressionTrackedElement"],
            div[class*="StoreSaleWidget"],
            a.item
        `) || contextElement.parentElement || contextElement;

        const clean = (text) => text ? text.trim() : "";

        // 3. Strategy A: Specific CSS Classes (Best Accuracy)
        const titleSelectors = [
            '.app_name',                    
            '.tab_item_name',               
            '[class*="StoreSaleWidgetTitle"]', 
            '.title',                       
            'h4',
            '.capsule_name'                 
        ];

        for (let s of titleSelectors) {
            const el = cardRoot.querySelector(s);
            if (el && clean(el.textContent)) return clean(el.textContent);
        }

        // 4. Strategy B: Image Alt Attribute (Promoted to High Priority)
        // Image alt tags are usually cleaner than random div text in React layouts.
        const imgs = cardRoot.querySelectorAll('img[alt]');
        for (const img of imgs) {
            const alt = clean(img.alt);
            // Filter out technical images
            if (alt && 
                !alt.toLowerCase().startsWith('screenshot') && 
                !alt.toLowerCase().includes('review')
            ) {
                return alt;
            }
        }

        // 5. Strategy C: Generic Text Search (Fallback)
        // Only run this if we couldn't find a class or an alt tag.
        if (cardRoot) {
            const divs = cardRoot.querySelectorAll('div');
            for (const div of divs) {
                if (div === contextElement || div.contains(contextElement)) continue;
                
                // --- EXCLUSION FILTERS ---
                const className = div.className.toLowerCase();
                if (className.includes('discount')) continue; 
                if (className.includes('review')) continue; 
                if (className.includes('platform')) continue;
                // Exclude Buttons and Wishlist
                if (className.match(/wishlist|deck|btn|button|tag/)) continue;
                
                const text = clean(div.textContent);
                
                // Exclude specific phrases
                if (text.toLowerCase() === 'add to wishlist') continue;
                if (text.toLowerCase() === 'in library') continue;

                // Validate text looks like a title
                if (text.length > 1 && text.length < 100 && !text.includes('%')) {
                    if (!/^\d+[.,]\d{2}.*$/.test(text)) { // Not a price
                         return text;
                    }
                }
            }
        }

        return `AppID ${appid}`;
    };

})();