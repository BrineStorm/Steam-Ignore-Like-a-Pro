(function() {
    'use strict';

    const Sanitizer = window.ILAP.Sanitizer;

    class DuplicateDetector {
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

    const t = (k, p) => (window.ILAP && window.ILAP.t) ? window.ILAP.t(k, p) : k;

    class BadgeFactory {
        static create(appid, typeClass, reason, iconUrl) {
            const overlay = document.createElement('div');
            overlay.className = `ilap-ignored-overlay ${typeClass}`;
            overlay.dataset.ilapAppid = appid;

            let tooltipText = t('ignore_applied_by');
            if (reason === 2) {
                overlay.style.backgroundColor = '#4072CB';
                tooltipText = t('ignored_already_played_applied_by');
            }

            overlay.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });

            const safeIconUrl = Sanitizer.escapeHTML(iconUrl);
            const safeText = Sanitizer.escapeHTML(tooltipText);

            overlay.innerHTML = `
                IGNORED
                <div class="ilap-tooltip">
                    <div style="display: flex; align-items: center; gap: 6px; white-space: nowrap;">
                        <span>${safeText}</span>
                        <img src="${safeIconUrl}" style="width: 16px; height: 16px; vertical-align: middle;">
                    </div>
                </div>
            `;
            return overlay;
        }
    }

    class BadgeRenderer {
        constructor(strategyProvider, duplicateDetector, badgeClasses, resourceService, maskConfig) {
            this.strategies = strategyProvider;
            this.detector = duplicateDetector;
            this.badgeClasses = badgeClasses;
            this.resources = resourceService;
            this.maskConfig = maskConfig;
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
            const iconUrl = this.resources.getIconUrl('icon16.png'); 
            
            const badge = BadgeFactory.create(appid, variantClass, reason, iconUrl);
            
            this._ensurePositioning(targetForBadge);
            targetForBadge.appendChild(badge);

            if (this.maskConfig && this.maskConfig.isEnabled()) {
                this._applyBlur(targetForBadge, appid);
            }

            targetForBadge.dataset.ilapState = 'processed';
            targetForBadge.dataset.ilapIgnoreId = appid;
        }

        // Blur the cover art itself: the filter rides its exact box, so an image
        // that overflows onto a sibling video is blurred where it actually renders
        // (an inset:0 overlay on the parent would miss that overhang).
        _applyBlur(targetForBadge, appid) {
            const art = this._pickArt(targetForBadge);
            if (!art) return;
            art.classList.add('ilap-ignored-blur');
            art.dataset.ilapBlur = appid;
        }

        // Pick the real cover art inside the badge target. A plain
        // querySelector('img, video') grabs the FIRST media, which on some surfaces
        // is Steam's transparent blank.gif spacer (e.g. .tab_item's overlay anchor)
        // rather than the visible capsule (.tab_item_cap_img). Skip those spacers
        // and our own badge's tooltip icon, then take the largest-rendered element.
        _pickArt(container) {
            const media = Array.from(container.querySelectorAll('img, video')).filter(el => {
                if ((el.getAttribute('src') || '').includes('blank.gif')) return false;
                if (el.closest('.ilap-ignored-overlay')) return false;
                return true;
            });
            if (!media.length) return null;

            let best = media[0];
            let bestArea = -1;
            for (const el of media) {
                const area = el.clientWidth * el.clientHeight;
                if (area > bestArea) { bestArea = area; best = el; }
            }
            return best;
        }

        // Live toggle: reconcile blur for already-rendered badges. OFF strips the
        // blur class from every art element (badges stay); ON re-applies it to each
        // badged game's art for the given appids.
        syncMasks(appids) {
            if (!this.maskConfig || !this.maskConfig.isEnabled()) {
                document.querySelectorAll('.ilap-ignored-blur').forEach(el => {
                    el.classList.remove('ilap-ignored-blur');
                    delete el.dataset.ilapBlur;
                });
                return;
            }
            appids.forEach(appid => {
                document.querySelectorAll(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`).forEach(badge => {
                    if (badge.parentElement) this._applyBlur(badge.parentElement, appid);
                });
            });
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