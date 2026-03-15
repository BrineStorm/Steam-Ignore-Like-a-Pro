(function() {
    'use strict';

    class DuplicateDetector {
        /**
         * @param {Object} contextScanner
         */
        constructor(contextScanner) {
            this.scanner = contextScanner;
        }

        isProcessed(element) {
            const checkEl = element.tagName === 'IMG' ? element.parentElement : element;
            return checkEl.dataset.ilapState === 'processed' || checkEl.dataset.ilapState === 'processing';
        }

        isBadgeNearby(element, appid) {
            const checkEl = element.tagName === 'IMG' ? element.parentElement : element;

            if (checkEl.classList.contains('tab_item') || checkEl.closest('.store_main_capsule')) {
                return checkEl.dataset.ilapIgnoreId === appid || 
                       !!checkEl.querySelector(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`);
            }
            
            return this.scanner.hasBadgeInAncestors(checkEl, appid);
        }
    }

    class BadgeFactory {
        static create(appid, typeClass, reason) {
            const overlay = document.createElement('div');
            overlay.className = `ilap-ignored-overlay ${typeClass}`;
            overlay.dataset.ilapAppid = appid;
            
            let tooltipText = "Ignore applied by";
            if (reason === 2) {
                overlay.style.backgroundColor = '#3ca8fc'; 
                tooltipText = "Ignored (Already Played) applied by";
            }

            overlay.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });

            const iconUrl = chrome.runtime.getURL('icons/icon16.png');
            overlay.innerHTML = `
                IGNORED
                <div class="ilap-tooltip">
                    <div style="display: flex; align-items: center; gap: 6px; white-space: nowrap;">
                        <span>${tooltipText}</span>
                        <img src="${iconUrl}" style="width: 16px; height: 16px; vertical-align: middle;">                        
                    </div>
                </div>
            `;
            return overlay;
        }
    }

    class BadgeRenderer {
        /**
         * @param {Object} strategyProvider 
         * @param {Object} duplicateDetector 
         * @param {Object} badgeClasses - Map of UI classes
         */
        constructor(strategyProvider, duplicateDetector, badgeClasses) {
            this.strategies = strategyProvider;
            this.detector = duplicateDetector;
            this.badgeClasses = badgeClasses;
        }

        render(linkElement, appid, reason) {
            const containerObj = this.strategies.findContainer(linkElement);
            if (!containerObj) return;

            const { element, type } = containerObj;

            if (this.detector.isProcessed(element)) return;
            if (this.detector.isBadgeNearby(element, appid)) {
                const markEl = element.tagName === 'IMG' ? element.parentElement : element;
                markEl.dataset.ilapState = 'processed';
                return;
            }

            let targetForBadge = element.tagName === 'IMG' ? element.parentElement : element;
            targetForBadge.dataset.ilapState = 'processing';

            const variantClass = this._getVariantClass(type);
            const badge = BadgeFactory.create(appid, variantClass, reason);
            
            this._ensurePositioning(targetForBadge);
            targetForBadge.appendChild(badge);
            
            targetForBadge.dataset.ilapState = 'processed';
            targetForBadge.dataset.ilapIgnoreId = appid;
        }

        _getVariantClass(type) {
            const map = {
                'list': this.badgeClasses.LIST,
                'hero': this.badgeClasses.HERO,
                'grid': this.badgeClasses.GRID,
                'standard': this.badgeClasses.GRID
            };
            return map[type] || this.badgeClasses.GRID;
        }

        _ensurePositioning(element) {
            const style = getComputedStyle(element);
            if (style.position === 'static') {
                element.classList.add('ilap-tagged-container');
            }
            if (style.display === 'inline') {
                element.style.display = 'inline-block';
            }
        }
    }

    window.ILAP.ManualIgnore.DuplicateDetector = DuplicateDetector;
    window.ILAP.ManualIgnore.BadgeRenderer = BadgeRenderer;

})();