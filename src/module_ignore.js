(function() {
    'use strict';

    let sessionIgnoredIDs = new Set();
    let shortcutConfig = { default: 'ctrlKey', platform: 'off', enabled: true };
    const CARD_SELECTORS = 'a[href*="/app/"]';

    /**
     * UI Logic: Mark game cards with a badge
     */
    function markCardAsProcessed(appid) {
        let allGameLinks = Array.from(document.querySelectorAll(`a[href*="/app/${appid}"]`));

        allGameLinks = allGameLinks.filter(link => {
            const href = link.getAttribute('href');
            const regex = new RegExp(`/app/${appid}([^0-9]|$)`);
            return regex.test(href);
        });

        allGameLinks.sort((a, b) => {
            const aHasImg = a.querySelector('img') || a.querySelector('.CapsuleImageCtn');
            const bHasImg = b.querySelector('img') || b.querySelector('.CapsuleImageCtn');
            if (aHasImg && !bHasImg) return -1;
            if (!aHasImg && bHasImg) return 1;
            return 0;
        });

        allGameLinks.forEach(link => {
            if (link.closest('#global_hover')) {
                const hasText = link.textContent.trim().length > 0;
                const hasStructure = link.querySelector('div, img');
                if (hasText && !hasStructure) return;
            }

            let overlayTarget = null;
            const expandedContainer = link.closest('[class*="LibraryAssetExpandedDisplay"]');
            
            if (expandedContainer) {
                const mainImg = expandedContainer.querySelector('img');
                if (mainImg) overlayTarget = mainImg.parentElement;
            } else {
                overlayTarget = link.querySelector('.CapsuleImageCtn, .game_capsule, .spotlight_img, [class*="HeroCapsuleImageContainer"]');
                if (!overlayTarget && (link.querySelector('img') || link.querySelector('div'))) {
                    overlayTarget = link;
                }
            }

            // Ancestor check for existing badges
            if (!expandedContainer && overlayTarget) {
                let ancestor = link;
                let foundExistingBadge = false;
                for(let i = 0; i < 4; i++) {
                    if(!ancestor.parentElement) break;
                    ancestor = ancestor.parentElement;
                    if(ancestor.querySelector('.ilap-ignored-overlay')) {
                        foundExistingBadge = true;
                        break;
                    }
                }
                if (foundExistingBadge) return;
            }

            if (overlayTarget && !overlayTarget.querySelector('.ilap-ignored-overlay')) {
                const overlay = document.createElement('div'); 
                overlay.className = 'ilap-ignored-overlay'; 
                overlay.innerHTML = `IGNORED<div class="ilap-tooltip">Auto-applied by ILAP.</div>`;
                overlayTarget.appendChild(overlay); 
                overlayTarget.style.position = 'relative'; 
                overlayTarget.dataset.processed = 'true';
            }
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
            // Support two different ignore reasons based on key
            if (event[shortcutConfig.default]) reason = 0;
            else if (shortcutConfig.platform !== 'off' && event[shortcutConfig.platform]) reason = 2;

            if (reason === -1) return;

            let gameCard = event.target.closest(CARD_SELECTORS);
            if (!gameCard) {
                const expandedContainer = event.target.closest('[class*="LibraryAssetExpandedDisplay"]');
                if (expandedContainer) {
                    const anyLink = expandedContainer.querySelector(CARD_SELECTORS);
                    if (anyLink) gameCard = anyLink;
                }
            }

            if (!gameCard) return;

            const href = gameCard.getAttribute('href'); 
            const appidMatch = href.match(/\/app\/(\d+)/); 
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