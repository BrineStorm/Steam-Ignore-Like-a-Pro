(function() {
    'use strict';

    const { BADGE_CLASSES, ContextScanner } = window.ILAP.ManualIgnore;

    class DuplicateDetector {
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
            
            return ContextScanner.hasBadgeInAncestors(checkEl, appid);
        }
    }

    class BadgeFactory {
        static create(appid, typeClass) {
            const overlay = document.createElement('div');
            overlay.className = `ilap-ignored-overlay ${typeClass}`;
            overlay.dataset.ilapAppid = appid;
            
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

    class BadgeRenderer {
        constructor(strategyProvider, duplicateDetector) {
            this.strategies = strategyProvider;
            this.detector = duplicateDetector;
        }

        render(linkElement, appid) {
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
            const badge = BadgeFactory.create(appid, variantClass);
            
            this._ensurePositioning(targetForBadge);
            targetForBadge.appendChild(badge);
            
            targetForBadge.dataset.ilapState = 'processed';
            targetForBadge.dataset.ilapIgnoreId = appid;
        }

        _getVariantClass(type) {
            const map = {
                'list': BADGE_CLASSES.LIST,
                'hero': BADGE_CLASSES.HERO,
                'grid': BADGE_CLASSES.GRID,
                'standard': BADGE_CLASSES.GRID
            };
            return map[type] || BADGE_CLASSES.GRID;
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

    // Exports
    window.ILAP.ManualIgnore.DuplicateDetector = DuplicateDetector;
    window.ILAP.ManualIgnore.BadgeRenderer = BadgeRenderer;

})();