// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    const Sanitizer = window.ILAP.Sanitizer;
    const { fadeOut, sharpen, sizeToCapsule, ensurePositioning, applyBlur } = window.ILAP.ManualIgnore.MarkDom;

    // A collaborator is checked as its class is built, so a wiring slip fails
    // at boot rather than at the first mark.
    function need(cls, what, dep, fns) {
        if (!dep || !fns.every(fn => typeof dep[fn] === 'function')) {
            throw new TypeError(`[ILAP] ${cls} needs ${what}`);
        }
    }

    class DuplicateDetector {
        constructor(contextScanner) {
            need('DuplicateDetector', 'a scanner', contextScanner, ['hasBadgeInAncestors']);
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

    const t = window.ILAP.t;

    class BadgeFactory {
        // `auto`: the AI tab's HIGH level ignored the game (its crossed AI mark
        // is AiMarks', in the capsule's corner).
        static create(appid, typeClass, reason, iconUrl, auto) {
            const overlay = document.createElement('div');
            overlay.className = `ilap-ignored-overlay ${typeClass}` + (auto ? ' ilap-ignored-auto' : '');
            overlay.dataset.ilapAppid = appid;

            let tooltipText = t('ignore_applied_by');
            if (reason === 2) {
                overlay.style.backgroundColor = '#4072CB';
                tooltipText = t('ignored_already_played_applied_by');
            }

            // A game's badge keeps its click from the link under it (the click is
            // the un-ignore, main.js onBadge). A finished bundle's badge has no
            // un-ignore, so its click opens the bundle like the rest of the capsule.
            if (/^\d+$/.test(String(appid))) {
                overlay.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });
            }

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
        //   strategies  where a link's capsule is (containers.js)
        //   detector    DuplicateDetector
        //   classes     BADGE_CLASSES (containers.js)
        //   resources   the badge icon's URL
        //   maskConfig  { isEnabled() }: the blur over a badged cover
        //   aiMarks     the crossed AI mark that goes on and off with an auto badge (ai-marks.js)
        constructor(deps) {
            for (const dep of ['strategies', 'detector', 'classes', 'resources', 'maskConfig', 'aiMarks']) {
                if (!deps || !deps[dep]) throw new TypeError('[ILAP] BadgeRenderer needs deps.' + dep);
            }
            this.strategies = deps.strategies;
            this.detector = deps.detector;
            this.badgeClasses = deps.classes;
            this.resources = deps.resources;
            this.maskConfig = deps.maskConfig;
            this.aiMarks = deps.aiMarks;
        }

        render(linkElement, appid, reason, auto) {
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
            
            const badge = BadgeFactory.create(appid, variantClass, reason, iconUrl, auto);
            
            ensurePositioning(targetForBadge);
            targetForBadge.appendChild(badge);
            sizeToCapsule(badge, targetForBadge);
            if (auto) this.aiMarks.cross(targetForBadge, appid);

            if (this.maskConfig.isEnabled()) {
                applyBlur(targetForBadge, appid);
            }

            targetForBadge.dataset.ilapState = 'processed';
            targetForBadge.dataset.ilapIgnoreId = appid;
        }

        // Remove a previously-rendered IGNORED badge for `appid` across the
        // document, the inverse of render().
        // Used when a game this tab badged is deliberately un-ignored (undo): the
        // badge, its blur class and any backdrop veil come off, and the container's
        // processed markers are cleared so a later re-ignore can badge it again.
        unrender(appid) {
            appid = String(appid);
            document.querySelectorAll(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`).forEach(badge => {
                const host = badge.parentElement;
                delete badge.dataset.ilapAppid;
                fadeOut(badge);
                if (host) {
                    delete host.dataset.ilapState;
                    if (host.dataset.ilapIgnoreId === appid) delete host.dataset.ilapIgnoreId;
                }
            });
            // The cover sharpens as the badge fades.
            document.querySelectorAll(`.ilap-ignored-blur[data-ilap-blur="${appid}"]`).forEach(el => {
                el.classList.remove('ilap-ignored-blur');
                delete el.dataset.ilapBlur;
                sharpen(el);
            });
            document.querySelectorAll(`.ilap-blur-backdrop[data-ilap-blur="${appid}"]`).forEach(el => {
                delete el.dataset.ilapBlur;
                fadeOut(el);
            });
            this.aiMarks.uncross(appid);
        }

        // Reconcile the "un-ignore queued" mark across every badge in the document.
        // Deliberately NOT optimistic: a solo un-ignore does not remove the badge,
        // because putting it back on failure would need the original ignore reason
        // after the session map already dropped it. The badge only dims; it is
        // removed by the CONFIRMED un-ignore pulse that undo drains already emit,
        // and un-dimmed if the rollback is refused. Re-applied after every render
        // pass — Steam rebuilds capsules constantly and a fresh badge starts clean.
        syncPending(appids) {
            const wanted = new Set((appids || []).map(String));
            document.querySelectorAll('.ilap-ignored-overlay').forEach(badge => {
                badge.classList.toggle('ilap-undo-pending',
                    wanted.has(badge.dataset.ilapAppid));
            });
        }

        // Live toggle: reconcile blur for already-rendered badges. OFF strips the
        // blur class from every art element (badges stay); ON re-applies it to each
        // badged game's art for the given appids.
        syncMasks(appids) {
            if (!this.maskConfig.isEnabled()) {
                document.querySelectorAll('.ilap-ignored-blur').forEach(el => {
                    el.classList.remove('ilap-ignored-blur');
                    delete el.dataset.ilapBlur;
                });
                // Backdrop veils are dedicated elements, not a class on the art —
                // remove them outright. The AI tab's stay.
                document.querySelectorAll('.ilap-blur-backdrop[data-ilap-blur]').forEach(el => el.remove());
                return;
            }
            appids.forEach(appid => {
                document.querySelectorAll(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`).forEach(badge => {
                    if (badge.parentElement) applyBlur(badge.parentElement, appid);
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
    }

    // Steam's own marks on a capsule its account list greys out. A gesture there
    // paints no badge of ours: Steam's IGNORED flag takes the gesture's colour.
    // `tips`: what the tinted flag means, on hover (FloatTip below).
    class SteamFlagTint {
        constructor(tips) {
            need('SteamFlagTint', 'tips', tips, ['watch', 'hide']);
            this.tips = tips;
        }

        // The capsule Steam greys out as already on the account's list, or null.
        steamGreyed(linkElement) {
            return linkElement.closest('.ds_ignored');
        }

        // The badge colours (styles.css). The class sits on the capsule, the rule
        // reaches its flag.
        tintSteamFlag(greyed, appid, reason) {
            greyed.classList.toggle('ilap-steam-tint-played', reason === 2);
            greyed.classList.toggle('ilap-steam-tint-ignore', reason !== 2);
            greyed.dataset.ilapTint = String(appid);
            this.tips.watch();
        }

        untintSteamFlag(appid) {
            document.querySelectorAll(`[data-ilap-tint="${String(appid)}"]`).forEach(el => {
                el.classList.remove('ilap-steam-tint-ignore', 'ilap-steam-tint-played');
                delete el.dataset.ilapTint;
            });
            this.tips.hide();
        }
    }

    // What a tinted flag, an AI mark or the AI note's flag and buttons mean,
    // shown on hover. Steam dims and
    // clips the whole greyed capsule (opacity, overflow), and clips many others,
    // so a tooltip inside one would be faint or cut off: this one is a single
    // element on <body>, placed over the flag or the mark, after the badge
    // tooltip's dwell (styles.css). Watching starts with the first tint or mark,
    // so a page without one listens to nothing.
    class FloatTip {
        constructor(resources) {
            need('FloatTip', 'resources', resources, ['getIconUrl']);
            this.resources = resources;
            this.tip = null;
            this.flag = null;
            this.watching = false;
        }

        watch() {
            if (this.watching) return;
            this.watching = true;
            document.addEventListener('mouseover', (e) => this._onOver(e), true);
            document.addEventListener('mouseout', (e) => this._onOut(e), true);
            window.addEventListener('scroll', () => this.hide(), { capture: true, passive: true });
        }

        _onOver(e) {
            if (!e.isTrusted || !e.target.closest) return;
            // A mark swapped or taken off under the pointer sends no mouseout.
            if (this.flag && !this.flag.isConnected) this.hide();
            const flag = e.target.closest('[data-ilap-tint] > .ds_ignored_flag, .ilap-ai-tag, [data-ilap-tip]');
            if (flag && flag !== this.flag) this.show(flag);
        }

        _onOut(e) {
            if (!this.flag || !this.flag.contains(e.target)) return;
            if (!this.flag.contains(e.relatedTarget)) this.hide();
        }

        show(flag) {
            if (!this.tip || !this.tip.isConnected) {
                this.tip = document.createElement('div');
                this.tip.className = 'ilap-tooltip ilap-tooltip-floating';
                document.body.appendChild(this.tip);
            }
            // An element of ours names its own words (the AI note's flag and
            // buttons, ai-page.js), with the same stand-in for the icon.
            const own = flag.dataset.ilapTip;
            const ai = own === undefined && flag.classList.contains('ilap-ai-tag');
            const played = own === undefined && !ai && flag.parentElement.classList.contains('ilap-steam-tint-played');
            // Escaped with a stand-in for the icon, which then becomes the <img>.
            // The AI mark's text ends with it, as the badge's does.
            const text = own !== undefined ? own : ai ? t('ai_tag_tip') + ' \u0001'
                : t(played ? 'steam_tint_tip_played' : 'steam_tint_tip_ignore', { icon: '\u0001' });
            // A control aimed at answers sooner than a mark passed on the way.
            this.tip.classList.toggle('ilap-tooltip-quick', own !== undefined);
            const icon = `<img src="${Sanitizer.escapeHTML(this.resources.getIconUrl('icon16.png'))}" alt="">`;
            this.tip.innerHTML = Sanitizer.escapeHTML(text).replace('\u0001', icon);
            // Above the flag's left edge: Steam keeps that edge put while the
            // flag expands from its icon into the word. Above the AI mark's
            // right edge when the mark sits in the capsule's right corner, as
            // a flag's when in its left one.
            const r = flag.getBoundingClientRect();
            const box = ai && flag.parentElement.getBoundingClientRect();
            const end = ai && box.right - r.right < r.left - box.left;
            this.tip.classList.toggle('ilap-tooltip-end', end);
            this.tip.style.left = end ? `${r.right}px` : `${Math.max(4, r.left)}px`;
            this.tip.style.top = `${r.top}px`;
            this.tip.classList.add('show');
            this.flag = flag;
        }

        hide() {
            if (this.tip) this.tip.classList.remove('show');
            this.flag = null;
        }
    }

    window.ILAP.ManualIgnore.DuplicateDetector = DuplicateDetector;
    window.ILAP.ManualIgnore.BadgeRenderer = BadgeRenderer;
    window.ILAP.ManualIgnore.SteamFlagTint = SteamFlagTint;
    window.ILAP.ManualIgnore.FloatTip = FloatTip;

})();