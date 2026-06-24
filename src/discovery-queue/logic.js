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

    const TIMING = {
        LOOP_PAUSE_MS: 500,             // pause between slides in the processing loop
        CONTINUE_CLICK_MS: 2500,        // wait after clicking a "Continue" interstitial
        NEXT_CLICK_MS: 800,             // wait after advancing to the next slide
        IGNORE_CLICK_MS: 150,           // wait after clicking the Ignore button
        ACTIVE_STATE_TIMEOUT_MS: 2500,  // max wait for the Ignore button to flip to active
        CONFIRM_PRIMARY_MS: 1000,       // primary: wait for the button to reflect "ignored" before any request
        CONFIRM_FALLBACK_MS: 4000,      // fallback: max wait for dynamicstore userdata to reflect the ignore
        CONFIRM_POLL_MS: 600            // gap between userdata polls in the fallback
    };

    // Authoritative ignore-state source: Steam's own dynamic store. Same-origin
    // GET (read-only — NOT an ignore API call), returns rgIgnoredApps as the map
    // of every ignored appid. Used only as a fallback when the in-page button
    // can't confirm (currently Steam's web ignore button renders no pressed/mask
    // state, so primary confirmation silently fails).
    const USERDATA_URL = 'https://store.steampowered.com/dynamicstore/userdata/';

    class SlideScanner {
        static getActiveSlide(dialog) {
            // The specific carousel container (Prev/Current/Next cards) MUST be
            // tried first — its children[2] is the active card holding the Ignore
            // button. The generic Focusable-Panel parent matches a broader node
            // whose children[2] is NOT the active card (Ignore lives elsewhere),
            // so as a primary it silently breaks the loop. Keep it as fallback only.
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
            // PRIMARY — the prohibition-icon SVG path is language-independent.
            const paths = slide.querySelectorAll('path');
            for (const p of paths) {
                if (p.getAttribute('d')?.startsWith(SVG_PATHS.IGNORE_ICON))
                    return p.closest('div[class*="Focusable"]');
            }
            // FALLBACK — localized aria-label (case-insensitive); only reached if
            // Steam changes the icon path, and English-only by nature.
            return slide.querySelector('div[aria-label="Ignore" i]');
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

        static getAppId(slide) {
            const link = slide.querySelector('a[href*="/app/"]');
            const href = link && link.getAttribute('href');
            const m = href && href.match(/\/app\/(\d+)/);
            return m ? m[1] : null;
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

                await new Promise(r => setTimeout(r, TIMING.LOOP_PAUSE_MS));
            }
            this.stop();
        }

        async _processCurrentSlide(dialog) {
            const slide = SlideScanner.getActiveSlide(dialog);
            if (!slide) return false;

            const nextBtn = SlideScanner.getNextButton(dialog);

            // End of the served queue → click "Continue" to spin up a fresh one
            // (keeps the feed effectively infinite).
            if (!nextBtn) {
                const continueBtn = SlideScanner.getContinueButton(slide);
                if (continueBtn) {
                     await this._clickWithDelay(continueBtn, TIMING.CONTINUE_CLICK_MS);
                     return true;
                }
                return false;
            }

            const gameInfo = SlideScanner.getGameInfo(slide, this.nameExtractor);

            // Keep High Score advances past POSITIVE games without ignoring.
            // Mixed/negative are NOT skipped — they fall through to the ignore path.
            if (this.config.skipPositive && gameInfo.isPositive) {
                await this._clickWithDelay(nextBtn, TIMING.NEXT_CLICK_MS);
                return true;
            }

            const ignoreBtn = SlideScanner.getIgnoreButton(slide);
            if (!ignoreBtn) {
                // No ignore control on this slide (e.g. an interstitial). Try
                // Continue, otherwise stop — never advance past a game we didn't act on.
                const continueBtn = SlideScanner.getContinueButton(slide);
                if (continueBtn) {
                     await this._clickWithDelay(continueBtn, TIMING.CONTINUE_CLICK_MS);
                     return true;
                }
                return false;
            }

            // Already ignored (cheap button check, no request) → just advance.
            if (this._isButtonActive(ignoreBtn)) {
                await this._clickWithDelay(nextBtn, TIMING.NEXT_CLICK_MS);
                return true;
            }

            const appid = SlideScanner.getAppId(slide);

            // Ignore by a LIVE click on the prohibition icon (no ignore API).
            await this._clickWithDelay(ignoreBtn, TIMING.IGNORE_CLICK_MS);

            // Confirm before advancing. HARD RULE: no confirmed ignore → no advance.
            const confirmed = await this._confirmIgnored(ignoreBtn, appid);
            if (!confirmed) return false;

            this.processedCount++;
            this._notifyUI();
            this.stats.save(gameInfo.name, "Queue");

            await this._clickWithDelay(nextBtn, TIMING.NEXT_CLICK_MS);
            return true;
        }

        // Two-tier confirmation, in order of cheapness:
        //   1) PRIMARY — the in-page button reflects the ignored state. Free, no
        //      request. (Currently a no-op: Steam's web button renders no pressed
        //      state, so this times out and we fall through.)
        //   2) FALLBACK — authoritative read of dynamicstore userdata. One GET per
        //      unconfirmed ignore, keeping requests at "one click → at most one GET".
        async _confirmIgnored(ignoreBtn, appid) {
            if (await this._waitForActiveState(ignoreBtn, TIMING.CONFIRM_PRIMARY_MS)) return true;
            if (!appid) return false;
            return this._verifyIgnoredViaUserdata(appid);
        }

        async _verifyIgnoredViaUserdata(appid) {
            const key = String(appid);
            const deadline = Date.now() + TIMING.CONFIRM_FALLBACK_MS;
            while (Date.now() < deadline) {
                try {
                    const res = await fetch(`${USERDATA_URL}?_=${Date.now()}`, {
                        credentials: 'include',
                        cache: 'no-store'
                    });
                    if (res.ok) {
                        const data = await res.json();
                        const ignored = data && data.rgIgnoredApps;
                        if (ignored && Object.prototype.hasOwnProperty.call(ignored, key)) return true;
                    }
                } catch (e) {
                    // Transient network/parse issue — retry until the deadline.
                }
                await new Promise(r => setTimeout(r, TIMING.CONFIRM_POLL_MS));
            }
            return false;
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
            const ariaPressed = element.getAttribute('aria-pressed');
            if (ariaPressed !== null) return ariaPressed === 'true';
            const hashedClasses = Array.from(element.classList).filter(c => c.startsWith('_'));
            return hashedClasses.length >= 2;
        }

        _waitForActiveState(element, timeout = TIMING.ACTIVE_STATE_TIMEOUT_MS) {
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