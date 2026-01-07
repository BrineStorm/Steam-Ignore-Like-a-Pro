(function() {
    'use strict';

    /**
     * Helper module for the "Explore Queue" page.
     */
    class ExploreQueueHelper {
        constructor() {
            this.processedThisSession = new Set();
            this.COLOR_BLUE = 'rgb(102, 192, 244)';
            this.COLOR_GRAY = 'rgb(136, 136, 136)';
            this.THEME = { IGNORE: '#d32f2f', SPARE: '#66c0f4' };
        }

        isQueueContext() {
            const params = new URLSearchParams(window.location.search);
            return params.has('queue') && window.location.pathname.includes('/app/');
        }

        getAppID() {
            const match = window.location.pathname.match(/\/app\/(\d+)/);
            return match ? match[1] : null;
        }

        evaluateReviewState() {
            const container = document.getElementById('userReviews');
            if (!container) return 'UPCOMING';
            const rows = container.querySelectorAll('.user_reviews_summary_row');
            if (rows.length === 0) return 'UPCOMING';

            let hasPositive = false;
            let hasNegativeOrMixed = false;
            let hasReviewsWithCount = false;

            rows.forEach(row => {
                const summarySpan = row.querySelector('.game_review_summary');
                if (!summarySpan) return;
                const text = row.textContent || "";
                const color = window.getComputedStyle(summarySpan).color;
                const hasCount = /\(\d+[.,]?\d*\)/.test(text);

                if (color === this.COLOR_BLUE) {
                    hasPositive = true;
                    if (hasCount) hasReviewsWithCount = true;
                } else if (color === this.COLOR_GRAY) {
                    if (hasCount) hasReviewsWithCount = true;
                } else {
                    hasNegativeOrMixed = true;
                    if (hasCount) hasReviewsWithCount = true;
                }
            });

            if (!hasReviewsWithCount) return 'UPCOMING';
            if (hasNegativeOrMixed) return 'IGNORE';
            if (hasPositive && !hasNegativeOrMixed) return 'SPARE';
            return 'UPCOMING';
        }

        getIgnoreContainer() {
            const byId = document.getElementById('ignoreBtn');
            if (byId) return byId;
            const filler = document.querySelector('.expand_to_fill');
            return filler?.previousElementSibling || null;
        }

        async runHelper() {
            if (!this.isQueueContext()) return;
            const appid = this.getAppID();
            if (!appid || this.processedThisSession.has(appid)) return;

            const state = this.evaluateReviewState();

            if (state === 'UPCOMING') {
                this.applyVisuals('UPCOMING');
                return;
            }

            chrome.storage.local.get(['ilap_keep_high_score_explore'], async (settings) => {
                const keepHighScore = !!settings.ilap_keep_high_score_explore;

                if (keepHighScore && state === 'SPARE') {
                    this.applyVisuals('SPARE');
                    return;
                }

                this.processedThisSession.add(appid);
                const success = await window.ILAP.apiIgnoreGame(appid, 0);

                if (success) {
                    const name = window.ILAP.getGameName(appid);
                    window.ILAP.saveStats(name, "Explore Helper (Auto)");
                    this.applyVisuals('IGNORE');
                }
            });
        }

        applyVisuals(type) {
            const container = this.getIgnoreContainer();
            if (!container) return;
            const isIgnore = type === 'IGNORE';
            const themeColor = isIgnore ? this.THEME.IGNORE : this.THEME.SPARE;
            
            container.style.borderRadius = '4px';
            container.style.boxShadow = `0 0 0 2px ${themeColor}`;
            container.style.position = 'relative';

            if (isIgnore) {
                const inact = container.querySelector('.queue_btn_inactive');
                const act = container.querySelector('.queue_btn_active');
                if (inact) inact.style.display = 'none';
                if (act) act.style.display = 'block';
            }
            this.setupMicroBadge(container, type, themeColor);
        }

        setupMicroBadge(container, type, color) {
            container.querySelectorAll('.ilap-micro-badge, .ilap-tooltip').forEach(el => el.remove());
            let labelText = "SPARED";
            let tooltipContent = "<b>ILAP: Spared</b><br>Reason: High score reviews.";

            if (type === 'IGNORE') {
                labelText = "IGNORED";
                tooltipContent = "<b>ILAP: Auto-Ignored</b><br>Reason: Mixed/Negative reviews.";
            } else if (type === 'UPCOMING') {
                labelText = "UPCOMING";
                tooltipContent = "<b>ILAP: Skipped</b><br>Reason: No reviews yet (Upcoming).";
            }

            const badge = document.createElement('div');
            badge.className = 'ilap-micro-badge';
            badge.style.cssText = `
                position: absolute; top: -10px; right: 2px;
                background: ${color}; color: white; font-size: 7px; font-weight: 800;
                padding: 1px 4px; border-radius: 3px; cursor: help; z-index: 100;
                text-transform: uppercase; box-shadow: 0 1px 3px rgba(0,0,0,0.3);
                line-height: 10px; letter-spacing: 0.2px;
            `;
            badge.textContent = labelText;

            const tooltip = document.createElement('div');
            tooltip.className = 'ilap-tooltip';
            tooltip.style.cssText = `
                position: absolute; bottom: 140%; right: -10px;
                background: #171a21; color: #c7d5e0; padding: 6px 10px; border-radius: 4px;
                border: 1px solid ${color}; width: 160px; font-size: 11px; z-index: 1000;
                pointer-events: none; visibility: hidden; opacity: 0; transition: 0.15s;
                box-shadow: 0 4px 10px rgba(0,0,0,0.5); text-align: center; line-height: 1.3;
            `;
            tooltip.innerHTML = tooltipContent;

            container.appendChild(badge);
            container.appendChild(tooltip);

            badge.addEventListener('mouseenter', () => {
                tooltip.style.visibility = 'visible';
                tooltip.style.opacity = '1';
            });
            badge.addEventListener('mouseleave', () => {
                tooltip.style.visibility = 'hidden';
                tooltip.style.opacity = '0';
            });
        }
    }

    function init() {
        const helper = new ExploreQueueHelper();
        helper.runHelper();
        let lastUrl = location.href;
        const observer = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = url;
                helper.runHelper();
            }
        });
        observer.observe(document.body, { subtree: true, childList: true });
    }

    init();
})();