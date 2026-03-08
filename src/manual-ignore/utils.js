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
            this.config = defaultConfig;
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
            this.config.defaultKey = res.ilap_shortcut_key || 'ctrlKey';
            this.config.platformKey = res.ilap_platform_key || 'off';
            this.config.enabled = res.ilap_master_enabled !== false;
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
                if (current.id?.includes('tab_content') || current.classList.contains('tab_content')) break;
                if (current.dataset.ilapIgnoreId === appid) return true;
                
                const existing = current.querySelector(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`);
                if (existing && existing.parentElement !== startElement) return true;
                
                current = current.parentElement;
            }
            return false;
        }
    }

    class EventParser {
        constructor(configService) {
            this.configService = configService;
        }

        parse(event) {
            const config = this.configService.get();
            if (!config.enabled) return null;

            let reason = -1;
            if (event[config.defaultKey]) reason = 0;
            else if (config.platformKey !== 'off' && event[config.platformKey]) reason = 2;

            if (reason === -1) return null;

            const linkTarget = event.target.closest(SELECTORS.LINK);
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
    window.ILAP.ManualIgnore.EventParser = EventParser;

})();