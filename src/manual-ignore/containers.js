// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.ManualIgnore = window.ILAP.ManualIgnore || {};

    // Where on Steam's markup a game's badge goes: the container strategies, and
    // the ancestor scan that keeps one game from being badged twice.
    const BADGE_CLASSES = {
        LIST: 'ilap-list-badge',
        GRID: 'ilap-grid-badge',
        HERO: 'ilap-hero-badge'
    };

    const SELECTORS = {
        LIST_ITEM: '.tab_item',
        DIRECT_IMG: `[class*="CapsuleImageCtn"], [class*="HeroCapsuleImageContainer"], .spotlight_img, .capsule_image, .main_capsule`,
        WRAPPER: `.game_capsule, .dailydeal_cap, .small_cap, .bundle_base_discount, [class*="ImpressionTrackedElement"], div[class*="StoreSaleWidget"], [class*="LibraryAssetExpandedDisplay"], .store_main_capsule, [class*="SaleSectionCtn"], .contenthubmaincarousel, .hero_capsule`
    };

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

    window.ILAP.ManualIgnore.BADGE_CLASSES = BADGE_CLASSES;
    window.ILAP.ManualIgnore.ContainerStrategyProvider = ContainerStrategyProvider;
    window.ILAP.ManualIgnore.ContextScanner = ContextScanner;

})();
