// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.Explore = window.ILAP.Explore || {};

    const COLORS = {
        BLUE: 'rgb(102, 192, 244)',
        GRAY: 'rgb(136, 136, 136)',
        RED_BG: '#d32f2f',
        BLUE_BG: '#45A1FA',
        BADGE_BLUE_BG: '#2a6cc6',
        OFF_BG: '#888888',
        YELLOW_BG: '#c1a50a' 
    };

    const KEYS = {
        ACTIVE: 'ilap_queue_active',
        FF: 'ilap_queue_ff',
        NAV_TOKEN: 'ilap_queue_nav_token',
        ACTIVE_APPID: 'ilap_queue_active_appid'
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
        // DOM read: returns one entry per review row that has both a status span and a bracketed count.
        static getRowSummaries() {
            const container = document.getElementById('userReviews');
            if (!container) return null;

            const rows = container.querySelectorAll('.user_reviews_summary_row');
            const summaries = [];

            rows.forEach(row => {
                const summaryCol = row.querySelector('.summary.column');
                if (!summaryCol) return;

                const statusSpan = summaryCol.querySelector('.game_review_summary');
                const countSpan = summaryCol.querySelector('.responsive_hidden');

                const countText = countSpan ? countSpan.textContent.trim() : '';
                const hasBrackets = countText.startsWith('(') && countText.endsWith(')');

                if (statusSpan && hasBrackets) {
                    summaries.push({ statusSpan });
                }
            });

            return summaries;
        }

        // Colour interpretation (DOM-bound but isolated from row collection).
        static isNonBlueStatus(statusSpan, blueColor) {
            return window.getComputedStyle(statusSpan).color !== blueColor;
        }

        // Pure classification: rows + colour predicate → state enum.
        static classify(summaries, blueColor) {
            if (!summaries || summaries.length === 0) return 'NO_REVIEWS';
            const hasNonBlue = summaries.some(s => ReviewAnalyzer.isNonBlueStatus(s.statusSpan, blueColor));
            return hasNonBlue ? 'IGNORE' : 'SPARE';
        }

        static getState(colorsConfig) {
            const summaries = ReviewAnalyzer.getRowSummaries();
            return ReviewAnalyzer.classify(summaries, colorsConfig.BLUE);
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

        consumeAuthorization() {
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
            this.session.remove(KEYS.ACTIVE_APPID);
        }

        getUserIntent() {
            return {
                wantsActive: this.session.get(KEYS.ACTIVE) === 'true',
                wantsFF: this.session.get(KEYS.FF) === 'true'
            };
        }

        setIntent(type, appid) {
            if (type === 'ACTIVE') this.session.set(KEYS.ACTIVE, 'true');
            if (type === 'FF') this.session.set(KEYS.FF, 'true');
            if (appid) this.session.set(KEYS.ACTIVE_APPID, String(appid));
        }

        // Tracks the appid that the current ACTIVE/FF intent belongs to.
        // Used to distinguish a same-page reload (legitimate) from a
        // sideways navigation to a different queue page (must re-prompt).
        setActiveAppid(appid) {
            if (appid) this.session.set(KEYS.ACTIVE_APPID, String(appid));
        }

        getActiveAppid() {
            return this.session.get(KEYS.ACTIVE_APPID);
        }
    }

    // --- Infrastructure Services ---

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
    window.ILAP.Explore.KEYS = KEYS;
    window.ILAP.Explore.Context = QueueContext;
    window.ILAP.Explore.Analyzer = ReviewAnalyzer;
    window.ILAP.Explore.DecisionEngine = DecisionEngine;
    window.ILAP.Explore.NavigationGuard = NavigationGuard;
    window.ILAP.Explore.ExtensionSettingsService = ExtensionSettingsService;
})();