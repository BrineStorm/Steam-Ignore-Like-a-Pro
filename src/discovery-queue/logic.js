(function() {
    'use strict';
    
    // Namespaces
    window.ILAP = window.ILAP || {};
    window.ILAP.QueueLogic = {};

    // Constants (SVG Signatures for robust detection)
    const SVG_PATHS = {
        NEXT_ARROW: "M16.0855",
        IGNORE_ICON: "M600,96c"
    };

    const STEAM_COLORS = {
        BLUE: 'rgb(102, 192, 244)'
    };

    /**
     * SRP: Responsible ONLY for finding elements within the Queue Modal.
     * Hides DOM implementation details from the business logic.
     */
    class SlideScanner {
        static getActiveSlide(dialog) {
            // Strategy: Look for the specific container holding the 3 cards (Previous, Current, Next)
            const container = dialog.querySelector('._3q6eNRFBrPSFSGEn8uRFZ3') || 
                              dialog.querySelector('div[class*="Focusable"][class*="Panel"]')?.parentElement;
            // The active slide is usually the 3rd child in the React structure
            return (container && container.children.length > 2) ? container.children[2] : null;
        }

        static getNextButton(dialog) {
            // Strategy 1: SVG Path match
            const paths = Array.from(dialog.querySelectorAll('path'))
                .filter(p => p.getAttribute('d')?.startsWith(SVG_PATHS.NEXT_ARROW));
            
            if (paths.length > 0) return paths[paths.length - 1].closest('div[class*="Focusable"]');
            
            // Strategy 2: Class Name fallback
            const arrowBtns = dialog.querySelectorAll('div[class*="Arrow"]');
            return arrowBtns.length > 0 ? arrowBtns[arrowBtns.length - 1] : null;
        }

        static getIgnoreButton(slide) {
            const paths = slide.querySelectorAll('path');
            for (const p of paths) {
                if (p.getAttribute('d')?.startsWith(SVG_PATHS.IGNORE_ICON)) 
                    return p.closest('div[class*="Focusable"]');
            }
            return slide.querySelector('div[aria-label="Ignore"]');
        }

        static getContinueButton(slide) {
            // The "Finish" or "Continue" button is usually text-only (no SVG icons)
            const candidates = Array.from(slide.querySelectorAll('div[class*="Focusable"]'));
            const textButtons = candidates.filter(el => {
                if (!el.textContent.trim()) return false;
                if (el.querySelector('svg')) return false;
                if (el.offsetParent === null) return false; // Must be visible
                return true;
            });
            return textButtons.length > 0 ? textButtons[textButtons.length - 1] : null;
        }

        static getGameInfo(slide) {
            // Reuse the centralized GameNameExtractor from utils.js if available, 
            // or perform a local search optimized for Queue Slides.
            
            // 1. Name
            let name = "Unknown Game";
            if (window.ILAP.getGameName) {
                // Pass the slide as context
                // We fake an AppID '0' because we don't strictly need it for the name here
                name = window.ILAP.getGameName(0, slide);
            } else {
                // Fallback local logic
                const title = slide.querySelector('div[class*="StoreSaleWidgetTitle"]');
                if (title) name = title.textContent.trim();
            }

            // 2. Is Positive Review?
            const reviewLink = slide.querySelector('a[href*="#app_reviews_hash"]');
            let isPositive = false;
            
            if (reviewLink) {
                const checkColor = (el) => getComputedStyle(el).color === STEAM_COLORS.BLUE;
                if (checkColor(reviewLink) || Array.from(reviewLink.querySelectorAll('*')).some(c => checkColor(c))) {
                    isPositive = true;
                }
            }

            return { name, isPositive };
        }
    }

    /**
     * SRP: Manages the automation loop state and actions.
     */
    class QueueAutomator {
        constructor() {
            this.isRunning = false;
            this.processedCount = 0;
            this.config = { skipPositive: false };
            this.onUpdate = null; // Callback for UI
        }

        init(uiCallback) {
            this.onUpdate = uiCallback;
        }

        setSkipPositive(val) {
            this.config.skipPositive = val;
        }

        async toggle() {
            if (this.isRunning) {
                this.stop();
            } else {
                await this.start();
            }
        }

        stop() {
            this.isRunning = false;
            this._notifyUI();
        }

        async start() {
            this.isRunning = true;
            this.processedCount = 0;
            this._notifyUI();

            // Handle "Launcher" modal if present
            const launcher = document.querySelector('div.WidgetHeaderCtn'); 
            if (launcher) await this._clickWithDelay(launcher, 2000);

            await this._loop();
        }

        async _loop() {
            while (this.isRunning) {
                const dialog = document.querySelector('div[role="dialog"]');
                if (!dialog) break; // Modal closed
                
                const result = await this._processCurrentSlide(dialog);
                if (!result) break; // End of queue or error
                
                await new Promise(r => setTimeout(r, 500));
            }
            this.stop();
        }

        async _processCurrentSlide(dialog) {
            const slide = SlideScanner.getActiveSlide(dialog);
            if (!slide) return false;

            const nextBtn = SlideScanner.getNextButton(dialog);
            
            // Scenario 1: End of Queue (Summary Page)
            if (!nextBtn) {
                const continueBtn = SlideScanner.getContinueButton(slide);
                if (continueBtn) {
                     await this._clickWithDelay(continueBtn, 2500);
                     return true; 
                }
                console.log("[ILAP] Queue finished.");
                return false; 
            }

            const gameInfo = SlideScanner.getGameInfo(slide);

            // Scenario 2: Skip Positive Games
            if (this.config.skipPositive && gameInfo.isPositive) {
                console.log(`[ILAP] Skipping Positive: ${gameInfo.name}`);
                await this._clickWithDelay(nextBtn, 800);
                return true;
            }

            // Scenario 3: Ignore Game
            const ignoreBtn = SlideScanner.getIgnoreButton(slide);
            if (ignoreBtn) {
                if (!this._isButtonActive(ignoreBtn)) {
                    await this._clickWithDelay(ignoreBtn, 150);
                    const success = await this._waitForActiveState(ignoreBtn);
                    
                    if (success) {
                        this.processedCount++;
                        this._notifyUI();
                        if (window.ILAP.saveStats) {
                            window.ILAP.saveStats(gameInfo.name, "Queue");
                        }
                    }
                }
            } else {
                // Fallback: If no ignore button found (already ignored?), just continue
                const continueBtn = SlideScanner.getContinueButton(slide);
                if (continueBtn) {
                     await this._clickWithDelay(continueBtn, 2500);
                     return true;
                }
                return false;
            }

            // Move Next
            await this._clickWithDelay(nextBtn, 800);
            return true;
        }

        // --- Helpers ---

        _notifyUI() {
            if (this.onUpdate) this.onUpdate(this.isRunning, this.processedCount);
        }

        _clickWithDelay(element, delay = 1000) {
            return new Promise(resolve => {
                if (element) element.click();
                setTimeout(resolve, delay);
            });
        }

        _isButtonActive(element) {
            if (!element) return false;
            // Steam changes classes like "_2Pass..." -> hashed class. 
            // Usually active buttons have more classes.
            const hashedClasses = Array.from(element.classList).filter(c => c.startsWith('_'));
            return hashedClasses.length >= 2;
        }

        _waitForActiveState(element, timeout = 2500) {
            return new Promise(resolve => {
                if (this._isButtonActive(element)) return resolve(true);
                const obs = new MutationObserver(() => {
                    if (this._isButtonActive(element)) {
                        obs.disconnect();
                        resolve(true);
                    }
                });
                obs.observe(element, { attributes: true, attributeFilter: ['class'] });
                setTimeout(() => { obs.disconnect(); resolve(this._isButtonActive(element)); }, timeout);
            });
        }
    }

    // Export Singleton for Main
    window.ILAP.QueueLogic = new QueueAutomator();

})();