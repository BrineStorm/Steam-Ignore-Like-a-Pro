(function() {
    'use strict';
    
    // === State ===
    let isRunning = false; 
    let processedGames = 0; 
    
    // UI Elements (Cached)
    let ui_Container = null;
    let ui_Button = null;
    
    let isThrottled = false;
    let skipPositiveGames = false;
    
    // Watchdog
    let lastActivityTime = 0;
    const WATCHDOG_TIMEOUT = 45000;
    
    // Constants
    const IGNORE_BUTTON_ACTIVE_CLASS = '_2D_EZlAEopCvqU0_w21FdH';
    const STEAM_BLUE_RGB = 'rgb(102, 192, 244)';
    const CONTAINER_ID = 'spt-queue-controls'; 
    const CONTAINER_CLASS = 'spt-controls-container';
    
    // SVG Paths
    const NEXT_ARROW_SVG_PATH_START = "M16.0855";
    const IGNORE_ICON_SVG_PATH_START = "M600,96c";

    // === Helpers ===
    function findElement(selectors, context = document) { 
        for (let selector of selectors) { 
            const element = context.querySelector(selector); 
            if (element) return element; 
        } 
        return null; 
    }

    function clickWithDelay(element, delay = 1000) { 
        return new Promise(resolve => { 
            if (element) {
                element.click();
                lastActivityTime = Date.now();
            } else {
                console.error("[SPT] clickWithDelay received null");
            }
            setTimeout(resolve, delay); 
        }); 
    }
    
    function waitForActiveState(slide, className, timeout = 2000) {
        return new Promise(resolve => {
            if (slide.querySelector(`.${className}`)) return resolve(true);
            const observer = new MutationObserver((mutations, obs) => { 
                if (slide.querySelector(`.${className}`)) { 
                    obs.disconnect(); 
                    resolve(true); 
                } 
            });
            observer.observe(slide, { attributes: true, subtree: true, attributeFilter: ['class'] });
            setTimeout(() => { observer.disconnect(); resolve(false); }, timeout);
        });
    }

    function getGameNameFromSlide(slide) {
        if (!slide) return "Unknown Game";
        const widgetTitle = slide.querySelector('div[class*="StoreSaleWidgetTitle"]');
        if (widgetTitle) return widgetTitle.textContent.trim();
        const links = slide.querySelectorAll('a[href*="/app/"]');
        for (const link of links) {
            if (link.textContent.trim().length > 0 && !link.querySelector('img')) {
                return link.textContent.trim();
            }
        }
        return "Auto-Ignored Game";
    }

    function isGamePositive(slide) {
        const reviewLink = slide.querySelector('a[href*="#app_reviews_hash"]');
        if (!reviewLink) return false;
        const allChildren = reviewLink.querySelectorAll('*');
        if (window.getComputedStyle(reviewLink).color === STEAM_BLUE_RGB) return true;
        for (const child of allChildren) {
            const color = window.getComputedStyle(child).color;
            if (color === STEAM_BLUE_RGB) return true;
        }
        return false;
    }

    function startWatchdog() {
        lastActivityTime = Date.now();
        const timer = setInterval(() => {
            if (!isRunning) {
                clearInterval(timer);
                return;
            }
            if (Date.now() - lastActivityTime > WATCHDOG_TIMEOUT) {
                console.error("[SPT] Watchdog: Timeout. Stopping.");
                isRunning = false;
                clearInterval(timer);
            }
        }, 1000);
    }

    // === Strategy: Find Next Button ===
    function getNextButton(dialog) {
        // 1. Find ALL elements with the arrow SVG path
        const allPaths = Array.from(dialog.querySelectorAll('path'));
        const arrowPaths = allPaths.filter(p => {
            const d = p.getAttribute('d');
            return d && d.startsWith(NEXT_ARROW_SVG_PATH_START);
        });

        // 2. Select the LAST one.
        // NOTE: In Steam's DOM, the "Left/Previous" button comes first, 
        // and the "Right/Next" button comes second.
        // We MUST select the LAST found element to go RIGHT.
        if (arrowPaths.length > 0) {
            const rightArrowPath = arrowPaths[arrowPaths.length - 1]; 
            return rightArrowPath.closest('div[class*="Focusable"]');
        }
        
        // 3. Fallback: Class Hash (Also select last)
        const arrowClassBtns = dialog.querySelectorAll('div[role="button"][class*="_2sZ7D"]');
        if (arrowClassBtns.length >= 2) return arrowClassBtns[arrowClassBtns.length - 1];

        return null;
    }

    // === Strategy: Find Ignore Button ===
    function getIgnoreButton(slide, dialog) {
        const paths = slide.querySelectorAll('path');
        for (const path of paths) {
            const d = path.getAttribute('d');
            if (d && d.startsWith(IGNORE_ICON_SVG_PATH_START)) {
                return path.closest('div[class*="Focusable"]');
            }
        }
        return null;
    }

    // === Strategy: Find Continue Button ===
    function getContinueButton(slide) {
        let btn = slide.querySelector('div[class*="Primary"][class*="Focusable"]'); 
        if (btn) return btn;

        const summaryButtonContainer = slide.querySelector('div[class*="YF"][class*="Panel"]'); 
        if (summaryButtonContainer) {
            const buttons = summaryButtonContainer.querySelectorAll('div[class*="Focusable"]');
            if (buttons.length > 0) return buttons[buttons.length - 1];
        }

        const texts = [
            'Continue', 'Next', 'Done', '€‚Œ', 'Fortfahren', 'Weiter',
            'Pokraovat', 'Dal', 'Hotovo', 'Continuar', 'Continuer', 'Avanti', 'Dalej'
        ];
        const allBtns = slide.querySelectorAll('div[role="button"], div[class*="Focusable"]');
        for (const b of allBtns) {
            if (texts.some(t => b.textContent.trim().includes(t))) return b;
        }
        return null;
    }

    // === Core Process ===
    async function processGame() {
        try {
            const dialog = document.querySelector('div[role="dialog"]');
            if (!dialog) return false;

            // 1. Find Slides
            let slidesContainer = dialog.querySelector('._3q6eNRFBrPSFSGEn8uRFZ3'); 
            if (!slidesContainer) {
                const sampleSlide = dialog.querySelector('div[class*="Focusable"][class*="Panel"]');
                if (sampleSlide) slidesContainer = sampleSlide.parentElement;
            }

            const ACTIVE_SLIDE_INDEX = 2; 
            if (!slidesContainer || slidesContainer.children.length <= ACTIVE_SLIDE_INDEX) {
                await new Promise(r => setTimeout(r, 500));
                return false; 
            }

            const activeSlide = slidesContainer.children[ACTIVE_SLIDE_INDEX];
            
            // 2. Find Next Button
            const nextButton = getNextButton(dialog);

            // 3. Detect End of Queue
            let isEndOfQueue = false;
            if (!nextButton) {
                isEndOfQueue = true;
                if (!activeSlide.querySelector('div[class*="EndOfQueue_container"]')) {
                    console.log("[SPT] Next button not found (Assuming End).");
                }
            } else {
                const classList = Array.from(nextButton.classList);
                const hashedClasses = classList.filter(c => c.startsWith('_'));
                if (hashedClasses.length < 3) isEndOfQueue = true;
            }

            if (!isEndOfQueue && activeSlide.querySelector('div[class*="EndOfQueue_container"]')) {
                isEndOfQueue = true;
            }

            // 4. Act
            if (isEndOfQueue) {
                const continueButton = getContinueButton(activeSlide);
                if (continueButton) {
                    await clickWithDelay(continueButton, 2500);
                    return true;
                } else {
                    console.error("[SPT] CRITICAL: Continue button NOT found.");
                    return false;
                }

            } else {
                if (skipPositiveGames && isGamePositive(activeSlide)) {
                    console.log(`[SPT] Skipping Positive: ${getGameNameFromSlide(activeSlide)}`);
                    if (nextButton) {
                        await clickWithDelay(nextButton, 800);
                        return true;
                    }
                }
                
                const ignoreButton = getIgnoreButton(activeSlide, dialog);

                if (ignoreButton) {
                    if (!ignoreButton.classList.contains(IGNORE_BUTTON_ACTIVE_CLASS) && 
                        !activeSlide.querySelector(`.${IGNORE_BUTTON_ACTIVE_CLASS}`)) {
                        
                        const gameName = getGameNameFromSlide(activeSlide);
                        
                        await clickWithDelay(ignoreButton, 100); 

                        const confirmed = await waitForActiveState(activeSlide, IGNORE_BUTTON_ACTIVE_CLASS, 2000);
                        
                        if (confirmed) {
                            processedGames++;
                            // UPDATE BUTTON TEXT IMMEDIATELY
                            updateButtonState(); 
                            
                            if (window.SPT && window.SPT.saveStats) {
                                window.SPT.saveStats(gameName, "Discovery Queue");
                            }
                        } else {
                            console.error("[SPT] CRITICAL: Ignore failed (Timeout).");
                            return false; 
                        }
                        
                        await new Promise(r => setTimeout(r, 300));
                    }
                } else {
                    console.error("[SPT] CRITICAL: Ignore button NOT found on slide.");
                    return false;
                }

                if (nextButton) {
                    await clickWithDelay(nextButton, 800);
                    return true;
                } else {
                    console.error("[SPT] Next button missing?");
                    return false;
                }
            }

        } catch (e) {
            console.error("[SPT] Error:", e);
            return false;
        }
    }

    async function mainLoop() {
        if (isRunning) return;
        isRunning = true;
        processedGames = 0;
        console.log("%c[SPT] STARTED", "background: #5c7e10; color: white;"); 
        
        updateButtonState();
        startWatchdog();

        if (!document.querySelector('div[role="dialog"]')) {
             const launchBtn = findElement(['div._2-tz2hqtOXPPtMnVPHNSdx', 'div.WidgetHeaderCtn']);
             if (launchBtn) await clickWithDelay(launchBtn, 2000);
             else { isRunning = false; updateButtonState(); return; }
        }

        while (isRunning) {
            const success = await processGame();
            if (!success) { 
                console.log("[SPT] Loop STOPPED.");
                isRunning = false; 
                break; 
            }
            await new Promise(r => setTimeout(r, 500));
        }
        updateButtonState();
    }

    function toggleScript() {
        if (isRunning) {
            isRunning = false;
        } else if (!isThrottled) {
            isThrottled = true;
            mainLoop();
            setTimeout(() => { isThrottled = false; }, 1000);
        }
        updateButtonState();
    }

    function togglePositiveSkip(e) {
        skipPositiveGames = e.target.checked;
    }

    // Helper to update text without recreating elements
    function updateButtonState() {
        if (!ui_Button) return;
        
        if (isRunning) {
            ui_Button.innerHTML = `<span class="btn-symbol">â</span> Stop (${processedGames})`;
            ui_Button.classList.add('running');
            ui_Button.style.backgroundColor = '#d32f2f';
        } else {
            ui_Button.innerHTML = `<span class="btn-symbol">â</span> Start Auto Ignore`;
            ui_Button.classList.remove('running');
            ui_Button.style.backgroundColor = '#5c7e10';
        }
    }

    // One-time creation of the control panel in memory
    function createControls() {
        const container = document.createElement('div');
        container.className = CONTAINER_CLASS;
        container.id = CONTAINER_ID;

        const label = document.createElement('label');
        label.className = 'spt-checkbox-label';
        label.title = "If enabled, games with 'Positive' (Blue) reviews will be skipped, not ignored.";
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'spt-checkbox';
        checkbox.addEventListener('change', togglePositiveSkip);
        
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode("Keep High Score"));
        
        const button = document.createElement('button');
        button.id = "queue-auto-ignore-btn";
        button.addEventListener('click', toggleScript);
        
        container.appendChild(label);
        container.appendChild(button);
        
        ui_Button = button;
        return container;
    }

    function setupInterface() {
        // Create the UI object once
        if (!ui_Container) {
            ui_Container = createControls();
        }

        setInterval(() => {
            const modal = document.querySelector('.FullModalOverlay div[role="dialog"]');
            
            // If modal exists, ensure our controls are inside
            if (modal) {
                const header = modal.querySelector('div[class*="_1ewUwegRciiNydBWSQRCX-"]'); 
                const closeBtn = header ? header.querySelector('div[class*="_22Bfzcdg2l-RQEn-qKSIol"]') : null; 
                
                if (header && closeBtn) {
                    // Only append if it's NOT already there.
                    // .contains() is standard DOM API, very efficient.
                    // This prevents flickering because we don't remove/add, we just ensure presence.
                    if (!header.contains(ui_Container)) {
                        header.insertBefore(ui_Container, closeBtn.parentElement);
                        // Also sync state in case it was re-inserted
                        updateButtonState();
                    }
                }
            } else {
                // If modal is closed, stop script and ensure UI is detached
                if (isRunning) {
                    isRunning = false;
                    updateButtonState();
                }
                if (ui_Container.parentElement) {
                    ui_Container.remove();
                }
            }
        }, 500);
    }
    
    window.addEventListener('load', setupInterface);
})();