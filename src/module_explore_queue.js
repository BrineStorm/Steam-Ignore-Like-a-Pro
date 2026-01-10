(function() {
    'use strict';

    class ExploreQueueHelper {
        constructor() {
            this.processedThisSession = new Set();
            this.nextTimeoutId = null;
            this.COLOR_BLUE = 'rgb(102, 192, 244)';
            this.COLOR_GRAY = 'rgb(136, 136, 136)';
            this.THEME = { IGNORE: '#d32f2f', SPARE: '#66c0f4', OFF: '#888888' };
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
                const color = window.getComputedStyle(summarySpan).color;
                const hasCount = /\(\d+[.,]?\d*\)/.test(row.textContent || "");

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
            return document.getElementById('ignoreBtn') || document.querySelector('.expand_to_fill')?.previousElementSibling || null;
        }

        /**
         * Robust language-independent next button finder
         */
        getNextButton() {
            return document.querySelector('#nextInDiscoveryQueue .btn_next_in_queue_trigger');
        }

        /**
         * Notification with a STOP button
         */
        showToast(message, countdown) {
            // Remove existing toast
            document.getElementById('ilap-toast')?.remove();

            const toast = document.createElement('div');
            toast.id = 'ilap-toast';
            toast.style.cssText = `
                position: fixed; bottom: 20px; right: 20px; background: #1b2838; color: #fff;
                padding: 15px; border-radius: 4px; border: 1px solid #66c0f4; z-index: 99999;
                box-shadow: 0 5px 20px rgba(0,0,0,0.8); font-family: sans-serif; min-width: 250px;
                display: flex; flex-direction: column; gap: 10px; transition: 0.3s;
            `;

            toast.innerHTML = `
                <div style="font-size: 13px; line-height: 1.4;">${message}</div>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <small style="color: #66c0f4; font-size: 10px;">Skipping in few seconds...</small>
                    <button id="ilap-stop-btn" style="background: #d32f2f; color: white; border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; font-size: 11px; font-weight: bold;">STOP</button>
                </div>
            `;

            document.body.appendChild(toast);

            document.getElementById('ilap-stop-btn').onclick = () => {
                if (this.nextTimeoutId) {
                    clearTimeout(this.nextTimeoutId);
                    this.nextTimeoutId = null;
                    toast.innerHTML = `<div style="color: #ffcc00; font-size: 12px; font-weight: bold;">Skipping Cancelled.</div>`;
                    setTimeout(() => toast.remove(), 2000);
                }
            };
        }

        async runHelper() {
            if (!this.isQueueContext()) return;
            const appid = this.getAppID();
            if (!appid || this.processedThisSession.has(appid)) return;

            chrome.storage.local.get(['ilap_explore_mode', 'ilap_master_enabled'], async (settings) => {
                if (settings.ilap_master_enabled === false) return;

                const mode = parseInt(settings.ilap_explore_mode || "0");
                const reviewState = this.evaluateReviewState();

                // MODE 0: Visual Off Helper
                if (mode === 0) {
                    if (reviewState === 'IGNORE') {
                        this.applyVisuals('OFF', "Game meets auto-ignore criteria, but ILAP is currently in OFF mode.");
                    }
                    return;
                }

                let shouldIgnore = false;
                let shouldNext = false;
                let reason = "Mixed/Negative Reviews";

                if (mode === 1 || mode === 2) { 
                    shouldIgnore = true; 
                    reason = "Settings (Ignore All)";
                    if (mode === 2) shouldNext = true;
                } 
                else if (mode === 3 || mode === 4) {
                    if (reviewState === 'IGNORE') {
                        shouldIgnore = true;
                        if (mode === 4) shouldNext = true;
                    }
                }

                if (shouldIgnore) {
                    this.processedThisSession.add(appid);
                    const success = await window.ILAP.apiIgnoreGame(appid, 0);
                    if (success) {
                        const name = window.ILAP.getGameName(appid);
                        window.ILAP.saveStats(name, "Explore Auto-Queue");
                        this.applyVisuals('IGNORE', reason);

                        if (shouldNext && this.getNextButton()) {
                            this.showToast(`The game <b>${name}</b> was ignored based on your settings. Moving to the next item...`, 2000);
                            this.nextTimeoutId = setTimeout(() => this.getNextButton().click(), 2500);
                        }
                    }
                } else {
                    this.applyVisuals(reviewState, "Current automation settings spared this game.");
                }
            });
        }

        applyVisuals(type, reasonText) {
            const container = this.getIgnoreContainer();
            if (!container) return;
            const themeColor = this.THEME[type] || this.THEME.SPARE;
            
            container.style.boxShadow = `0 0 0 2px ${themeColor}`;
            container.style.position = 'relative';

            if (type === 'IGNORE') {
                const inact = container.querySelector('.queue_btn_inactive');
                const act = container.querySelector('.queue_btn_active');
                if (inact) inact.style.display = 'none';
                if (act) act.style.display = 'block';
            }
            this.setupMicroBadge(container, type, themeColor, reasonText);
        }

        setupMicroBadge(container, type, color, reasonText) {
            container.querySelectorAll('.ilap-micro-badge, .ilap-tooltip').forEach(el => el.remove());
            const badge = document.createElement('div');
            badge.className = 'ilap-micro-badge';
            badge.style.cssText = `position: absolute; top: -10px; right: 2px; background: ${color}; color: white; font-size: 7px; font-weight: 800; padding: 1px 4px; border-radius: 3px; z-index: 100; text-transform: uppercase;`;
            badge.textContent = type;

            const tooltip = document.createElement('div');
            tooltip.className = 'ilap-tooltip';
            tooltip.style.cssText = `position: absolute; bottom: 140%; right: -10px; background: #171a21; color: #c7d5e0; padding: 6px 10px; border-radius: 4px; border: 1px solid ${color}; width: 160px; font-size: 11px; z-index: 1000; pointer-events: none; visibility: hidden; opacity: 0; transition: 0.15s; text-align: center;`;
            tooltip.innerHTML = `<b>ILAP: ${type}</b><br>Reason: ${reasonText}`;

            container.appendChild(badge);
            container.appendChild(tooltip);
            badge.addEventListener('mouseenter', () => { tooltip.style.visibility = 'visible'; tooltip.style.opacity = '1'; });
            badge.addEventListener('mouseleave', () => { tooltip.style.visibility = 'hidden'; tooltip.style.opacity = '0'; });
        }
    }

    function init() {
        const helper = new ExploreQueueHelper();
        helper.runHelper();
        let lastUrl = location.href;
        const observer = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                helper.runHelper();
            }
        });
        observer.observe(document.body, { subtree: true, childList: true });
    }
    init();
})();