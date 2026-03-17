(function() {
    'use strict';
    
    window.ILAP = window.ILAP || {};
    window.ILAP.Discovery = window.ILAP.Discovery || {};

    const SVG_PATHS = {
        NEXT_ARROW: "M16.0855",
        IGNORE_ICON: "M600,96c"
    };

    const STEAM_COLORS = {
        BLUE: 'rgb(102, 192, 244)',
        MIXED: 'rgb(163, 139, 90)',
        NEGATIVE: 'rgb(163, 76, 37)'
    };

    class SlideScanner {
        static getActiveSlide(dialog) {
            const container = dialog.querySelector('._3q6eNRFBrPSFSGEn8uRFZ3') || 
                              dialog.querySelector('div[class*="Focusable"][class*="Panel"]')?.parentElement;
            return (container && container.children.length > 2) ? container.children[2] : null;
        }

        static getNextButton(dialog) {
            const paths = Array.from(dialog.querySelectorAll('path'))
                .filter(p => p.getAttribute('d')?.startsWith(SVG_PATHS.NEXT_ARROW));
            if (paths.length > 0) return paths[paths.length - 1].closest('div[class*="Focusable"]');
            
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
            const candidates = Array.from(slide.querySelectorAll('div[class*="Focusable"]'));
            const textButtons = candidates.filter(el => {
                if (!el.textContent.trim()) return false;
                if (el.querySelector('svg')) return false;
                if (el.offsetParent === null) return false; 
                return true;
            });
            return textButtons.length > 0 ? textButtons[textButtons.length - 1] : null;
        }

        static getGameInfo(slide, nameExtractorAdapter) {
            let name = "Unknown Game";
            
            const links = slide.querySelectorAll('a[href*="/app/"]');
            for (const link of links) {
                if (!link.querySelector('img') && !link.querySelector('video')) {
                    const text = link.textContent.trim();
                    if (text.length > 1 && text.length < 150) {
                        name = text;
                        break; 
                    }
                }
            }

            if (name === "Unknown Game") {
                const title = slide.querySelector('div[class*="StoreSaleWidgetTitle"]');
                if (title) {
                    name = title.textContent.trim();
                } else if (nameExtractorAdapter) {
                    name = nameExtractorAdapter.get(0, slide);
                }
            }

            // FIX: Improved review parsing for Discovery Queue
            const reviewLink = slide.querySelector('a[href*="#app_reviews_hash"]');
            
            // By default, if there are NO reviews or the block is missing, 
            // we assume the game is "safe" (isPositive = true) so it doesn't get auto-banned.
            let isPositive = true; 
            
            if (reviewLink) {
                // Let's check the color of the text to determine the exact review state
                let hasMixedOrNegative = false;
                
                const checkColor = (el) => {
                    const color = getComputedStyle(el).color;
                    return color === STEAM_COLORS.MIXED || color === STEAM_COLORS.NEGATIVE;
                };

                if (checkColor(reviewLink) || Array.from(reviewLink.querySelectorAll('*')).some(c => checkColor(c))) {
                    hasMixedOrNegative = true;
                }

                // If the text is specifically Mixed or Negative, then it's NOT positive (so it gets banned)
                if (hasMixedOrNegative) {
                    isPositive = false;
                }
            }

            return { name, isPositive };
        }
    }

    class DiscoveryQueueAutomator {
        constructor(apiAdapter, statsAdapter, nameExtractorAdapter) {
            if (!apiAdapter || typeof apiAdapter.ignore !== 'function') throw new TypeError("[ILAP] Invalid ApiAdapter passed to DiscoveryQueueAutomator");
            if (!statsAdapter || typeof statsAdapter.save !== 'function') throw new TypeError("[ILAP] Invalid StatsAdapter passed to DiscoveryQueueAutomator");
            if (!nameExtractorAdapter || typeof nameExtractorAdapter.get !== 'function') throw new TypeError("[ILAP] Invalid NameExtractorAdapter passed to DiscoveryQueueAutomator");

            this.api = apiAdapter;
            this.stats = statsAdapter;
            this.nameExtractor = nameExtractorAdapter; 
            
            this.isRunning = false;
            this.processedCount = 0;
            this.config = { skipPositive: false };
            this.onUpdateCallback = null; 
        }

        setUiObserver(callback) {
            this.onUpdateCallback = callback;
        }

        setSkipPositive(val) {
            this.config.skipPositive = val;
        }

        async toggle() {
            if (this.isRunning) this.stop();
            else await this.start();
        }

        stop() {
            this.isRunning = false;
            this._notifyUI();
        }

        async start() {
            this.isRunning = true;
            this.processedCount = 0;
            this._notifyUI();
            await this._loop();
        }

        async _loop() {
            while (this.isRunning) {
                const dialog = document.querySelector('div[role="dialog"]');
                if (!dialog) break; 
                
                const result = await this._processCurrentSlide(dialog);
                if (!result) break; 
                
                await new Promise(r => setTimeout(r, 500));
            }
            this.stop();
        }

        async _processCurrentSlide(dialog) {
            const slide = SlideScanner.getActiveSlide(dialog);
            if (!slide) return false;

            const nextBtn = SlideScanner.getNextButton(dialog);
            
            if (!nextBtn) {
                const continueBtn = SlideScanner.getContinueButton(slide);
                if (continueBtn) {
                     await this._clickWithDelay(continueBtn, 2500);
                     return true; 
                }
                return false; 
            }

            const gameInfo = SlideScanner.getGameInfo(slide, this.nameExtractor);

            if (this.config.skipPositive && gameInfo.isPositive) {
                await this._clickWithDelay(nextBtn, 800);
                return true;
            }

            const ignoreBtn = SlideScanner.getIgnoreButton(slide);
            if (ignoreBtn) {
                if (!this._isButtonActive(ignoreBtn)) {
                    await this._clickWithDelay(ignoreBtn, 150);
                    const success = await this._waitForActiveState(ignoreBtn);
                    
                    if (success) {
                        this.processedCount++;
                        this._notifyUI();
                        this.stats.save(gameInfo.name, "Queue");
                    }
                }
            } else {
                const continueBtn = SlideScanner.getContinueButton(slide);
                if (continueBtn) {
                     await this._clickWithDelay(continueBtn, 2500);
                     return true;
                }
                return false;
            }

            await this._clickWithDelay(nextBtn, 800);
            return true;
        }

        _notifyUI() {
            if (this.onUpdateCallback) {
                this.onUpdateCallback(this.isRunning, this.processedCount);
            }
        }

        _clickWithDelay(element, delay = 1000) {
            return new Promise(resolve => {
                if (element) element.click();
                setTimeout(resolve, delay);
            });
        }

        _isButtonActive(element) {
            if (!element) return false;
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

    window.ILAP.Discovery.Automator = DiscoveryQueueAutomator;

})();