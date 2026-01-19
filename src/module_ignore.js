(function() {
    'use strict';

    // State management
    let sessionIgnoredIDs = new Set();
    let shortcutConfig = { default: 'ctrlKey', platform: 'off', enabled: true };

    // Factory: Creates the badge DOM element
    function createBadgeElement(appid, typeClass) {
        const overlay = document.createElement('div');
        overlay.className = `ilap-ignored-overlay ${typeClass}`;
        overlay.dataset.ilapAppid = appid;
        
        overlay.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        const iconUrl = chrome.runtime.getURL('icons/icon16.png');

        overlay.innerHTML = `
            IGNORED
            <div class="ilap-tooltip">
                <div style="display: flex; align-items: center; gap: 6px; white-space: nowrap;">
                    <span>Ignore applied by</span>
                    <img src="${iconUrl}" style="width: 16px; height: 16px; vertical-align: middle;">
                    <span> extension</span>
                </div>
            </div>
        `;
        return overlay;
    }

    /**
     * Strategy: Finds the best visual target for the badge.
     */
    function findVisualCardContainer(linkElement) {
        // 1. Special Case: List Items (.tab_item)
        const listItem = linkElement.closest('.tab_item');
        if (listItem) return { element: listItem, type: 'list' };

        // 2. Direct Hit: Are we already inside a known Image Container?
        const directImg = linkElement.closest(`
            [class*="CapsuleImageCtn"], 
            [class*="HeroCapsuleImageContainer"],
            .spotlight_img, 
            .capsule_image,
            .main_capsule
        `);
        if (directImg) return { element: directImg, type: 'grid' };

        // 3. Fallback: Find the General Card Wrapper
        // Added '.store_main_capsule' for the Homepage Carousel
        const generalCard = linkElement.closest(`
            .game_capsule, 
            .dailydeal_cap, 
            .small_cap, 
            .bundle_base_discount, 
            [class*="ImpressionTrackedElement"],
            div[class*="StoreSaleWidget"],
            [class*="LibraryAssetExpandedDisplay"],
            .store_main_capsule
        `);
        
        if (generalCard) {
            // --- SMART REDIRECT LOGIC ---
            // Look for the image container INSIDE the generic wrapper.
            // Added '.main_capsule' to target the background-image div in the carousel.
            const innerImage = generalCard.querySelector(`
                [class*="CapsuleImageCtn"], 
                [class*="HeroCapsuleImageContainer"],
                .capsule_image,
                .main_capsule,
                img[class*="Capsule"]
            `);
            
            if (innerImage) {
                // If it's the main carousel, use 'hero' badge for better sizing
                const type = generalCard.classList.contains('store_main_capsule') ? 'hero' : 'grid';
                return { element: innerImage, type: type };
            }
            return { element: generalCard, type: 'standard' };
        }

        // 4. Last resort: If link wraps an image but has no known class
        const hasBigImage = linkElement.querySelector('img, video');
        if (hasBigImage) {
            return { element: linkElement, type: 'grid' };
        }

        return null;
    }

    /**
     * Proximity Check:
     * Prevents duplicates by checking if an ancestor is already marked.
     */
    function isBadgeNearby(startElement, appid) {
        // === EXCEPTION FOR LISTS & CAROUSELS ===
        // If the element is a List Item OR a Carousel Item, it is a self-contained unit.
        // We MUST NOT check its parent (the list/carousel container), because that parent
        // contains other siblings that might have badges.
        
        // Check for Tab Items OR the Main Carousel Capsule
        if (startElement.classList.contains('tab_item') || startElement.closest('.store_main_capsule')) {
            return startElement.dataset.ilapIgnoreId === appid || 
                   !!startElement.querySelector(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`);
        }

        // === STANDARD LOGIC FOR GRIDS/CARDS ===
        let current = startElement;
        // Traverse up to find if this component is already handled
        for (let i = 0; i < 7; i++) {
            if (!current || current === document.body) break;

            // Stop boundaries to avoid bleeding scope
            if (current.id && current.id.includes('tab_content')) break;
            if (current.classList.contains('tab_content')) break;
            if (current.classList.contains('carousel_items')) break; // Stop at carousel container

            if (current.dataset.ilapIgnoreId === appid) return true;

            const existingBadge = current.querySelector(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`);
            if (existingBadge) {
                if (existingBadge.parentElement !== startElement) {
                     return true;
                }
            }
            current = current.parentElement;
        }
        return false;
    }

    function applyBadgeToContainer(containerObj, appid) {
        const { element, type } = containerObj;

        // 1. Strict Container Check
        if (element.dataset.ilapState === 'processed') {
            return;
        }

        // 2. Proximity/Radius Check
        if (isBadgeNearby(element, appid)) {
            element.dataset.ilapState = 'processed'; 
            return;
        }

        // Determine variant style
        let variantClass = 'ilap-grid-badge';
        if (type === 'list') {
            variantClass = 'ilap-list-badge';
        } else if (type === 'hero' || element.classList.contains('spotlight_img')) {
            variantClass = 'ilap-hero-badge';
        }

        // DOM Mutation
        const badge = createBadgeElement(appid, variantClass);
        
        // Ensure relative positioning
        if (getComputedStyle(element).position === 'static') {
            element.classList.add('ilap-tagged-container');
        }

        element.appendChild(badge);
        element.dataset.ilapState = 'processed';
        element.dataset.ilapIgnoreId = appid;
    }

    function markCardAsProcessed(appid) {
        const selector = `a[href*="/app/${appid}"]`;
        const candidates = document.querySelectorAll(selector);

        candidates.forEach(link => {
            const href = link.getAttribute('href');
            const match = new RegExp(`/app/${appid}(/|\\?|$)`).test(href);
            if (!match) return;

            const visualContainer = findVisualCardContainer(link);
            
            if (visualContainer) {
                applyBadgeToContainer(visualContainer, appid);
            }
        });
    }

    // --- Action Handlers ---

    function ignoreGame(appid, reason, gameCardElement) {
        window.ILAP.apiIgnoreGame(appid, reason).then(success => {
            if (success) {
                const gameName = window.ILAP.getGameName(appid, gameCardElement);
                const sourceName = reason === 0 ? "Default Ignore" : "Played Elsewhere";
                
                sessionIgnoredIDs.add(appid);
                try {
                    sessionStorage.setItem(window.ILAP.SESSION_IGNORED_KEY, JSON.stringify(Array.from(sessionIgnoredIDs)));
                } catch (e) { console.warn('ILAP: Storage quota exceeded'); }
                
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

            const linkTarget = event.target.closest('a[href*="/app/"]');
            if (!linkTarget) return;

            const href = linkTarget.getAttribute('href');
            const appidMatch = href.match(/\/app\/(\d+)/);
            if (!appidMatch) return;

            const appid = appidMatch[1];
            
            if (sessionIgnoredIDs.has(appid)) return;

            event.preventDefault(); 
            event.stopPropagation();
            
            const containerInfo = findVisualCardContainer(linkTarget);
            const contextEl = containerInfo ? containerInfo.element : linkTarget;

            ignoreGame(appid, reason, contextEl);
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

        const runBatch = () => {
            sessionIgnoredIDs.forEach(appid => markCardAsProcessed(appid));
        };

        runBatch();

        let timeout;
        const observer = new MutationObserver((mutations) => { 
            let shouldRun = false;
            for(const m of mutations) {
                if (m.addedNodes.length > 0) {
                    shouldRun = true;
                    break;
                }
            }
            if (shouldRun) {
                clearTimeout(timeout);
                timeout = setTimeout(runBatch, 200); 
            }
        }); 
        
        const container = document.getElementById('page_root') || document.body;
        observer.observe(container, { childList: true, subtree: true }); 
    }

    init();
})();