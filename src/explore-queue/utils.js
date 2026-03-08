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
    }

    class ReviewAnalyzer {
        static getState() {
            const container = document.getElementById('userReviews');
            if (!container) return 'NO_REVIEWS';
            
            const rows = container.querySelectorAll('.user_reviews_summary_row');
            if (rows.length === 0) return 'NO_REVIEWS';

            let hasPositive = false;
            let hasNegativeOrMixed = false;
            let hasReviewsWithCount = false;

            rows.forEach(row => {
                const summarySpan = row.querySelector('.game_review_summary');
                if (!summarySpan) return;
                
                const color = window.getComputedStyle(summarySpan).color;
                const hasCount = /\(\d+[.,]?\d*\)/.test(row.textContent || "");

                if (color === COLORS.BLUE) {
                    hasPositive = true;
                    if (hasCount) hasReviewsWithCount = true;
                } else if (color === COLORS.GRAY) {
                    if (hasCount) hasReviewsWithCount = true;
                } else {
                    hasNegativeOrMixed = true;
                    if (hasCount) hasReviewsWithCount = true;
                }
            });

            if (!hasReviewsWithCount) return 'NO_REVIEWS';
            if (hasNegativeOrMixed) return 'IGNORE';
            if (hasPositive && !hasNegativeOrMixed) return 'SPARE';
            return 'NO_REVIEWS';
        }
    }

    /**
     * SRP: Responsible ONLY for making the "Ignore" decision based on rules.
     * OCP: Easy to extend with new modes.
     */
    class DecisionEngine {
        static decide(reviewState, mode) {
            // Mode: Every Game
            if (mode === 'all') {
                return 'SHOULD_IGNORE';
            }
            
            // Mode: Bad Reviews (Default)
            if (reviewState === 'IGNORE') {
                return 'SHOULD_IGNORE';
            }

            // Default: Do not ignore (Spare)
            return 'SHOULD_SPARE';
        }
    }

    /**
     * SRP: Responsible ONLY for validating navigation integrity (Tokens).
     */
    class NavigationGuard {
        constructor(storageService) {
            this.storage = storageService;
            this.TTL = 15000; // 15 seconds
        }

        isAuthorized() {
            const tokenJson = this.storage.getSession(KEYS.NAV_TOKEN);
            this.storage.removeSession(KEYS.NAV_TOKEN); // Consume immediately

            if (!tokenJson) return false;

            try {
                const token = JSON.parse(tokenJson);
                const age = Date.now() - token.timestamp;
                return age < this.TTL;
            } catch (e) {
                return false;
            }
        }

        authorizeNextStep() {
            const token = { timestamp: Date.now() };
            this.storage.setSession(KEYS.NAV_TOKEN, JSON.stringify(token));
        }

        resetState() {
            this.storage.removeSession(KEYS.ACTIVE);
            this.storage.removeSession(KEYS.FF);
            this.storage.removeSession(KEYS.NAV_TOKEN);
        }

        getUserIntent() {
            return {
                wantsActive: this.storage.getSession(KEYS.ACTIVE) === 'true',
                wantsFF: this.storage.getSession(KEYS.FF) === 'true'
            };
        }

        setIntent(type) {
            if (type === 'ACTIVE') this.storage.setSession(KEYS.ACTIVE, 'true');
            if (type === 'FF') this.storage.setSession(KEYS.FF, 'true');
        }
    }

    // --- Infrastructure Services ---

    class ResourceService {
        getIconUrl(fileName) {
            return chrome.runtime.getURL(`icons/${fileName}`);
        }
    }

    class StorageService {
        async getSettings(keys) {
            return new Promise(resolve => chrome.storage.local.get(keys, resolve));
        }

        async updateSettings(data) {
            return new Promise(resolve => chrome.storage.local.set(data, resolve));
        }

        subscribeToChanges(callback) {
            chrome.storage.onChanged.addListener(callback);
        }

        setSession(key, value) {
            sessionStorage.setItem(key, value);
        }

        getSession(key) {
            return sessionStorage.getItem(key);
        }

        removeSession(key) {
            sessionStorage.removeItem(key);
        }
    }

    // Export
    window.ILAP.Explore.COLORS = COLORS;
    window.ILAP.Explore.Context = QueueContext;
    window.ILAP.Explore.Analyzer = ReviewAnalyzer;
    window.ILAP.Explore.DecisionEngine = DecisionEngine;
    window.ILAP.Explore.NavigationGuard = NavigationGuard;
    window.ILAP.Explore.ResourceService = ResourceService;
    window.ILAP.Explore.StorageService = StorageService;
})();