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
        YELLOW_BG: '#c1a50a' // New color for No Reviews
    };

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

    // Export
    window.ILAP.Explore.COLORS = COLORS;
    window.ILAP.Explore.Context = QueueContext;
    window.ILAP.Explore.Analyzer = ReviewAnalyzer;
})();