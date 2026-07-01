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
        WRAPPER: `.game_capsule, .dailydeal_cap, .small_cap, .bundle_base_discount, [class*="ImpressionTrackedElement"], div[class*="StoreSaleWidget"], [class*="LibraryAssetExpandedDisplay"], .store_main_capsule, [class*="SaleSectionCtn"], .contenthubmaincarousel`
    };

    const CONFIG_KEYS = {
        SHORTCUT: 'ilap_shortcut_key',
        PLATFORM: 'ilap_platform_key',
        MASTER: 'ilap_master_enabled',
        MASK: 'ilap_mask_enabled'
    };
    const CONFIG_STORAGE_KEYS = Object.values(CONFIG_KEYS);

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
                    let innerImage = wrapper.querySelector(`[class*="CapsuleImageCtn"], [class*="HeroCapsuleImageContainer"], .capsule_image, .main_capsule, img[class*="Capsule"]`);

                    if (!innerImage) {
                        const link = el.tagName === 'A' ? el : wrapper.querySelector('a');
                        if (link) {
                            const rawImg = link.querySelector('img');
                            if (rawImg && rawImg.clientWidth > 20) innerImage = rawImg;
                        }
                    }

                    if (innerImage) {
                        const isHero = wrapper.classList.contains('store_main_capsule') || wrapper.classList.contains('contenthubmaincarousel');
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
                resolve: (el) => ({ element: el, type: 'grid' })
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

    class SwipeGestureDetector {
        constructor(configService, thresholdPx = 40) {
            this.configService = configService;
            this.threshold = thresholdPx;
            
            this.startX = 0;
            this.startY = 0;
            this.startEl = null;
            this.isSwiping = false;
            this.blockNextMenu = false;
            
            this.onGestureCallback = null;
        }

        attach(rootElement, callback) {
            this.onGestureCallback = callback;
            rootElement.addEventListener('mousedown', (e) => this.onMouseDown(e), true);
            rootElement.addEventListener('mouseup', (e) => this.onMouseUp(e), true);
            rootElement.addEventListener('contextmenu', (e) => this.onContextMenu(e), true);
        }

        onMouseDown(e) {
            if (e.button !== 2) return; 
            
            this.startX = e.clientX;
            this.startY = e.clientY;
            this.startEl = e.target;
            this.isSwiping = true;
        }

        onMouseUp(e) {
            if (!this.isSwiping || e.button !== 2) return;
            this.isSwiping = false;

            const dx = e.clientX - this.startX;
            const dy = e.clientY - this.startY;
            const distance = Math.sqrt(dx * dx + dy * dy);

            // INTENTIONAL: direction is decided by dx alone (no |dx|>|dy| dominance
            // check). This is an ergonomics choice — a loose/diagonal flick should
            // still register as a left/right swipe so the gesture is easy to perform.
            // Do NOT "fix" this to require horizontal dominance.
            if (distance >= this.threshold) {
                const directionName = dx > 0 ? 'Right' : 'Left';
                const swipeKey = `swipe${directionName}`;

                const config = this.configService.get();
                if (!config.enabled) return;

                let reason = -1;
                if (config.defaultKey === swipeKey) reason = 0;
                else if (config.platformKey === swipeKey) reason = 2;

                if (reason !== -1) {
                    this.blockNextMenu = true;
                    if (this.onGestureCallback) {
                        this.onGestureCallback({ startEl: this.startEl, reason: reason });
                    }
                }
            }
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

            if (reason === -1) return null;
            return this.createIntent(event.target, reason);
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
    window.ILAP.ManualIgnore.EventParser = EventParser;
 
})();