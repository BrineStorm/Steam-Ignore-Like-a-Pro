(function() {
    'use strict';

    let sessionIgnoredIDs = new Set();
    const CARD_SELECTORS = 'a[href*="/app/"]';

    function markCardAsProcessed(appid) {
        // === FIX: URL Selector ===
        // Changed from `a[href*="/app/${appid}/"]` to `a[href*="/app/${appid}"]`
        // Steam sometimes omits the trailing slash in big banners (e.g., .../app/123?snr=...)
        let allGameLinks = Array.from(document.querySelectorAll(`a[href*="/app/${appid}"]`));

        // Filter out false positives (e.g. searching for app/12 matching app/1234)
        allGameLinks = allGameLinks.filter(link => {
            const href = link.getAttribute('href');
            // Ensure the character after ID is not a digit
            const regex = new RegExp(`/app/${appid}([^0-9]|$)`);
            return regex.test(href);
        });

        // Sorting: Images first
        allGameLinks.sort((a, b) => {
            const aHasImg = a.querySelector('img') || a.querySelector('.CapsuleImageCtn');
            const bHasImg = b.querySelector('img') || b.querySelector('.CapsuleImageCtn');
            if (aHasImg && !bHasImg) return -1;
            if (!aHasImg && bHasImg) return 1;
            return 0;
        });

        allGameLinks.forEach(link => {
            // === 1. POPUP PROTECTION ===
            if (link.closest('#global_hover')) {
                const hasText = link.textContent.trim().length > 0;
                const hasStructure = link.querySelector('div, img');
                if (hasText && !hasStructure) return;
            }

            // === 2. TARGET SELECTION ===
            let overlayTarget = null;

            // --- SPECIAL CASE: "LibraryAssetExpandedDisplay" ---
            const expandedContainer = link.closest('[class*="LibraryAssetExpandedDisplay"]');
            
            if (expandedContainer) {
                // Always force badge onto the main image container inside this banner
                const mainImg = expandedContainer.querySelector('img');
                if (mainImg) {
                    overlayTarget = mainImg.parentElement;
                }
            } 
            else {
                // --- STANDARD LOGIC ---
                overlayTarget = link.querySelector('.CapsuleImageCtn, .game_capsule, .spotlight_img, [class*="HeroCapsuleImageContainer"]');
                
                // Fallback
                if (!overlayTarget) {
                    if (link.querySelector('img') || link.querySelector('div')) {
                        overlayTarget = link;
                    }
                }
            }

            // === 3. ANCESTOR CHECK ("Family" Logic) ===
            // We skip this check for ExpandedDisplay to ensure the main image gets it 
            // even if we triggered processing from a text link.
            if (!expandedContainer && overlayTarget) {
                let ancestor = link;
                let foundExistingBadge = false;
                for(let i = 0; i < 4; i++) {
                    if(!ancestor.parentElement) break;
                    ancestor = ancestor.parentElement;
                    if(ancestor.querySelector('.spt-ignored-overlay')) {
                        foundExistingBadge = true;
                        break;
                    }
                }
                if (foundExistingBadge) return;
            }

            // === 4. APPLY BADGE ===
            if (overlayTarget && !overlayTarget.querySelector('.spt-ignored-overlay')) {
                const overlay = document.createElement('div'); 
                overlay.className = 'spt-ignored-overlay'; 
                
                overlay.innerHTML = `
                    IGNORED
                    <div class="spt-tooltip">
                        Game ignored. It may still appear on Steam pages due to caching/internal logic. 
                        You can verify status on the game's store page.
                    </div>
                `;
                
                overlayTarget.appendChild(overlay); 
                overlayTarget.style.position = 'relative'; 
                overlayTarget.dataset.processed = 'true';
            }
        });
    }

    function ignoreGame(appid, sessionid, gameCardElement) {
        const body = `sessionid=${sessionid}&appid=${appid}&snr=&ignore_reason=0`;
        
        fetch('https://store.steampowered.com/recommended/ignorerecommendation/', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, 
            body: body 
        })
        .then(res => {
            if (res.ok) {
                const gameName = window.SPT.getGameName(appid, gameCardElement);
                
                sessionIgnoredIDs.add(appid);
                sessionStorage.setItem(window.SPT.SESSION_IGNORED_KEY, JSON.stringify(Array.from(sessionIgnoredIDs)));
                markCardAsProcessed(appid);
                window.SPT.saveStats(gameName, "Manual (Ctrl+Click)");
            }
        });
    }

    function applySessionState() { 
        sessionIgnoredIDs.forEach(appid => { markCardAsProcessed(appid); }); 
    }

    function setupObserver() { 
        const observer = new MutationObserver(() => { applySessionState(); }); 
        observer.observe(document.body, { childList: true, subtree: true }); 
    }

    function setupClickListener() {
        document.body.addEventListener('click', (event) => {
            if (!event.ctrlKey) return;

            // Handle standard cards + Expanded Display structure
            let gameCard = event.target.closest(CARD_SELECTORS);
            
            // Fallback for clicks caught by deep divs in Expanded Display
            if (!gameCard) {
                const expandedContainer = event.target.closest('[class*="LibraryAssetExpandedDisplay"]');
                if (expandedContainer) {
                    const anyLink = expandedContainer.querySelector(CARD_SELECTORS);
                    if (anyLink) gameCard = anyLink;
                }
            }

            if (!gameCard) return;

            const href = gameCard.getAttribute('href'); 
            
            // === FIX: REGEX ===
            // Removed the trailing slash requirement: /\/app\/(\d+)\// -> /\/app\/(\d+)/
            const appidMatch = href.match(/\/app\/(\d+)/); 
            
            if (!appidMatch) return;

            const appid = appidMatch[1]; 
            if (sessionIgnoredIDs.has(appid)) return;

            event.preventDefault(); 
            event.stopPropagation();
            
            const sessionid = window.SPT.getSessionID();
            if (sessionid) { 
                ignoreGame(appid, sessionid, gameCard); 
            }
        }, true);
    }

    function init() {
        try {
            const storedIDs = sessionStorage.getItem(window.SPT.SESSION_IGNORED_KEY);
            if (storedIDs) { sessionIgnoredIDs = new Set(JSON.parse(storedIDs)); }
        } catch (e) { 
            sessionStorage.removeItem(window.SPT.SESSION_IGNORED_KEY); 
        }

        setupClickListener();
        applySessionState();
        setupObserver();
    }

    init();
})();