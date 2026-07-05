// SPDX-License-Identifier: GPL-3.0-or-later
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

    // Safety valve: if we click "Continue" this many times in a row without a
    // single confirmed ignore in between, the interstitial handling has gone wrong
    // (e.g. a mis-targeted button) — stop instead of busy-looping. The streak is
    // pre-incremented before the click, so exactly MAX clicks are performed and
    // the (MAX+1)-th is refused; each confirmed ignore resets the streak.
    const MAX_CONTINUE_STREAK = 3;

    class SlideScanner {
        // A node qualifies as a queue slide only if it actually carries a game
        // link or the Ignore icon — used to validate whatever a selector returns,
        // so a class change can never hand back a non-slide (e.g. the Prev button).
        static _isSlide(el) {
            if (!el) return false;
            if (el.querySelector('a[href*="/app/"]')) return true;
            return Array.from(el.querySelectorAll('path'))
                .some(p => p.getAttribute('d')?.startsWith(SVG_PATHS.IGNORE_ICON));
        }

        // Re-derive the carousel container from any descendant (hash-independent):
        // the nearest ancestor whose children are the sibling prev/current/next
        // cards (>2 children, at least two holding a game link).
        static _findCarousel(node) {
            for (let el = node.parentElement; el; el = el.parentElement) {
                const kids = Array.from(el.children);
                if (kids.length > 2 &&
                    kids.filter(k => k.querySelector('a[href*="/app/"]')).length >= 2) {
                    return el;
                }
            }
            return null;
        }

        static getActiveSlide(dialog) {
            // PRIMARY — the hashed carousel container; children[2] is the centered
            // (active) card holding the Ignore button. Validate before trusting it.
            const hashed = dialog.querySelector('._3q6eNRFBrPSFSGEn8uRFZ3');
            if (hashed && hashed.children.length > 2 && SlideScanner._isSlide(hashed.children[2])) {
                return hashed.children[2];
            }
            // FALLBACK — re-derive the carousel from the Ignore icon (no hashes),
            // then take its centered card. Survives a container class rename.
            const ignore = Array.from(dialog.querySelectorAll('path'))
                .find(p => p.getAttribute('d')?.startsWith(SVG_PATHS.IGNORE_ICON));
            const carousel = ignore && SlideScanner._findCarousel(ignore);
            if (carousel) {
                const mid = carousel.children[Math.floor(carousel.children.length / 2)];
                if (SlideScanner._isSlide(mid)) return mid;
            }
            // FAIL-SAFE — no confidently-identified active card → stop, never guess.
            return null;
        }

        static getNextButton(dialog) {
            // PRIMARY — the right-chevron SVG path (language-independent).
            const paths = Array.from(dialog.querySelectorAll('path'))
                .filter(p => p.getAttribute('d')?.startsWith(SVG_PATHS.NEXT_ARROW));
            if (paths.length > 0) return paths[paths.length - 1].closest('div[class*="Focusable"]');

            // FALLBACK — the rightmost carousel nav button. The prev/next arrows are
            // both role=button icons; "next" is the one furthest right. Require ≥2
            // so we don't grab an unrelated lone icon button.
            const navBtns = Array.from(dialog.querySelectorAll('[role="button"]'))
                .filter(b => b.querySelector('svg') && b.offsetParent !== null);
            if (navBtns.length >= 2) {
                return navBtns.reduce((a, b) =>
                    b.getBoundingClientRect().left > a.getBoundingClientRect().left ? b : a);
            }
            return null;
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

        // The end-of-queue interstitial ("you've reached the end") lives at the
        // DIALOG level, not inside a slide — it offers OK (dismiss) and a primary
        // Continue (start a fresh queue). Pick Continue as the rightmost leaf text
        // button (no icon, no game link, no nested button): OK sits left, the
        // highlighted Continue sits right. Language-independent (no text match).
        static getContinueButton(dialog) {
            const buttons = Array.from(dialog.querySelectorAll('div[class*="Focusable"]'))
                .filter(el => {
                    const txt = el.textContent.trim();
                    if (!txt || txt.length > 40) return false;               // a short label
                    if (el.querySelector('svg')) return false;               // not an icon button
                    if (el.querySelector('a[href*="/app/"]')) return false;  // not a game card
                    if (el.querySelector('div[class*="Focusable"]')) return false; // a leaf, not a row wrapper
                    if (el.offsetParent === null) return false;              // visible
                    return true;
                });
            if (!buttons.length) return null;
            return buttons.reduce((a, b) =>
                b.getBoundingClientRect().left > a.getBoundingClientRect().left ? b : a);
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
        constructor(apiAdapter, statsAdapter, nameExtractorAdapter, gateAdapter) {
            if (!apiAdapter || typeof apiAdapter.ignore !== 'function') throw new TypeError("[ILAP] Invalid ApiAdapter passed to DiscoveryQueueAutomator");
            if (!statsAdapter || typeof statsAdapter.save !== 'function') throw new TypeError("[ILAP] Invalid StatsAdapter passed to DiscoveryQueueAutomator");
            if (!nameExtractorAdapter || typeof nameExtractorAdapter.get !== 'function') throw new TypeError("[ILAP] Invalid NameExtractorAdapter passed to DiscoveryQueueAutomator");
            // Gate is optional, but a supplied one must be a valid adapter.
            if (gateAdapter && typeof gateAdapter.reserve !== 'function') throw new TypeError("[ILAP] Invalid GateAdapter passed to DiscoveryQueueAutomator");

            this.api = apiAdapter;
            this.stats = statsAdapter;
            this.nameExtractor = nameExtractorAdapter;
            this.gate = gateAdapter;   // { reserve() } — aggregate rate governor (optional)
            
            this.isRunning = false;
            this.processedCount = 0;
            this._continueStreak = 0;
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
            // Idempotent: the DOM observer calls stop() on every removed-node batch
            // (Steam's React pages mutate constantly), and each _notifyUI() now also
            // triggers the controller's _releaseSlot() → a storage RMW. Skip the
            // no-op notify when we're already stopped so idle churn stays free.
            if (!this.isRunning) return;
            this.isRunning = false;
            this._notifyUI();
        }

        async start() {
            // Re-entrancy guard: _toggle() is now async (it awaits the registry
            // acquire), so a fast double-click could otherwise pass the isRunning
            // check twice and spin up two concurrent _loop()s in one tab.
            if (this.isRunning) return;
            this.isRunning = true;
            this.processedCount = 0;
            this._continueStreak = 0;
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
            const nextBtn = slide ? SlideScanner.getNextButton(dialog) : null;

            // End of the served queue (no active slide, or a slide with no Next
            // arrow) → click "Continue" to spin up a fresh one, keeping the feed
            // effectively infinite. The interstitial buttons live at the dialog
            // level, not inside a slide.
            if (!slide || !nextBtn) {
                return this._advanceViaContinue(dialog);
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
                return this._advanceViaContinue(dialog);
            }

            // Already ignored (cheap button check, no request) → just advance.
            if (this._isButtonActive(ignoreBtn)) {
                await this._clickWithDelay(nextBtn, TIMING.NEXT_CLICK_MS);
                return true;
            }

            const appid = SlideScanner.getAppId(slide);

            // Reserve an aggregate rate slot before the click. Clicking Steam's own
            // Ignore icon makes the PAGE fire an ignore POST (confirmed),
            // so DQ is a rate source too — it must pace against the drainer/EQ. A
            // stop verdict (master off / dead session) ends the loop cleanly.
            if (this.gate) {
                const slot = await this.gate.reserve();
                if (!slot.ok) return false;
            }

            // Ignore by a LIVE click on the prohibition icon (our code sends no POST;
            // Steam's page JS does, in response to the click).
            await this._clickWithDelay(ignoreBtn, TIMING.IGNORE_CLICK_MS);

            // Confirm before advancing. HARD RULE: no confirmed ignore → no advance.
            const confirmed = await this._confirmIgnored(ignoreBtn, appid);
            if (!confirmed) return false;

            this.processedCount++;
            this._continueStreak = 0;   // real progress → reset the Continue guard
            this._notifyUI();
            this.stats.save(gameInfo.name, "Queue");

            await this._clickWithDelay(nextBtn, TIMING.NEXT_CLICK_MS);
            return true;
        }

        // Click the end-of-queue "Continue" to start a fresh queue. Guards against
        // a runaway: if we keep hitting Continue without any ignore landing in
        // between, the button targeting is wrong — stop rather than busy-loop.
        async _advanceViaContinue(dialog) {
            const continueBtn = SlideScanner.getContinueButton(dialog);
            if (!continueBtn) return false;
            if (++this._continueStreak > MAX_CONTINUE_STREAK) return false;
            await this._clickWithDelay(continueBtn, TIMING.CONTINUE_CLICK_MS);
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
                // Shared reader (window.ILAP.fetchIgnoredApps) resolves to a Set of
                // ignored appids, or an empty Set on any transient failure — either
                // way we just keep polling until the deadline.
                const ignored = await window.ILAP.fetchIgnoredApps();
                if (ignored.has(key)) return true;
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
            // aria-pressed first (semantic), though Steam's web button never sets it.
            const ariaPressed = element.getAttribute('aria-pressed');
            if (ariaPressed !== null) return ariaPressed === 'true';
            // In-DOM ignored signal (verified by live probe): an un-ignored
            // button carries exactly ONE hashed (underscore) class; on ignore Steam
            // adds a SECOND hashed class within ~400ms. So "≥2 hashed classes" is a
            // real, fast, language-independent confirmation — this is what makes the
            // primary _waitForActiveState succeed before we ever touch userdata.
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