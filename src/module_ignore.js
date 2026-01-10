(function() {
    'use strict';

    let sessionIgnoredIDs = new Set();
    let shortcutConfig = { default: 'ctrlKey', platform: 'off', enabled: true };
    const CARD_SELECTORS = 'a[href*="/app/"], a.tab_item_overlay, .tab_item';

    /**
     * UI Logic: Mark game cards with a badge
     */
    function markCardAsProcessed(appid) {
        const allGameLinks = Array.from(document.querySelectorAll(`a[href*="/app/${appid}"]`))
            .filter(link => {
                const href = link.getAttribute('href');
                const regex = new RegExp(`/app/${appid}([^0-9]|$)`);
                return regex.test(href);
            });

        allGameLinks.forEach(link => {
            // 1. Identify context
            const expandedRoot = link.closest('[class*="LibraryAssetExpandedDisplay"]');
            const listItemRoot = link.closest('.tab_item');
            
            // --- BUG FIX: PROXIMITY CHECK (Radius of exclusion) ---
            // We climb up a few parents and check if THIS game already has a badge in this area.
            // This prevents duplicates in complex popups where the same game appears twice.
            let foundBadgeNearby = false;
            let climb = link;
            for (let i = 0; i < 4; i++) {
                if (!climb.parentElement) break;
                climb = climb.parentElement;
                // Look for our badge with the specific appid within this branch
                if (climb.querySelector(`.ilap-ignored-overlay[data-appid="${appid}"]`)) {
                    foundBadgeNearby = true;
                    break;
                }
            }
            if (foundBadgeNearby) return;

            // 2. TARGETING LOGIC
            let overlayTarget = null;
            let badgeClass = '';

            if (listItemRoot) {
                // Home Tabs & Package Lists: Target the whole row and use absolute corner badge
                overlayTarget = listItemRoot;
                badgeClass = 'ilap-list-badge';
            }
            else if (expandedRoot) {
                // Big banners
                overlayTarget = expandedRoot.querySelector('[class*="HeroCapsuleImageContainer"], .CapsuleImageCtn, img')?.parentElement;
                badgeClass = 'ilap-small-badge';
            }
            else {
                // Standard items and popups
                // Try standard containers first
                overlayTarget = link.querySelector('.CapsuleImageCtn, .game_capsule, .spotlight_img, .tab_item_cap, [class*="HeroCapsuleImageContainer"]');
                
                // Fallback for popups (target the link itself if it contains an image)
                if (!overlayTarget && (link.querySelector('img') || link.querySelector('video'))) {
                    overlayTarget = link;
                    badgeClass = 'ilap-small-badge';
                }
            }

            if (!overlayTarget) return;

            // 3. APPLY BADGE
            const overlay = document.createElement('div'); 
            overlay.className = 'ilap-ignored-overlay'; 
            overlay.dataset.appid = appid; // Crucial for duplicate checking
            
            if (badgeClass) overlay.classList.add(badgeClass);

            // Updated Tooltip Text as requested
            overlay.innerHTML = `IGNORED<div class="ilap-tooltip">Ignore applied by extension.</div>`;
            
            overlayTarget.appendChild(overlay); 
            overlayTarget.style.position = 'relative'; 
            overlayTarget.dataset.ilapProcessed = 'true';
        });
    }

    function ignoreGame(appid, reason, gameCardElement) {
        window.ILAP.apiIgnoreGame(appid, reason).then(success => {
            if (success) {
                const gameName = window.ILAP.getGameName(appid, gameCardElement);
                const sourceName = reason === 0 ? "Default Ignore" : "Played Elsewhere";
                
                sessionIgnoredIDs.add(appid);
                sessionStorage.setItem(window.ILAP.SESSION_IGNORED_KEY, JSON.stringify(Array.from(sessionIgnoredIDs)));
                
                markCardAsProcessed(appid);
                window.ILAP.saveStats(gameName, sourceName);
            }
        });
    }

    function updateShortcutSettings() {
        chrome.storage.local.get(['ilap_shortcut_key', 'ilap_platform_key', 'ilap_master_enabled'], (res) => {
            shortcutConfig.default = res.ilap_shortcut_key || 'ctrlKey';
            shortcutConfig.platform = res.ilap_platform_key || 'off';
            shortcutConfig.enabled = res.ilap_master_enabled !== false;
        });
    }

    function setupClickListener() {
        document.body.addEventListener('click', (event) => {
            if (!shortcutConfig.enabled) return;

            let reason = -1;
            if (event[shortcutConfig.default]) reason = 0;
            else if (shortcutConfig.platform !== 'off' && event[shortcutConfig.platform]) reason = 2;

            if (reason === -1) return;

            let gameCard = event.target.closest(CARD_SELECTORS);
            
            if (!gameCard) {
                const expanded = event.target.closest('[class*="LibraryAssetExpandedDisplay"]');
                if (expanded) gameCard = expanded.querySelector(CARD_SELECTORS);
            }

            if (!gameCard) return;

            const href = gameCard.getAttribute('href'); 
            const appidMatch = href ? href.match(/\/app\/(\d+)/) : null; 
            if (!appidMatch) return;

            const appid = appidMatch[1]; 
            if (sessionIgnoredIDs.has(appid)) return;

            event.preventDefault(); 
            event.stopPropagation();
            ignoreGame(appid, reason, gameCard);
        }, true);
    }

    function init() {
        try {
            const storedIDs = sessionStorage.getItem(window.ILAP.SESSION_IGNORED_KEY);
            if (storedIDs) { sessionIgnoredIDs = new Set(JSON.parse(storedIDs)); }
        } catch (e) { 
            sessionStorage.removeItem(window.ILAP.SESSION_IGNORED_KEY); 
        }

        updateShortcutSettings();
        setupClickListener();
        chrome.storage.onChanged.addListener(updateShortcutSettings);

        const observer = new MutationObserver(() => { 
            sessionIgnoredIDs.forEach(appid => { markCardAsProcessed(appid); }); 
        }); 
        observer.observe(document.body, { childList: true, subtree: true }); 
    }

    init();
})();