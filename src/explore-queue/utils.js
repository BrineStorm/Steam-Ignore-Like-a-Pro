// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.Explore = window.ILAP.Explore || {};

    // Steam's own review-summary shades come from the shared table
    // (src/steam-palette.js), which the Discovery Queue reads too — the two used
    // to keep private copies and the copies drifted. Each band is a SET: the
    // current shade first, older ones behind it. Classification fails SAFE: a
    // game is only IGNORE-worthy when a row colour matches one of the bad sets;
    // any unrecognised colour is treated as SPARE.
    const PALETTE = (window.ILAP && window.ILAP.SteamPalette) || { BLUE: [], MIXED: [], NEGATIVE: [] };
    const COLORS = {
        BLUE: PALETTE.BLUE,
        MIXED: PALETTE.MIXED,
        NEGATIVE: PALETTE.NEGATIVE,
        // Ours, not Steam's: the badge the Explore Queue paints on the page.
        RED_BG: '#d32f2f',
        BLUE_BG: '#45A1FA',
        BADGE_BLUE_BG: '#2a6cc6'
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

        // The primary game container on the Explore page, isolating name extraction
        // from any "Recommended" / "Similar" blocks elsewhere on the page.
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

        // Pure classification: resolved row colour strings + colour config → state.
        // FAIL-SAFE: IGNORE only when a row colour POSITIVELY matches a known bad
        // (Mixed/Negative) colour. Any unrecognised colour — e.g. a Steam theme
        // change that shifts the blue shade — is treated as SPARE, so a redesign
        // can never silently turn the queue into a mass-ignore. Mirrors the DQ
        // fail-safe (SlideScanner.getGameInfo defaults isPositive=true).
        static classify(colors, colorsConfig) {
            if (!colors || colors.length === 0) return 'NO_REVIEWS';
            // concat, not a two-element array: a band is a set of shades now
            // (current + the ones Steam painted before it), and this still
            // accepts a config that spells a band as a single string.
            const badColors = [].concat(colorsConfig.MIXED, colorsConfig.NEGATIVE);
            const hasBad = colors.some(c => badColors.includes(c));
            return hasBad ? 'IGNORE' : 'SPARE';
        }

        static getState(colorsConfig) {
            const summaries = ReviewAnalyzer.getRowSummaries() || [];
            const colors = summaries.map(s => window.getComputedStyle(s.statusSpan).color);
            return ReviewAnalyzer.classify(colors, colorsConfig);
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

    // The Queue Helper's settings in the automator's own terms, so the automator
    // never sees a storage key (`settings` is src/settings-schema.js):
    //   read()        → { globalOn, queueOn, autoNext, mode }
    //   subscribe(cb) → cb(change) with only what changed; the two switches as
    //                   { was, now }, so a caller can tell a transition from a
    //                   same-value write
    //   disableQueue()
    class QueueSettings {
        constructor(settings) {
            this.S = settings;
        }

        _values(get) {
            const { KEYS, DEFAULTS, isOn } = this.S;
            return {
                globalOn: isOn(get(KEYS.MASTER)),
                queueOn: isOn(get(KEYS.Q_MASTER)),
                autoNext: !!get(KEYS.Q_NEXT),
                mode: get(KEYS.Q_MODE) || DEFAULTS.Q_MODE,
            };
        }

        async read() {
            const K = this.S.KEYS;
            const res = await new Promise(resolve => chrome.storage.local.get(
                [K.MASTER, K.Q_MASTER, K.Q_NEXT, K.Q_MODE], resolve));
            return this._values((k) => res[k]);
        }

        // Local only: that is where these settings live, and the automator acts
        // on whatever arrives.
        subscribe(callback) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local') return;
                const change = this.toChange(changes);
                if (change) callback(change);
            });
        }

        toChange(changes) {
            const { KEYS } = this.S;
            const was = this._values((k) => (changes[k] ? changes[k].oldValue : undefined));
            const now = this._values((k) => (changes[k] ? changes[k].newValue : undefined));
            const change = {};
            if (changes[KEYS.MASTER]) change.globalOn = { was: was.globalOn, now: now.globalOn };
            if (changes[KEYS.Q_MASTER]) change.queueOn = { was: was.queueOn, now: now.queueOn };
            if (changes[KEYS.Q_NEXT]) change.autoNext = now.autoNext;
            if (changes[KEYS.Q_MODE]) change.mode = now.mode;
            return Object.keys(change).length ? change : null;
        }

        disableQueue() {
            return new Promise(resolve =>
                chrome.storage.local.set({ [this.S.KEYS.Q_MASTER]: false }, resolve));
        }
    }

    // Export
    window.ILAP.Explore.COLORS = COLORS;
    window.ILAP.Explore.KEYS = KEYS;
    window.ILAP.Explore.Context = QueueContext;
    window.ILAP.Explore.Analyzer = ReviewAnalyzer;
    window.ILAP.Explore.DecisionEngine = DecisionEngine;
    window.ILAP.Explore.NavigationGuard = NavigationGuard;
    window.ILAP.Explore.QueueSettings = QueueSettings;
})();