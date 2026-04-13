(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.Explore = window.ILAP.Explore || {};

    const COLORS = {
        BLUE: 'rgb(102, 192, 244)',
        GRAY: 'rgb(136, 136, 136)',
        RED_BG: '#d32f2f',
        BLUE_BG: '#66c0f4',
        OFF_BG: '#888888',
        YELLOW_BG: '#c1a50a' 
    };

    const KEYS = {
        ACTIVE: 'ilap_queue_active',
        FF: 'ilap_queue_ff',
        NAV_TOKEN: 'ilap_queue_nav_token'
    };

    // --- Domain Entities ---

    class QueueContext {
        static isQueuePage() {
            const params = new URLSearchParams(window.location.search);
            return params.has('queue') && window.location.pathname.includes('/app/');
        }

        static getAppID() {
            const match = window.location.pathname.match(/\/app\/(\d+)/);
            return match ? match[1] : null;
        }

        static getNextButton() {
            return document.querySelector('#nextInDiscoveryQueue .btn_next_in_queue_trigger');
        }
        
        static getIgnoreContainer() {
            return document.getElementById('ignoreBtn') || 
                   document.querySelector('.expand_to_fill')?.previousElementSibling || null;
        }

        // NEW: Fetch the primary game container on the Explore page
        // This isolates the name extraction from any "Recommended" or "Similar" blocks on the page.
        static getGameContainer() {
            return document.querySelector('.page_content_ctn') || document.body;
        }
    }

    class ReviewAnalyzer {
        static getState(colorsConfig) {
            const container = document.getElementById('userReviews');
            if (!container) return 'NO_REVIEWS';
            
            const rows = container.querySelectorAll('.user_reviews_summary_row');
            if (rows.length === 0) return 'NO_REVIEWS';

            let hasValidReviews = false;
            let hasNonBlueReview = false;

            rows.forEach(row => {
                const summaryCol = row.querySelector('.summary.column');
                if (!summaryCol) return;

                const statusSpan = summaryCol.querySelector('.game_review_summary');
                const countSpan = summaryCol.querySelector('.responsive_hidden');

                let hasBrackets = false;
                if (countSpan) {
                    const countText = countSpan.textContent.trim();
                    if (countText.startsWith('(') && countText.endsWith(')')) {
                        hasBrackets = true;
                    }
                }

                if (statusSpan && hasBrackets) {
                    hasValidReviews = true;
                    
                    const color = window.getComputedStyle(statusSpan).color;
                    if (color !== colorsConfig.BLUE) {
                        hasNonBlueReview = true;
                    }
                }
            });

            if (!hasValidReviews) return 'NO_REVIEWS';
            if (hasNonBlueReview) return 'IGNORE';
            return 'SPARE';
        }
    }

    class DecisionEngine {
        static strategies = {
            'all': () => 'SHOULD_IGNORE',
            'bad': (reviewState) => reviewState === 'IGNORE' ? 'SHOULD_IGNORE' : 'SHOULD_SPARE'
        };

        static decide(reviewState, mode) {
            const strategy = this.strategies[mode] || this.strategies['bad'];
            return strategy(reviewState);
        }
    }

    class NavigationGuard {
        constructor(sessionService) {
            this.session = sessionService;
            this.TTL = 15000;
        }

        isAuthorized() {
            const tokenJson = this.session.get(KEYS.NAV_TOKEN);
            this.session.remove(KEYS.NAV_TOKEN);

            if (!tokenJson) return false;
            try {
                const token = JSON.parse(tokenJson);
                const age = Date.now() - token.timestamp;
                return age < this.TTL;
            } catch (e) { return false; }
        }

        authorizeNextStep() {
            const token = { timestamp: Date.now() };
            this.session.set(KEYS.NAV_TOKEN, JSON.stringify(token));
        }

        resetState() {
            this.session.remove(KEYS.ACTIVE);
            this.session.remove(KEYS.FF);
            this.session.remove(KEYS.NAV_TOKEN);
        }

        getUserIntent() {
            return {
                wantsActive: this.session.get(KEYS.ACTIVE) === 'true',
                wantsFF: this.session.get(KEYS.FF) === 'true'
            };
        }

        setIntent(type) {
            if (type === 'ACTIVE') this.session.set(KEYS.ACTIVE, 'true');
            if (type === 'FF') this.session.set(KEYS.FF, 'true');
        }
    }

    // --- Infrastructure Services ---

    class ResourceService {
        getIconUrl(fileName) { return chrome.runtime.getURL(`./assets/icons/${fileName}`); }
    }

    class ExtensionSettingsService {
        async getSettings(keys) {
            return new Promise(resolve => chrome.storage.local.get(keys, resolve));
        }
        async updateSettings(data) {
            return new Promise(resolve => chrome.storage.local.set(data, resolve));
        }
        subscribeToChanges(callback) {
            chrome.storage.onChanged.addListener(callback);
        }
    }

    // Export
    window.ILAP.Explore.COLORS = COLORS;
    window.ILAP.Explore.Context = QueueContext;
    window.ILAP.Explore.Analyzer = ReviewAnalyzer;
    window.ILAP.Explore.DecisionEngine = DecisionEngine;
    window.ILAP.Explore.NavigationGuard = NavigationGuard;
    
    window.ILAP.Explore.ResourceService = ResourceService;
    window.ILAP.Explore.ExtensionSettingsService = ExtensionSettingsService; 
})();