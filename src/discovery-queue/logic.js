(function() {
    'use strict';
    
    window.ILAP = window.ILAP || {};
    window.ILAP.QueueLogic = {};

    // Settings & State
    let isRunning = false;
    let processedGames = 0;
    let skipPositiveGames = false;
    let updateUICallback = null;

    // SVG Signatures
    const NEXT_ARROW_SVG_START = "M16.0855";
    const IGNORE_ICON_SVG_START = "M600,96c";
    
    // Steam Colors
    const STEAM_BLUE_RGB = 'rgb(102, 192, 244)'; 

    // --- Helpers ---

    function clickWithDelay(element, delay = 1000) {
        return new Promise(resolve => {
            if (element) element.click();
            setTimeout(resolve, delay);
        });
    }

    function isButtonActive(element) {
        if (!element) return false;
        const hashedClasses = Array.from(element.classList).filter(c => c.startsWith('_'));
        return hashedClasses.length >= 2;
    }

    function waitForActiveState(element, timeout = 2500) {
        return new Promise(resolve => {
            if (isButtonActive(element)) return resolve(true);
            const obs = new MutationObserver(() => {
                if (isButtonActive(element)) {
                    obs.disconnect();
                    resolve(true);
                }
            });
            obs.observe(element, { attributes: true, attributeFilter: ['class'] });
            setTimeout(() => { obs.disconnect(); resolve(isButtonActive(element)); }, timeout);
        });
    }

    // === FIX: Robust Name Finder ===
    function getGameName(slide) {
        // 1. Try legacy class (just in case)
        const title = slide.querySelector('div[class*="StoreSaleWidgetTitle"]');
        if (title) return title.textContent.trim();

        // 2. Structural Search: Find the link with text
        // Look for links pointing to an app
        const links = slide.querySelectorAll('a[href*="/app/"]');
        for (const link of links) {
            // Logic: The title link usually has text content, but NO image inside it.
            // (The big cover image is also a link, but it contains an <img> tag)
            const hasText = link.textContent.trim().length > 0;
            const hasImg = link.querySelector('img');
            
            if (hasText && !hasImg) {
                return link.textContent.trim();
            }
        }
        
        // 3. Last Resort: Parse AppID from URL
        for (const link of links) {
             const href = link.getAttribute('href');
             const match = href.match(/\/app\/(\d+)/);
             if (match) return `AppID ${match[1]}`;
        }

        return "Unknown Game";
    }

    function isPositive(slide) {
        const reviewLink = slide.querySelector('a[href*="#app_reviews_hash"]');
        if (!reviewLink) return false;
        
        const checkColor = (el) => window.getComputedStyle(el).color === STEAM_BLUE_RGB;

        if (checkColor(reviewLink)) return true;
        return Array.from(reviewLink.querySelectorAll('*')).some(c => checkColor(c));
    }

    // --- Scanners ---

    function getActiveSlide(dialog) {
        const container = dialog.querySelector('._3q6eNRFBrPSFSGEn8uRFZ3') || 
                          dialog.querySelector('div[class*="Focusable"][class*="Panel"]')?.parentElement;
        return (container && container.children.length > 2) ? container.children[2] : null;
    }

    function getIgnoreButton(slide) {
        const paths = slide.querySelectorAll('path');
        for (const p of paths) {
            if (p.getAttribute('d')?.startsWith(IGNORE_ICON_SVG_START)) 
                return p.closest('div[class*="Focusable"]');
        }
        return slide.querySelector('div[aria-label="Ignore"]');
    }

    function getNextButton(dialog) {
        const paths = Array.from(dialog.querySelectorAll('path'))
            .filter(p => p.getAttribute('d')?.startsWith(NEXT_ARROW_SVG_START));
        
        if (paths.length > 0) return paths[paths.length - 1].closest('div[class*="Focusable"]');
        
        const arrowBtns = dialog.querySelectorAll('div[class*="Arrow"]');
        return arrowBtns.length > 0 ? arrowBtns[arrowBtns.length - 1] : null;
    }

    function getContinueButton(slide) {
        const candidates = Array.from(slide.querySelectorAll('div[class*="Focusable"]'));
        const textButtons = candidates.filter(el => {
            if (!el.textContent.trim()) return false;
            if (el.querySelector('svg')) return false;
            if (el.offsetParent === null) return false;
            return true;
        });

        if (textButtons.length > 0) {
            return textButtons[textButtons.length - 1];
        }
        return null;
    }

    // --- Main Loop ---

    async function processOneGame(dialog) {
        const slide = getActiveSlide(dialog);
        if (!slide) return false;

        const nextBtn = getNextButton(dialog);
        
        if (!nextBtn) {
            const continueBtn = getContinueButton(slide);
            if (continueBtn) {
                 await clickWithDelay(continueBtn, 2500);
                 return true; 
            }
            console.log("[ILAP] End of queue reached. Stopping script.");
            return false; 
        }

        if (skipPositiveGames && isPositive(slide)) {
            console.log(`[ILAP] Skipping Positive: ${getGameName(slide)}`);
            await clickWithDelay(nextBtn, 800);
            return true;
        }

        const ignoreBtn = getIgnoreButton(slide);
        
        if (ignoreBtn) {
            if (!isButtonActive(ignoreBtn)) {
                
                // Get name BEFORE clicking, just in case DOM changes
                const name = getGameName(slide);
                
                await clickWithDelay(ignoreBtn, 150);
                const success = await waitForActiveState(ignoreBtn);
                if (success) {
                    processedGames++;
                    if (updateUICallback) updateUICallback(isRunning, processedGames);
                    window.ILAP.saveStats(name, "Queue");
                }
            }
        } else {
            const continueBtn = getContinueButton(slide);
            if (continueBtn) {
                 await clickWithDelay(continueBtn, 2500);
                 return true;
            }
            return false;
        }

        await clickWithDelay(nextBtn, 800);
        return true;
    }

    // --- Public API ---

    window.ILAP.QueueLogic.init = function(uiCallback) {
        updateUICallback = uiCallback;
    };

    window.ILAP.QueueLogic.setSkipPositive = function(val) {
        skipPositiveGames = val;
    };

    window.ILAP.QueueLogic.toggle = async function() {
        if (isRunning) {
            isRunning = false;
            updateUICallback(false, processedGames);
            return;
        }

        isRunning = true;
        processedGames = 0;
        updateUICallback(true, 0);

        const dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) {
            const launcher = document.querySelector('div.WidgetHeaderCtn'); 
            if (launcher) await clickWithDelay(launcher, 2000);
        }

        while (isRunning) {
            const dlg = document.querySelector('div[role="dialog"]');
            if (!dlg) break;
            
            const result = await processOneGame(dlg);
            if (!result) break;
            
            await new Promise(r => setTimeout(r, 500));
        }

        isRunning = false;
        updateUICallback(false, processedGames);
    };

})();