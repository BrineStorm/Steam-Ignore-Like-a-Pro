// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';
    
    window.ILAP = window.ILAP || {};
    window.ILAP.Discovery = window.ILAP.Discovery || {};

    const SVG_PATHS = {
        NEXT_ARROW: "M16.0855",
        IGNORE_ICON: "M600,96c"
    };

    // Steam's review palette lives in ONE table now (src/steam-palette.js,
    // loaded before this file in both manifests). It used to be copied here,
    // and the copy went stale: Steam repainted Mixed in the modal, the constant
    // stayed, and Keep High Score quietly stopped ignoring anything.
    const PALETTE = window.ILAP && window.ILAP.SteamPalette;

    const TIMING = {
        LOOP_PAUSE_MS: 500,             // pause between slides in the processing loop
        CONTINUE_CLICK_MS: 2500,        // wait after clicking a "Continue" interstitial
        NEXT_CLICK_MS: 800,             // wait after advancing to the next slide
        IGNORE_CLICK_MS: 150,           // wait after clicking the Ignore button
        ACTIVE_STATE_TIMEOUT_MS: 2500,  // max wait for the Ignore button to flip to active
        CONFIRM_PRIMARY_MS: 1000,       // primary: wait for the button to reflect "ignored" before any request
        CONFIRM_POLL_MS: 600,           // fallback: settle delay before the FIRST userdata read; doubles per miss
        CONFIRM_MAX_GETS: 3             // fallback: hard cap on userdata GETs per unconfirmed ignore
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
        //
        // NB this "≥2 children with a game link" test is deliberately NOT applied
        // to the hashed container in _getCenterSlot. At the end-of-queue
        // interstitial the centre slot holds no card, and whether BOTH remaining
        // neighbours still do is exactly the thing that could not be relied on —
        // failing the test there would fall through to this fallback, which is
        // the stale-card infinite loop _getCenterSlot was changed to fix.
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

        // The CENTERED carousel slot — the only one the automator ever acts on.
        // Probed live: on a normal slide it holds the active game card, and at the
        // end-of-queue interstitial it holds the stats panel with Done/Continue.
        // The neighbouring slots hold off-screen cards (already passed or not yet
        // reached) whose controls must never be clicked.
        static _getCenterSlot(dialog) {
            // PRIMARY — the hashed carousel container; children[2] is the centered
            // slot. Once that container has rendered its carousel it is
            // AUTHORITATIVE, including when the slot holds no game card. Falling
            // through to the fallback there used to re-derive a stale,
            // already-passed card from a leftover Ignore icon — the loop then read
            // that card's button as "already ignored", clicked Next (a no-op on
            // the interstitial) and spun forever, never reaching the Continue
            // branch.
            const hashed = dialog.querySelector('._3q6eNRFBrPSFSGEn8uRFZ3');
            if (hashed && hashed.children.length > 2) return hashed.children[2];

            // FALLBACK — only when that container is absent (class rename) or has
            // not rendered its carousel yet: re-derive it from the Ignore icon (no
            // hashes), then take its centered slot.
            const ignore = Array.from(dialog.querySelectorAll('path'))
                .find(p => p.getAttribute('d')?.startsWith(SVG_PATHS.IGNORE_ICON));
            const carousel = ignore && SlideScanner._findCarousel(ignore);
            return carousel
                ? carousel.children[Math.floor(carousel.children.length / 2)]
                : null;
        }

        static getActiveSlide(dialog) {
            // FAIL-SAFE — anything but a confidently-identified card in the
            // centered slot means "no active slide": stop, never guess.
            const slot = SlideScanner._getCenterSlot(dialog);
            return SlideScanner._isSlide(slot) ? slot : null;
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

        // The end-of-queue interstitial ("you've reached the end") replaces the
        // game card in the centered slot with a stats panel offering Done
        // (dismiss) and a primary Continue (start a fresh queue). Pick Continue as
        // the rightmost leaf text button (no icon, no game link, no nested
        // button): Done sits left, the highlighted Continue sits right.
        // Language-independent (no text match).
        //
        // The search is SCOPED to that slot, and only while it holds no game card
        // — i.e. exactly the state getActiveSlide reports as "no active slide".
        // That is the whole safety story: a dialog-wide search had nothing tying
        // the click target to the interstitial, so whenever the caller reached
        // this branch with a card on screen (Steam renaming the Ignore icon path
        // is enough) the rightmost leaf button was the card's own — live values
        // seen while probing: "Install Demo", "Undo", "Very Positive(9,840
        // English Reviews)". Clicking those is worse than stopping. Off-screen
        // neighbour cards carry the same controls and are out of reach for the
        // same reason.
        static getContinueButton(dialog) {
            const slot = SlideScanner._getCenterSlot(dialog);
            if (!slot || SlideScanner._isSlide(slot)) return null;

            const buttons = Array.from(slot.querySelectorAll('div[class*="Focusable"]'))
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
                    return !!PALETTE && PALETTE.isBad(color);
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
            // Any throw mid-iteration (a Steam DOM change breaking a selector)
            // must still land in stop(): without it isRunning stays true, the
            // button sticks on "Stop", and the controller's heartbeat keeps
            // renewing this tab's registry slot — one zombie tab would eat half
            // of the cross-tab cap (2) until the tab closes.
            try {
                while (this.isRunning) {
                    const dialog = document.querySelector('div[role="dialog"]');
                    if (!dialog) break;

                    const result = await this._processCurrentSlide(dialog);
                    if (!result) break;

                    await new Promise(r => setTimeout(r, TIMING.LOOP_PAUSE_MS));
                }
            } catch (e) {
                // start() is deliberately not awaited by the controller, so a
                // rethrow would only surface as an unhandled rejection.
                console.warn('[ILAP] DQ loop aborted:', e);
            } finally {
                this.stop();
            }
        }

        async _processCurrentSlide(dialog) {
            const slide = SlideScanner.getActiveSlide(dialog);
            const nextBtn = slide ? SlideScanner.getNextButton(dialog) : null;

            // End of the served queue (no active slide, or a slide with no Next
            // arrow) → click "Continue" to spin up a fresh one, keeping the feed
            // effectively infinite. Only a genuine interstitial yields a Continue
            // button; with a card still on screen this stops instead.
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
                // The reservation can wait out several paced slots; a Stop click
                // (or the master-off teardown) landing during that wait must not
                // be followed by one more ignore.
                if (!this.isRunning) return false;
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
            this.stats.save(gameInfo.name, "Queue", appid);

            // The confirm poll above can span seconds; a Stop click landing in
            // that window must not be followed by one more queue advance. (The
            // ignore itself already happened and is counted — only the advance
            // is refused.)
            if (!this.isRunning) return false;

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
        //   1) PRIMARY — the in-page button reflects the ignored state via the
        //      ≥2-hashed-classes signal (live-verified: Steam adds a
        //      second hashed class within ~400 ms of the click). Free, no
        //      request — this is what confirms the typical ignore.
        //   2) FALLBACK — insurance for a Steam markup change breaking the
        //      button signal: authoritative read of dynamicstore userdata,
        //      paced (settle delay + doubling backoff, hard-capped at
        //      CONFIRM_MAX_GETS reads) so an unconfirmed ignore costs typically
        //      one GET and never a fixed-rate poll hammer.
        async _confirmIgnored(ignoreBtn, appid) {
            if (await this._waitForActiveState(ignoreBtn, TIMING.CONFIRM_PRIMARY_MS)) return true;
            if (!appid) return false;
            return this._verifyIgnoredViaUserdata(appid);
        }

        async _verifyIgnoredViaUserdata(appid) {
            const key = String(appid);
            // The ignore POST fired at the click, and the primary wait already
            // burned ~1 s — so give Steam a settle delay BEFORE the first read
            // (reading immediately all but guarantees a miss + re-poll), then
            // double the gap per miss up to the GET cap.
            let delay = TIMING.CONFIRM_POLL_MS;
            for (let i = 0; i < TIMING.CONFIRM_MAX_GETS; i++) {
                await new Promise(r => setTimeout(r, delay));
                // Shared reader resolves to a Set of ignored appids, or an empty
                // Set on any transient failure — a failed read just spends one
                // attempt from the cap.
                const ignored = await window.ILAP.fetchIgnoredApps();
                if (ignored.has(key)) return true;
                delay *= 2;
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