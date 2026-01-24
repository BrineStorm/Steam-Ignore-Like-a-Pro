(function() {
    'use strict';

    // === Constants ===
    const BADGE_CLASSES = {
        LIST: 'ilap-list-badge',
        GRID: 'ilap-grid-badge',
        HERO: 'ilap-hero-badge'
    };

    /**
     * SRP: Responsible solely for creating the visual DOM element.
     */
    class BadgeFactory {
        static create(appid, typeClass) {
            const overlay = document.createElement('div');
            overlay.className = `ilap-ignored-overlay ${typeClass}`;
            overlay.dataset.ilapAppid = appid;
            
            // Prevent clicks on badge from triggering the game link
            overlay.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });

            const iconUrl = chrome.runtime.getURL('icons/icon16.png');
            overlay.innerHTML = `
                IGNORED
                <div class="ilap-tooltip">
                    <div style="display: flex; align-items: center; gap: 6px; white-space: nowrap;">
                        <span>Ignore applied by</span>
                        <img src="${iconUrl}" style="width: 16px; height: 16px; vertical-align: middle;">
                        <span> extension</span>
                    </div>
                </div>
            `;
            return overlay;
        }
    }

    /**
     * OCP: Container Search Strategies.
     * To support a new Steam layout, simply add a new strategy here.
     */
    const ContainerStrategies = [
        {
            // Priority 1: List Items (Horizontal rows)
            name: 'List Item',
            match: (el) => el.closest('.tab_item'),
            resolve: (el) => ({ element: el.closest('.tab_item'), type: 'list' })
        },
        {
            // Priority 2: Direct Image Containers (Grid/Hero)
            name: 'Direct Image',
            match: (el) => el.closest(`
                [class*="CapsuleImageCtn"], 
                [class*="HeroCapsuleImageContainer"],
                .spotlight_img, 
                .capsule_image, 
                .main_capsule
            `),
            resolve: (el) => ({ 
                element: el.closest(`
                    [class*="CapsuleImageCtn"], 
                    [class*="HeroCapsuleImageContainer"],
                    .spotlight_img, 
                    .capsule_image, 
                    .main_capsule
                `), 
                type: 'grid' 
            })
        },
        {
            // Priority 3: Generic Wrappers + Smart Redirect
            name: 'Generic Wrapper',
            match: (el) => el.closest(`
                .game_capsule, .dailydeal_cap, .small_cap, .bundle_base_discount, 
                [class*="ImpressionTrackedElement"], div[class*="StoreSaleWidget"],
                [class*="LibraryAssetExpandedDisplay"], .store_main_capsule
            `),
            resolve: (el) => {
                const wrapper = el.closest(`
                    .game_capsule, .dailydeal_cap, .small_cap, .bundle_base_discount, 
                    [class*="ImpressionTrackedElement"], div[class*="StoreSaleWidget"],
                    [class*="LibraryAssetExpandedDisplay"], .store_main_capsule
                `);
                
                // Smart Redirect: Look INSIDE the wrapper for the image
                const innerImage = wrapper.querySelector(`
                    [class*="CapsuleImageCtn"], [class*="HeroCapsuleImageContainer"],
                    .capsule_image, .main_capsule, img[class*="Capsule"]
                `);

                if (innerImage) {
                    // Check if it's a Hero banner (Carousel)
                    const isHero = wrapper.classList.contains('store_main_capsule');
                    return { element: innerImage, type: isHero ? 'hero' : 'grid' };
                }
                
                return { element: wrapper, type: 'standard' };
            }
        },
        {
            // Priority 4: Fallback
            name: 'Fallback Image',
            match: (el) => el.querySelector('img, video'),
            resolve: (el) => ({ element: el, type: 'grid' })
        }
    ];

    /**
     * SRP: Logic for selecting the correct strategy
     */
    class ContainerFinder {
        static find(linkElement) {
            for (const strategy of ContainerStrategies) {
                if (strategy.match(linkElement)) {
                    return strategy.resolve(linkElement);
                }
            }
            return null;
        }
    }

    /**
     * SRP: Handles Badge Placement, Styles, and Duplicate Prevention
     */
    class BadgeManager {
        static apply(containerObj, appid) {
            const { element, type } = containerObj;

            // 1. Strict Check
            if (element.dataset.ilapState === 'processed') return;

            // 2. Proximity Check (Radius)
            if (this._isBadgeNearby(element, appid)) {
                element.dataset.ilapState = 'processed';
                return;
            }

            // 3. Determine Style
            const variantClass = this._getVariantClass(type, element);

            // 4. Create & Append
            const badge = BadgeFactory.create(appid, variantClass);
            this._ensurePositioning(element);
            
            element.appendChild(badge);
            element.dataset.ilapState = 'processed';
            element.dataset.ilapIgnoreId = appid;
        }

        static _getVariantClass(type, element) {
            if (type === 'list') return BADGE_CLASSES.LIST;
            if (type === 'hero' || element.classList.contains('spotlight_img')) return BADGE_CLASSES.HERO;
            return BADGE_CLASSES.GRID;
        }

        static _ensurePositioning(element) {
            if (getComputedStyle(element).position === 'static') {
                element.classList.add('ilap-tagged-container');
            }
        }

        static _isBadgeNearby(startElement, appid) {
            // Exception: Lists and Carousels are self-contained
            if (startElement.classList.contains('tab_item') || startElement.closest('.store_main_capsule')) {
                return startElement.dataset.ilapIgnoreId === appid || 
                       !!startElement.querySelector(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`);
            }

            // Standard Traversal
            let current = startElement;
            for (let i = 0; i < 7; i++) {
                if (!current || current === document.body) break;
                
                // Stop boundaries to avoid bleeding scope
                if (current.id?.includes('tab_content')) break;
                if (current.classList.contains('tab_content')) break;
                if (current.classList.contains('carousel_items')) break;

                // Check self
                if (current.dataset.ilapIgnoreId === appid) return true;

                // Check siblings/children
                const existing = current.querySelector(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`);
                if (existing && existing.parentElement !== startElement) {
                    return true;
                }
                current = current.parentElement;
            }
            return false;
        }
    }

    /**
     * SRP: Business Logic (State, Config, API calls)
     */
    class IgnoreService {
        constructor() {
            this.sessionIgnored = new Set();
            this.config = { default: 'ctrlKey', platform: 'off', enabled: true };
            this._loadSession();
        }

        _loadSession() {
            try {
                const stored = sessionStorage.getItem(window.ILAP.SESSION_IGNORED_KEY);
                if (stored) this.sessionIgnored = new Set(JSON.parse(stored));
            } catch (e) {
                sessionStorage.removeItem(window.ILAP.SESSION_IGNORED_KEY);
            }
        }

        updateConfig() {
            chrome.storage.local.get(['ilap_shortcut_key', 'ilap_platform_key', 'ilap_master_enabled'], (res) => {
                this.config.default = res.ilap_shortcut_key || 'ctrlKey';
                this.config.platform = res.ilap_platform_key || 'off';
                this.config.enabled = res.ilap_master_enabled !== false;
            });
        }

        async processIgnore(appid, reason, contextElement) {
            if (this.sessionIgnored.has(appid)) return;

            const success = await window.ILAP.apiIgnoreGame(appid, reason);
            if (success) {
                // Update State
                this.sessionIgnored.add(appid);
                try {
                    sessionStorage.setItem(window.ILAP.SESSION_IGNORED_KEY, JSON.stringify([...this.sessionIgnored]));
                } catch(e) { console.warn('ILAP Storage Full'); }
                
                // Update Visuals
                this.refreshBadges(appid);
                
                // Save Stats (Game Name extracted via Utils)
                const name = window.ILAP.getGameName(appid, contextElement);
                const source = reason === 0 ? "Default Ignore" : "Played Elsewhere";
                window.ILAP.saveStats(name, source);
            }
        }

        refreshBadges(appid) {
            const selector = `a[href*="/app/${appid}"]`;
            const candidates = document.querySelectorAll(selector);

            candidates.forEach(link => {
                const href = link.getAttribute('href');
                if (!new RegExp(`/app/${appid}(/|\\?|$)`).test(href)) return;

                const container = ContainerFinder.find(link);
                if (container) {
                    BadgeManager.apply(container, appid);
                }
            });
        }

        refreshAllBadges() {
            this.sessionIgnored.forEach(appid => this.refreshBadges(appid));
        }
    }

    /**
     * Controller: Coordinates the application flow
     */
    class App {
        constructor() {
            this.service = new IgnoreService();
        }

        init() {
            this.service.updateConfig();
            chrome.storage.onChanged.addListener(() => this.service.updateConfig());
            
            this.setupInteractions();
            this.setupObserver();
            
            // Initial scan
            this.service.refreshAllBadges();
        }

        setupInteractions() {
            document.body.addEventListener('click', (e) => this.handleClick(e), true);
        }

        handleClick(event) {
            if (!this.service.config.enabled) return;

            let reason = -1;
            if (event[this.service.config.default]) reason = 0;
            else if (this.service.config.platform !== 'off' && event[this.service.config.platform]) reason = 2;

            if (reason === -1) return;

            const linkTarget = event.target.closest('a[href*="/app/"]');
            if (!linkTarget) return;

            const href = linkTarget.getAttribute('href');
            const match = href.match(/\/app\/(\d+)/);
            if (!match) return;

            const appid = match[1];
            
            // Prevent default navigation
            event.preventDefault();
            event.stopPropagation();

            // Find context for finding the game name later
            const containerInfo = ContainerFinder.find(linkTarget);
            const contextEl = containerInfo ? containerInfo.element : linkTarget;

            this.service.processIgnore(appid, reason, contextEl);
        }

        setupObserver() {
            let timeout;
            const observer = new MutationObserver((mutations) => {
                const shouldRun = mutations.some(m => m.addedNodes.length > 0);
                if (shouldRun) {
                    clearTimeout(timeout);
                    timeout = setTimeout(() => this.service.refreshAllBadges(), 200);
                }
            });
            const root = document.getElementById('page_root') || document.body;
            observer.observe(root, { childList: true, subtree: true });
        }
    }

    // Launch
    new App().init();

})();