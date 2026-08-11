// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.ManualIgnore = window.ILAP.ManualIgnore || {};

    const BADGE_CLASSES = {
        LIST: 'ilap-list-badge',
        GRID: 'ilap-grid-badge',
        HERO: 'ilap-hero-badge'
    };

    const SELECTORS = {
        LINK: 'a[href*="/app/"]',
        LIST_ITEM: '.tab_item',
        DIRECT_IMG: `[class*="CapsuleImageCtn"], [class*="HeroCapsuleImageContainer"], .spotlight_img, .capsule_image, .main_capsule`,
        WRAPPER: `.game_capsule, .dailydeal_cap, .small_cap, .bundle_base_discount, [class*="ImpressionTrackedElement"], div[class*="StoreSaleWidget"], [class*="LibraryAssetExpandedDisplay"], .store_main_capsule, [class*="SaleSectionCtn"], .contenthubmaincarousel, .hero_capsule`
    };

    const CONFIG_KEYS = {
        SHORTCUT: 'ilap_shortcut_key',
        PLATFORM: 'ilap_platform_key',
        MASTER: 'ilap_master_enabled',
        MASK: 'ilap_mask_enabled',
        UNIGNORE: 'ilap_unignore_key'
    };
    const CONFIG_STORAGE_KEYS = Object.values(CONFIG_KEYS);

    // The un-ignore binding's vocabulary — the same one the two IGNORE selects
    // offer, since the popup cross-guards all three and one binding can never be
    // handed to two actions (see the precedence note in SwipeGestureDetector).
    // Clamped rather than trusted: a value from an older build (or a hand-edited
    // storage key) that matches nothing would otherwise silently disable the
    // gesture with no way to tell from the page.
    // No legacy shim here, unlike window.ILAP.normalizeShortcut's for the ignore
    // keys: this binding ships with its first release, so no build has ever
    // written another vocabulary into the key.
    const UNIGNORE_KEYS = ['zigzag', 'swipeRight', 'swipeLeft',
                           'ctrlKey', 'shiftKey', 'altKey', 'off'];

    class ConfigReader {
        constructor(defaultConfig) {
            this.config = { ...defaultConfig };
        }

        async init() {
            return this.refresh();
        }

        async refresh() {
            return new Promise(resolve => {
                chrome.storage.local.get(CONFIG_STORAGE_KEYS, (res) => {
                    this._updateInternal(res);
                    resolve(this.config);
                });
            });
        }

        get() {
            return this.config;
        }

        _updateInternal(res) {
            const normalize = window.ILAP.normalizeShortcut;
            if (res[CONFIG_KEYS.SHORTCUT] !== undefined) this.config.defaultKey = normalize(res[CONFIG_KEYS.SHORTCUT]);
            if (res[CONFIG_KEYS.PLATFORM] !== undefined) this.config.platformKey = normalize(res[CONFIG_KEYS.PLATFORM]);
            if (res[CONFIG_KEYS.MASTER] !== undefined) this.config.enabled = res[CONFIG_KEYS.MASTER];
            if (res[CONFIG_KEYS.MASK] !== undefined) this.config.maskEnabled = res[CONFIG_KEYS.MASK];
            // Clamped against UNIGNORE_KEYS: an unrecognised stored value (a
            // hand-edited key) keeps the current setting rather than becoming an
            // inert binding no page could explain.
            if (UNIGNORE_KEYS.includes(res[CONFIG_KEYS.UNIGNORE])) {
                this.config.unignoreKey = res[CONFIG_KEYS.UNIGNORE];
            }
        }
    }

    class ConfigChangeEmitter {
        constructor(refreshFn) {
            this.listeners = [];
            this.refreshFn = refreshFn;
        }

        listen() {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local') return;
                // Only react to the config keys we read. Without this filter every
                // open Steam tab re-read config and swept the whole DOM
                // (refreshAll + syncMasks) on ANY local write — e.g. the curator
                // drainer's cursor, written 1–3×/s for the length of a bulk drain.
                if (!Object.keys(changes).some(k => CONFIG_STORAGE_KEYS.includes(k))) return;
                this.refreshFn().then(config => {
                    this.listeners.forEach(cb => cb(config));
                });
            });
        }

        onChange(callback) {
            this.listeners.push(callback);
        }
    }

    class ConfigService {
        constructor(defaultConfig) {
            this.reader = new ConfigReader(defaultConfig);
            this.emitter = new ConfigChangeEmitter(() => this.reader.refresh());
        }

        init() { return this.reader.init(); }
        get() { return this.reader.get(); }
        listen() { this.emitter.listen(); }
        onChange(callback) { this.emitter.onChange(callback); }
    }

    class ContainerStrategyProvider {
        constructor() {
            this.strategies = [
                this._strategyList(),
                this._strategyDirectImage(),
                this._strategyWrapper(),
                this._strategyFallback()
            ];
        }

        findContainer(linkElement) {
            // Steam's hover-preview popover holds its own media link next to the
            // grid capsules. A strategy's closest()/querySelector() can otherwise
            // climb out of the popover and resolve to a NEIGHBOURING capsule's
            // (already-processed) image — so the preview never gets its own badge.
            // Keep resolution inside the popover when the link lives in one.
            const popover = ContextScanner._hoverPopoverOf(linkElement);
            for (const strat of this.strategies) {
                if (strat.match(linkElement)) {
                    const result = strat.resolve(linkElement);
                    if (popover && result && result.element && !popover.contains(result.element)) {
                        continue;
                    }
                    return result;
                }
            }
            return null;
        }

        _strategyList() {
            return {
                name: 'List Item',
                match: (el) => el.closest(SELECTORS.LIST_ITEM),
                resolve: (el) => ({ element: el.closest(SELECTORS.LIST_ITEM), type: 'list' })
            };
        }

        _strategyDirectImage() {
            return {
                name: 'Direct Image',
                match: (el) => el.closest(SELECTORS.DIRECT_IMG),
                resolve: (el) => {
                    const element = el.closest(SELECTORS.DIRECT_IMG);
                    const isHero = element.classList.contains('spotlight_img');
                    return { element, type: isHero ? 'hero' : 'grid' };
                }
            };
        }

        _strategyWrapper() {
            return {
                name: 'Generic Wrapper',
                match: (el) => el.closest(SELECTORS.WRAPPER),
                resolve: (el) => {
                    const wrapper = el.closest(SELECTORS.WRAPPER);
                    // .hero_capsule_img: the seasonal-sale hero capsule keeps its art as a
                    // SIBLING of an empty overlay anchor, so the ancestor-based strategies
                    // and the inside-the-link fallbacks all miss it.
                    let innerImage = wrapper.querySelector(`[class*="CapsuleImageCtn"], [class*="HeroCapsuleImageContainer"], .capsule_image, .main_capsule, .hero_capsule_img, img[class*="Capsule"]`);

                    if (!innerImage) {
                        const link = el.tagName === 'A' ? el : wrapper.querySelector('a');
                        if (link) {
                            const rawImg = link.querySelector('img');
                            if (rawImg && rawImg.clientWidth > 20) innerImage = rawImg;
                        }
                    }

                    if (innerImage) {
                        const isHero = wrapper.classList.contains('store_main_capsule') || wrapper.classList.contains('contenthubmaincarousel') || wrapper.classList.contains('hero_capsule');
                        return { element: innerImage, type: isHero ? 'hero' : 'grid' };
                    }
                    return { element: wrapper, type: 'standard' };
                }
            };
        }

        _strategyFallback() {
            return {
                name: 'Fallback',
                match: (el) => el.querySelector('img, video'),
                resolve: (el) => {
                    // A capsule LINK can be a tall multi-row card — cover art on
                    // top, then tag/price rows (e.g. a.sale_capsule wrapping
                    // .capsule_image_ctn + .capsule_row_ctn + .discount_block).
                    // The badge is anchored bottom:0 of its target, so pinning it
                    // to the whole link drops it on the price row; prefer the
                    // cover-art container when the link wraps one.
                    const art = el.querySelector('.capsule_image_ctn, [class*="CapsuleImageCtn"]');
                    return { element: art || el, type: 'grid' };
                }
            };
        }
    }

    class ContextScanner {
        static hasBadgeInAncestors(startElement, appid, maxDepth = 7) {
            let current = startElement;
            for (let i = 0; i < maxDepth; i++) {
                if (!current || current === document.body) break;

                if (current.dataset.ilapIgnoreId === appid) return true;

                const existing = current.querySelector(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`);
                if (existing && existing.parentElement !== startElement) {
                    // A badge inside a hover-preview popover is a transient surface:
                    // it must only dedup elements within the SAME popover, never the
                    // persistent list/grid capsule outside it — otherwise the capsule
                    // is deduped against the preview and loses its badge the moment
                    // the cursor leaves and Steam destroys the popover.
                    const existingPopover = ContextScanner._hoverPopoverOf(existing);
                    if (!existingPopover || existingPopover === ContextScanner._hoverPopoverOf(startElement)) {
                        return true;
                    }
                }

                if (ContextScanner._isMultiGameSection(current)) break;

                // Steam's hover-preview popover is a separate visual surface that
                // shares an ancestor with the grid capsule (same single appid, so
                // _isMultiGameSection never breaks). Stop at its boundary so the
                // popover earns its own badge instead of being deduped against the
                // capsule's. Per-level badge checks above still dedup links INSIDE
                // the popover (the media badge sits below this root).
                if (ContextScanner._isHoverPopover(current)) break;

                if (
                    current.id?.includes('tab_content') ||
                    current.classList.contains('tab_content')
                ) break;

                current = current.parentElement;
            }
            return false;
        }

        static _isHoverPopover(element) {
            const style = element.getAttribute && element.getAttribute('style');
            if (!style) return false;
            return style.includes('z-index') && style.includes('left') && style.includes('top');
        }

        // Nearest hover-popover ancestor of an element, or null if it is not inside one.
        static _hoverPopoverOf(element) {
            let current = element;
            for (let i = 0; i < 12 && current && current !== document.body; i++) {
                if (ContextScanner._isHoverPopover(current)) return current;
                current = current.parentElement;
            }
            return null;
        }

        static _isMultiGameSection(element) {
            const links = element.querySelectorAll('a[href*="/app/"]');
            if (links.length < 2) return false;

            const ids = new Set();
            for (const link of links) {
                const match = link.getAttribute('href').match(/\/app\/(\d+)/);
                if (match) {
                    ids.add(match[1]);
                }
                if (ids.size >= 2) return true;
            }
            return false;
        }
    }

    // A back-and-forth gesture, measured on X ONLY — the same axis rule the swipe
    // uses, and for the same ergonomic reason (see decisions.md: direction from
    // `dx` alone is deliberate and must not be "fixed"). Consequence, accepted on
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
        }

        attach(rootElement, callback) {
            this.onGestureCallback = callback;
            rootElement.addEventListener('mousedown', (e) => this.onMouseDown(e), true);
            rootElement.addEventListener('mousemove', (e) => this.onMouseMove(e), true);
            rootElement.addEventListener('mouseup', (e) => this.onMouseUp(e), true);
            rootElement.addEventListener('contextmenu', (e) => this.onContextMenu(e), true);
        }

        onMouseDown(e) {
            if (!e.isTrusted) return; // real pointer input only, not synthesized events
            if (e.button !== 2) return;

            // The menu-suppression latch belongs to the gesture that set it and
            // to nothing else. Firefox dispatches contextmenu at mouse-DOWN,
            // BEFORE onMouseUp arms the latch, so a recognised gesture there
            // leaves it armed forever — and the next, unrelated right-click gets
            // its menu swallowed by a gesture that ended long ago (by a disabled
            // extension, even: onContextMenu answers to the latch alone).
            // Chromium fires contextmenu after mouse-up, so the latch is spent
            // by its own menu and this clears an already-false flag.
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
            // Which action it performs is now the user's choice like any other
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
            }
        }
    }

    class EventParser {
        constructor(configService) {
            this.configService = configService;
        }

        parseClick(event) {
            const config = this.configService.get();
            if (!config.enabled) return null;

            let reason = -1;
            if (event[config.defaultKey]) reason = 0;
            else if (config.platformKey !== 'off' && event[config.platformKey]) reason = 2;

            // …and the un-ignore binding, which may now be a modifier-click as
            // well. Tested last for the same reason the swipe path does it (see
            // onMouseUp): with the three cross-guarded in the popup they cannot
            // clash, and if a stale storage state ever does, ignore wins.
            // A gesture value ('zigzag'/'swipe*') is simply not a property of
            // the event, so it reads false here without a guard.
            const unignore = reason === -1
                && config.unignoreKey !== 'off' && !!event[config.unignoreKey];

            if (reason === -1 && !unignore) return null;
            const intent = this.createIntent(event.target, reason);
            if (intent && unignore) intent.action = 'unignore';
            return intent;
        }

        createIntent(startElement, reason) {
            const linkTarget = startElement.closest(SELECTORS.LINK);
            if (!linkTarget) return null;

            const match = linkTarget.getAttribute('href').match(/\/app\/(\d+)/);
            if (!match) return null;

            return { appid: match[1], reason: reason, linkElement: linkTarget };
        }
    }

    // Exports
    window.ILAP.ManualIgnore.BADGE_CLASSES = BADGE_CLASSES;
    window.ILAP.ManualIgnore.ConfigService = ConfigService;
    window.ILAP.ManualIgnore.ContainerStrategyProvider = ContainerStrategyProvider;
    window.ILAP.ManualIgnore.ContextScanner = ContextScanner;
    window.ILAP.ManualIgnore.SwipeGestureDetector = SwipeGestureDetector;
    window.ILAP.ManualIgnore.ZigzagTracker = ZigzagTracker;
    window.ILAP.ManualIgnore.UNIGNORE_KEYS = UNIGNORE_KEYS;
    window.ILAP.ManualIgnore.EventParser = EventParser;
 
})();