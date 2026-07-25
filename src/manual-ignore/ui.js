// SPDX-License-Identifier: GPL-3.0-or-later
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
        // (an inset:0 overlay on the parent would miss that overhang). A capsule
        // can hold TWO views of the same art — the resting <img> and a hover
        // microtrailer <video> that overlays it 1:1 — and either can be on screen,
        // so both must be blurred; blurring only the largest left the resting
        // image sharp (the video, preload="none", won on area but is invisible).
        //
        // When the resting cover is a CSS background on the badge's OWN element
        // (the Featured & Recommended main capsule), filter:blur can't touch it
        // without smearing the badge — lay a backdrop veil under the badge instead.
        _applyBlur(targetForBadge, appid) {
            if (this._hasOwnCoverBackground(targetForBadge)) {
                this._applyBackdrop(targetForBadge, appid);
                return;
            }
            for (const art of this._pickArts(targetForBadge)) {
                art.classList.add('ilap-ignored-blur');
                art.dataset.ilapBlur = appid;
            }
        }

        // True when the badge target paints its own cover as a background-image —
        // the case filter:blur can't serve (it shares the box with the badge). A
        // size gate keeps an incidental small background (e.g. a decorative badge)
        // from hijacking capsules whose real cover is an <img> we can blur directly.
        _hasOwnCoverBackground(host) {
            if (getComputedStyle(host).backgroundImage === 'none') return false;
            return host.clientWidth * host.clientHeight > 20000;
        }

        // A blur veil under the badge: backdrop-filter blurs whatever art is painted
        // behind it (background, video, screenshots) while the badge (z-index:50)
        // sits above it. Idempotent so a re-render / syncMasks doesn't stack veils.
        _applyBackdrop(host, appid) {
            if (host.querySelector(':scope > .ilap-blur-backdrop')) return;
            const veil = document.createElement('div');
            veil.className = 'ilap-blur-backdrop';
            veil.dataset.ilapBlur = appid;
            host.appendChild(veil);
        }

        // The real cover art inside the badge target. A plain querySelector picks
        // the FIRST media, which on some surfaces is Steam's transparent blank.gif
        // spacer (e.g. .tab_item's overlay anchor) rather than the visible capsule
        // (.tab_item_cap_img). Drop those spacers and our own badge's tooltip icon,
        // then keep every element rendered at (near) the largest media's size — the
        // cover plus any full-bleed microtrailer overlay — while excluding small
        // decorative media (platform/discount icons) so blur stays on the art.
        _pickArts(container) {
            const media = Array.from(container.querySelectorAll('img, video')).filter(el => {
                if ((el.getAttribute('src') || '').includes('blank.gif')) return false;
                if (el.closest('.ilap-ignored-overlay')) return false;
                return true;
            });
            if (!media.length) return [];

            const areas = media.map(el => el.clientWidth * el.clientHeight);
            const bestArea = Math.max(...areas);
            // No layout yet (e.g. pre-render): fall back to the prior single-pick.
            if (bestArea <= 0) return [media[0]];
            // Keep the cover and any full-bleed microtrailer overlay (>= 50% of the
            // largest media); drop small decorative icons well under that.
            return media.filter((_, i) => areas[i] >= bestArea * 0.5);
        }

        // Remove a previously-rendered IGNORED badge for `appid` across the
        // document — the un-render path BadgeRenderer lacked (it only ever added).
        // Used when a game this tab badged is deliberately un-ignored (undo): the
        // badge, its blur class and any backdrop veil come off, and the container's
        // processed markers are cleared so a later re-ignore can badge it again.
        unrender(appid) {
            appid = String(appid);
            document.querySelectorAll(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`).forEach(badge => {
                const host = badge.parentElement;
                badge.remove();
                if (host) {
                    delete host.dataset.ilapState;
                    if (host.dataset.ilapIgnoreId === appid) delete host.dataset.ilapIgnoreId;
                }
            });
            document.querySelectorAll(`.ilap-ignored-blur[data-ilap-blur="${appid}"]`).forEach(el => {
                el.classList.remove('ilap-ignored-blur');
                delete el.dataset.ilapBlur;
            });
            document.querySelectorAll(`.ilap-blur-backdrop[data-ilap-blur="${appid}"]`).forEach(el => el.remove());
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
                // Backdrop veils are dedicated elements, not a class on the art —
                // remove them outright.
                document.querySelectorAll('.ilap-blur-backdrop').forEach(el => el.remove());
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