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

    class ConfigService {
        constructor(defaultConfig) {
            this.config = { ...defaultConfig };
            this.listeners = [];
        }

        async init() {
            return new Promise(resolve => {
                chrome.storage.local.get(['ilap_shortcut_key', 'ilap_platform_key', 'ilap_master_enabled'], (res) => {
                    this._updateInternal(res);
                    resolve();
                });
            });
        }

        listen() {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === 'local') {
                    chrome.storage.local.get(['ilap_shortcut_key', 'ilap_platform_key', 'ilap_master_enabled'], (res) => {
                        this._updateInternal(res);
                        this.listeners.forEach(cb => cb(this.config));
                    });
                }
            });
        }

        onChange(callback) {
            this.listeners.push(callback);
        }

        get() {
            return this.config;
        }

        _updateInternal(res) {
            if (res.ilap_shortcut_key !== undefined) this.config.defaultKey = res.ilap_shortcut_key;
            if (res.ilap_platform_key !== undefined) this.config.platformKey = res.ilap_platform_key;
            if (res.ilap_master_enabled !== undefined) this.config.enabled = res.ilap_master_enabled;
        }
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
            for (const strat of this.strategies) {
                if (strat.match(linkElement)) {
                    return strat.resolve(linkElement);
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
                if (existing && existing.parentElement !== startElement) return true;

                if (ContextScanner._isMultiGameSection(current)) break;

                if (
                    current.id?.includes('tab_content') ||
                    current.classList.contains('tab_content')
                ) break;

                current = current.parentElement;
            }
            return false;
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

            if (distance >= this.threshold) {
                const directionName = dx > 0 ? 'Right' : 'Left';
                const swipeKey = `swipeRight${directionName}`; 
                
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