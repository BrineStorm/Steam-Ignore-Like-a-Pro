// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.ManualIgnore = window.ILAP.ManualIgnore || {};

    // Pointer and modifier-click input turned into an intent: the right-button
    // gestures (swipe, circle/zigzag), the clicks, and the capsule they land on.

    // A game link: the same literal ContextScanner and IgnoreManager spell. A
    // bundle or package link, for a gesture on a capsule that stands for a set
    // of games (bundle.js).
    const SELECTORS = {
        LINK: 'a[href*="/app/"]',
        BUNDLE: 'a[href*="/bundle/"], a[href*="/sub/"]'
    };

    // A bundle or package capsule: the link with its art inside, or null. The
    // text links and the "Bundle info" / "Package info" buttons on a game's page
    // lead to the same pages and are no gesture target (one of those is the
    // game's own package).
    function bundleCapsule(el) {
        const link = el.closest(SELECTORS.BUNDLE);
        return link && link.querySelector('img, video') ? link : null;
    }

    const Settings = window.ILAP.Settings;

    // A back-and-forth gesture, measured on X ONLY — the same axis rule the swipe
    // uses, and for the same ergonomic reason (direction from `dx` alone is
    // deliberate and must not be "fixed"). Consequence, accepted on
    // purpose: a circle traced clockwise and one traced counter-clockwise produce
    // the SAME x trajectory, so they cannot be told apart here. The gesture is
    // therefore "a circle either way, or a right-left / left-right zigzag" — one
    // reversal with both legs long enough to be intentional.
    //
    // `legs` collects the horizontal travel between direction changes. A plain
    // swipe yields one leg; the reversal is what makes it a zigzag. HYST both
    // filters hand jitter and sets how decisive a reversal must be, so a swipe
    // that drifts back a few pixels at release is still a swipe.
    const ZIGZAG_HYST = 12;      // px of counter-travel before a reversal counts
    const ZIGZAG_LEG_MIN = 30;   // px each leg must cover for the gesture to fire

    class ZigzagTracker {
        reset(x) {
            this.legStartX = x;
            this.extremeX = x;
            this.dir = 0;        // 0 = no committed direction yet
            this.legs = [];
        }

        move(x) {
            if (this.dir === 0) {
                if (Math.abs(x - this.legStartX) >= ZIGZAG_HYST) {
                    this.dir = x > this.legStartX ? 1 : -1;
                    this.extremeX = x;
                }
                return;
            }
            // Still travelling the same way — push the turning point out.
            if ((x - this.extremeX) * this.dir > 0) {
                this.extremeX = x;
                return;
            }
            // Came back far enough to count as a turn: bank the finished leg and
            // start the next one AT the turning point, not at the current cursor.
            if ((this.extremeX - x) * this.dir >= ZIGZAG_HYST) {
                this.legs.push(Math.abs(this.extremeX - this.legStartX));
                this.dir = -this.dir;
                this.legStartX = this.extremeX;
                this.extremeX = x;
            }
        }

        // True when the trajectory turned at least once and both of the first two
        // legs were long enough to be deliberate.
        isZigzag() {
            const legs = this.legs.concat(
                this.dir === 0 ? [] : [Math.abs(this.extremeX - this.legStartX)]);
            return legs.length >= 2 && legs[0] >= ZIGZAG_LEG_MIN && legs[1] >= ZIGZAG_LEG_MIN;
        }
    }

    class SwipeGestureDetector {
        constructor(configService, thresholdPx = 40) {
            this.configService = configService;
            this.threshold = thresholdPx;

            this.startX = 0;
            this.startY = 0;
            this.startEl = null;
            this.isSwiping = false;
            this.blockNextMenu = false;
            this.zigzag = new ZigzagTracker();

            this.onGestureCallback = null;
            this.onMenuAtPress = null;
        }

        // `onMenuAtPress` (optional): told each time a menu that opened at press
        // was cancelled on a capsule — the system is one where the menu would
        // have taken the gesture over (see onContextMenu).
        attach(rootElement, callback, onMenuAtPress) {
            this.onGestureCallback = callback;
            this.onMenuAtPress = onMenuAtPress || null;
            rootElement.addEventListener('mousedown', (e) => this.onMouseDown(e), true);
            rootElement.addEventListener('mousemove', (e) => this.onMouseMove(e), true);
            rootElement.addEventListener('mouseup', (e) => this.onMouseUp(e), true);
            rootElement.addEventListener('contextmenu', (e) => this.onContextMenu(e), true);
        }

        onMouseDown(e) {
            if (!e.isTrusted) return; // real pointer input only, not synthesized events
            if (e.button !== 2) return;

            // The menu-suppression latch belongs to the gesture that set it and
            // to nothing else. Off Windows (macOS, Linux — any browser) and for
            // Playwright's synthetic input on Firefox, contextmenu arrives at
            // mouse-DOWN, BEFORE onMouseUp arms the latch, so a recognised
            // gesture there leaves it armed forever — and the next, unrelated
            // right-click gets its menu swallowed by a gesture that ended long
            // ago (by a disabled extension, even: the latch answers to nothing
            // else). On Windows contextmenu fires after mouse-up, so the latch is
            // spent by its own menu and this clears an already-false flag.
            this.blockNextMenu = false;

            this.startX = e.clientX;
            this.startY = e.clientY;
            this.startEl = e.target;
            this.isSwiping = true;
            this.zigzag.reset(e.clientX);
        }

        // Only sampled while the button is down, so an idle page pays nothing but
        // the early return (the listener is passive — it never touches the event).
        onMouseMove(e) {
            if (!this.isSwiping || !e.isTrusted) return;
            this.zigzag.move(e.clientX);
        }

        onMouseUp(e) {
            if (!e.isTrusted) return; // a synthetic mouseup must not complete a gesture
            if (!this.isSwiping || e.button !== 2) return;
            this.isSwiping = false;

            const config = this.configService.get();
            if (!config.enabled) return;

            // The circle/zigzag is classified FIRST and wins outright: it
            // necessarily also clears the swipe's distance threshold, so letting
            // both run would fire two of the three bindings from one gesture.
            // Which action it performs is the user's choice like any other
            // binding — ignore by circle and un-ignore by swipe is a legitimate
            // setup — so it resolves through the same table as the swipes.
            if (this.zigzag.isZigzag() && this._fire(config, 'zigzag')) return;

            const dx = e.clientX - this.startX;
            const dy = e.clientY - this.startY;
            const distance = Math.sqrt(dx * dx + dy * dy);

            // INTENTIONAL: direction is decided by dx alone (no |dx|>|dy| dominance
            // check). This is an ergonomics choice — a loose/diagonal flick should
            // still register as a left/right swipe so the gesture is easy to perform.
            // Do NOT "fix" this to require horizontal dominance.
            if (distance >= this.threshold) {
                this._fire(config, `swipe${dx > 0 ? 'Right' : 'Left'}`);
            }
        }

        /**
         * Hand a recognised gesture to whichever action is bound to it, and say
         * whether anything took it. The two IGNORE bindings are read first: the
         * popup cross-guards all three selects, so a value bound twice can only
         * come from an older build or a hand-edited storage key, and when it does
         * the collision must cost the rollback rather than the ignore the user
         * was performing.
         */
        _fire(config, key) {
            let payload = null;
            if (config.defaultKey === key) payload = { reason: 0 };
            else if (config.platformKey === key) payload = { reason: 2 };
            else if (config.unignoreKey === key) payload = { action: 'unignore' };
            if (!payload) return false;

            this.blockNextMenu = true;
            if (this.onGestureCallback) {
                this.onGestureCallback(Object.assign({ startEl: this.startEl }, payload));
            }
            return true;
        }

        onContextMenu(e) {
            if (this.blockNextMenu) {
                e.preventDefault();
                e.stopPropagation();
                this.blockNextMenu = false;
                return;
            }
            // A menu while the right button is still down: the system opens it
            // at press (macOS, Linux). Left alone it grabs the pointer, the page
            // never sees the moves or the release, and no gesture can finish. So
            // on a capsule, with a gesture bound, it goes; elsewhere, or with
            // every action on a click or off, it stays. Windows never gets here:
            // its menu comes after mouse-up, when the press is over.
            if (!this.isSwiping || !e.isTrusted) return;
            // A tab left open across an extension update keeps this script with
            // no extension behind it: its gesture could not be queued, so the
            // menu it would take away stays.
            if (!chrome.runtime?.id) return;
            const config = this.configService.get();
            if (!config.enabled) return;
            const bound = [config.defaultKey, config.platformKey, config.unignoreKey];
            if (!bound.some(k => Settings.GESTURES.includes(k))) return;
            if (!this.startEl.closest(SELECTORS.LINK) && !bundleCapsule(this.startEl)) return;
            e.preventDefault();
            e.stopPropagation();
            if (this.onMenuAtPress) this.onMenuAtPress();
        }
    }

    class EventParser {
        constructor(configService) {
            this.configService = configService;
        }

        parseClick(event) {
            const config = this.configService.get();
            if (!config.enabled) return null;

            // Is this binding a modifier the event carries? OFF is checked for
            // every one of the three bindings: `event['off']` being undefined is
            // a coincidence, not a rule, and a
            // binding switched off must read as off because it is off. A gesture
            // value ('zigzag'/'swipe*') is not a property of the event either,
            // which is what keeps this table shared with the swipe path.
            const pressed = (key) => key !== Settings.OFF && !!event[key];

            let reason = -1;
            if (pressed(config.defaultKey)) reason = 0;
            else if (pressed(config.platformKey)) reason = 2;

            // …and the un-ignore binding, which may now be a modifier-click as
            // well. Tested last for the same reason the swipe path does it (see
            // onMouseUp): with the three cross-guarded in the popup they cannot
            // clash, and if a stale storage state ever does, ignore wins.
            const unignore = reason === -1 && pressed(config.unignoreKey);

            if (reason === -1 && !unignore) return null;
            const intent = this.createIntent(event.target, reason);
            if (intent && unignore) intent.action = 'unignore';
            return intent;
        }

        createIntent(startElement, reason) {
            const linkTarget = startElement.closest(SELECTORS.LINK);
            if (!linkTarget) return this._bundleIntent(startElement, reason);

            const match = linkTarget.getAttribute('href').match(/\/app\/(\d+)/);
            if (!match) return null;

            return { appid: match[1], reason: reason, linkElement: linkTarget };
        }

        // A bundle or package capsule: no appid, its store id instead.
        _bundleIntent(startElement, reason) {
            const link = bundleCapsule(startElement);
            if (!link) return null;
            // The same pattern IgnoreManager._refreshBundles badges by.
            const match = (link.getAttribute('href') || '').match(/\/(bundle|sub)\/(\d+)([/?#]|$)/);
            if (!match) return null;
            return { bundle: { kind: match[1], id: match[2] }, reason: reason, linkElement: link };
        }
    }

    window.ILAP.ManualIgnore.SwipeGestureDetector = SwipeGestureDetector;
    window.ILAP.ManualIgnore.ZigzagTracker = ZigzagTracker;
    window.ILAP.ManualIgnore.EventParser = EventParser;

})();
