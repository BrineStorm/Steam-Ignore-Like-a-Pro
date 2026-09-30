// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    const Sanitizer = window.ILAP.Sanitizer;
    const t = window.ILAP.t;

    function getModeLabel(mode) {
        return mode === 'all' ? t('mode_every_game') : t('mode_bad_reviews');
    }

    const TOOLTIP_BUILDERS = {
        NO_REVIEWS: ({ safeIconUrl, safeBadgeLabel }) => `
            <div style="display: flex; align-items: flex-start; gap: 6px; margin-bottom: 6px;">
                <img src="${safeIconUrl}" style="width: 14px; height: 14px; vertical-align: middle; flex-shrink: 0; margin-top: 1px;">
                <span>${Sanitizer.escapeHTML(t('no_reviews_explanation'))}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px; margin-top: 8px;">
                <span style="color: #8f98a0; white-space: nowrap;">${Sanitizer.escapeHTML(t('ignore_criteria'))} -</span>
                <span style="background: #3d4a5d; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: bold;">
                    ${safeBadgeLabel}
                </span>
            </div>
        `,
        IGNORE: ({ safeIconUrl, safeBadgeLabel }) => `
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 8px;">
                <img src="${safeIconUrl}" style="width: 14px; height: 14px; vertical-align: middle;">
                <span>${Sanitizer.escapeHTML(t('ignored_by'))}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
                <span style="color: #8f98a0; white-space: nowrap;">${Sanitizer.escapeHTML(t('ignore_criteria'))} -</span>
                <span style="background: #3d4a5d; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: bold;">
                    ${safeBadgeLabel}
                </span>
            </div>
        `,
        DEFAULT: ({ safeIconUrl, safeBadgeLabel }) => `
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 8px;">
                <img src="${safeIconUrl}" style="width: 14px; height: 14px; vertical-align: middle;">
                <span style="color: #45A1FA;">${Sanitizer.escapeHTML(t('not_auto_ignored_by'))}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
                <span style="color: #8f98a0; white-space: nowrap;">${Sanitizer.escapeHTML(t('ignore_criteria'))} -</span>
                <span style="background: #3d4a5d; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: bold;">
                    ${safeBadgeLabel}
                </span>
            </div>
        `
    };

    class ActionUI {
        constructor(resourceService, themeColors, containerProviderFunc) {
            this.resources = resourceService;
            this.colors = themeColors;
            this.getContainer = containerProviderFunc;
            // The card's own inline boxShadow/position from before applyVisuals
            // first touched it, so clearVisuals can put back what Steam had: Steam
            // renders #ignoreBtn with an inline `position: relative; display: flex`,
            // which a reset to '' would strip.
            this._inlineBefore = new WeakMap();
            // OUR toast node. Everything inside it is reached through this
            // reference, never through document.getElementById: the toast lives in
            // the Steam page's DOM, and a page that plants its own
            // <div id="ilap-run-btn"> earlier in the document would otherwise take
            // our handler while the real button stayed dead. The ids are kept —
            // the E2E suite locates the toast by #ilap-toast.
            this._toast = null;
        }

        // Real user input only. These controls sit in the page's DOM, so a page
        // script can call .click() on them; every other surface in the extension
        // already refuses a synthetic event (curator menu, MI gestures, the popup
        // panel), and Run / Fast-forward / Disable are the heaviest of the lot —
        // Run starts a paced but unattended ignore run, Disable writes a setting.
        static _real(fn) {
            return (e) => { if (e && e.isTrusted) fn(e); };
        }

        clearStartPrompt() {
            const prompt = this._toast;
            if (prompt && !prompt.querySelector('#ilap-stop-btn')) {
                prompt.remove();
                this._toast = null;
            }
        }

        // Remove any Queue-Helper toast (start prompt OR running/FF toast). Used when
        // the master switch is turned off live and automation is being torn down.
        removeToast() {
            if (this._toast) this._toast.remove();
            this._toast = null;
        }

        // Undo applyVisuals (outline, micro-badge/tooltip, positioning) when the
        // switch goes off live. Steam's own ignore-button state stays: the game
        // really is ignored.
        clearVisuals() {
            const container = this.getContainer();
            if (!container) return;
            // Scoped to the card: .ilap-tooltip is shared with Manual-Ignore's plates.
            container.querySelectorAll('.ilap-micro-badge, .ilap-tooltip').forEach(el => el.remove());
            // Nothing recorded means applyVisuals never ran on this card, so these
            // inline styles are not ours to clear — restoring a default of '' would
            // strip whatever else put them there. Reachable: _setupListener runs
            // before the globalOn/queueOn gate, so a queue page that never drew a
            // verdict still answers a live master-off with clearVisuals().
            const before = this._inlineBefore.get(container);
            if (!before) return;
            container.style.boxShadow = before.boxShadow;
            container.style.position = before.position;
            this._inlineBefore.delete(container);
        }

        showStartPrompt(initialMode, handlers) {
            this.removeToast();

            const toast = document.createElement('div');
            toast.id = 'ilap-toast';
            toast.style.cssText = `
                position: fixed; bottom: 20px; right: 20px; background: #1b2838; color: #c7d5e0;
                padding: 12px 15px; border-radius: 4px; border: 1px solid #45A1FA; z-index: 99999;
                box-shadow: 0 5px 20px rgba(0,0,0,0.8); font-family: sans-serif; min-width: 280px;
                display: flex; flex-direction: column; gap: 12px;
            `;

            const safeIconUrl = Sanitizer.escapeHTML(this.resources.getIconUrl('icon16.png'));
            const safeModeLabel = Sanitizer.escapeHTML(getModeLabel(initialMode));

            toast.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-weight: bold; color: #fff; display: flex; align-items: center; gap: 8px;">
                        <img src="${safeIconUrl}" style="width:16px;">
                        ${Sanitizer.escapeHTML(t('queue_helper'))}
                    </div>
                    <div style="display: flex; align-items: center;">
                        <div id="ilap-disable-btn" style="font-size: 10px; color: #8f98a0; border: 1px solid #3d4a5d; padding: 3px 8px; border-radius: 3px; cursor: pointer; margin-right: 12px; background: transparent; transition: all 0.2s;">${Sanitizer.escapeHTML(t('disable'))}</div>
                        <span id="ilap-close-x" style="font-size: 14px; color: #8f98a0; cursor: pointer; line-height: 1;">✕</span>
                    </div>
                </div>

                <button id="ilap-run-btn" style="background: #5c7e10; color: white; border: none; padding: 10px; border-radius: 2px; cursor: pointer; font-size: 13px; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 8px;">
                    ${Sanitizer.escapeHTML(t('run_auto_ignore'))}
                    <span id="ilap-mode-badge" style="background: rgba(0,0,0,0.2); font-size: 10px; padding: 2px 6px; border-radius: 3px; color: #e1e1e1;">
                        [${safeModeLabel}]
                    </span>
                </button>

                <button id="ilap-ff-btn" style="background: #3d4a5d; color: white; border: none; padding: 8px; border-radius: 2px; cursor: pointer; font-size: 11px;">
                    ${Sanitizer.escapeHTML(t('fast_forward_no_ignore'))}
                </button>
            `;

            document.body.appendChild(toast);
            this._toast = toast;

            const ffBtn = toast.querySelector('#ilap-ff-btn');
            toast.querySelector('#ilap-run-btn').onclick = ActionUI._real(handlers.onRun);

            ffBtn.onclick = ActionUI._real(() => {
                ffBtn.textContent = t('skipping');
                ffBtn.style.opacity = "0.7";
                handlers.onFastForward();
            });

            const disableBtn = toast.querySelector('#ilap-disable-btn');
            disableBtn.onclick = ActionUI._real(() => { this.removeToast(); handlers.onDisable(); });
            
            disableBtn.onmouseenter = () => { 
                disableBtn.style.backgroundColor = '#d32f2f';
                disableBtn.style.color = '#fff'; 
                disableBtn.style.borderColor = '#d32f2f';
            };
            disableBtn.onmouseleave = () => { 
                disableBtn.style.backgroundColor = 'transparent'; 
                disableBtn.style.color = '#8f98a0'; 
                disableBtn.style.borderColor = '#3d4a5d';
            };

            const closeX = toast.querySelector('#ilap-close-x');
            closeX.onclick = ActionUI._real(() => this.removeToast());
            closeX.onmouseenter = () => closeX.style.color = '#fff';
            closeX.onmouseleave = () => closeX.style.color = '#8f98a0';
        }

        updateRunButtonMode(newMode) {
            const badge = this._toast && this._toast.querySelector('#ilap-mode-badge');
            if (badge) badge.textContent = `[${getModeLabel(newMode)}]`; 
        }

        showRunningToast(message, onStop) {
            this.removeToast();

            let toast = document.createElement('div');
            toast.id = 'ilap-toast';
            toast.style.cssText = `
                position: fixed; bottom: 20px; right: 20px; background: #1b2838; color: #fff;
                padding: 15px; border-radius: 4px; border: 1px solid #45A1FA; z-index: 99999;
                box-shadow: 0 5px 20px rgba(0,0,0,0.8); font-family: sans-serif; min-width: 250px;
                display: flex; flex-direction: column; gap: 10px;
            `;
            document.body.appendChild(toast);
            this._toast = toast;

            const { bold = '', text = '' } = message || {};
            const safeBold = bold ? `<b>${Sanitizer.escapeHTML(bold)}</b>` : '';
            const safeText = Sanitizer.escapeHTML(text);
            const messageHtml = safeBold ? `${safeBold} ${safeText}` : safeText;

            toast.innerHTML = `
                <div style="font-size: 13px; line-height: 1.4;">${messageHtml}</div>
                <div style="display: flex; justify-content: flex-end;">
                    <button id="ilap-stop-btn" style="background: #d32f2f; color: white; border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; font-size: 11px; font-weight: bold;">${Sanitizer.escapeHTML(t('toast_stop'))}</button>
                </div>
            `;

            const btn = toast.querySelector('#ilap-stop-btn');
            btn.onclick = ActionUI._real(() => {
                btn.textContent = t('toast_stopped');
                btn.style.opacity = "0.7";
                btn.style.cursor = "default";
                onStop();
            });
        }

        showFastForwardToast(onStop) {
            this.showRunningToast({ text: t('fast_forwarding') }, onStop);
        }

        showIgnoredToast(name, onStop) {
            this.showRunningToast({ bold: name, text: t('ignored_moving_next') }, onStop);
        }

        applyVisuals(type, reasonMode) {
            const container = this.getContainer();
            if (!container) return;
            
            const theme = { 
                'IGNORE': this.colors.RED_BG, 
                'SPARE': this.colors.BLUE_BG,
                'NO_REVIEWS': this.colors.BLUE_BG 
            };
            const color = theme[type] || this.colors.BLUE_BG;

            if (!this._inlineBefore.has(container)) {
                this._inlineBefore.set(container, { boxShadow: container.style.boxShadow, position: container.style.position });
            }
            container.style.boxShadow = `0 0 0 1px ${color}`;
            container.style.position = 'relative';

            if (type === 'IGNORE') {
                const inact = container.querySelector('.queue_btn_inactive');
                const act = container.querySelector('.queue_btn_active');
                if (inact) inact.style.display = 'none';
                if (act) act.style.display = 'block';
            }
            
            this._setupMicroBadge(container, type, color, reasonMode);
        }

        _setupMicroBadge(container, type, color, reasonMode) {
            container.querySelectorAll('.ilap-micro-badge, .ilap-tooltip').forEach(el => el.remove());
            
            const badge = document.createElement('div');
            badge.className = 'ilap-micro-badge';
            const badgeBg = type === 'IGNORE' ? color : (this.colors.BADGE_BLUE_BG || color);
            // Anchored to the upper-right ~2/3 of the button (not centred), so the
            // plate reads as a corner tag rather than a banner across the middle.
            badge.style.cssText = `position: absolute; top: -8px; left: 66%; transform: translateX(-50%); background: ${badgeBg}; color: white; font-size: 8px; font-weight: 800; padding: 1px 6px; border-radius: 3px; z-index: 100; text-transform: uppercase; letter-spacing: 0.4px; white-space: nowrap; cursor: help;`;
            // Past-tense labels: the action has already happened on this card.
            const BADGE_LABELS = { 'NO_REVIEWS': 'NO REVIEWS', 'SPARE': 'SPARED', 'IGNORE': 'IGNORED' };
            badge.textContent = BADGE_LABELS[type] || type;

            const tooltip = document.createElement('div');
            tooltip.className = 'ilap-tooltip';
            tooltip.style.cssText = `position: absolute; bottom: 140%; right: -10px; background: #171a21; color: #c7d5e0; padding: 8px 12px; border-radius: 4px; border: 1px solid ${color}; min-width: 220px; font-size: 11px; z-index: 1000; pointer-events: none; visibility: hidden; opacity: 0; transition: 0.15s; text-align: left; line-height: 1.4;`;
            
            const safeIconUrl = Sanitizer.escapeHTML(this.resources.getIconUrl('icon16.png'));
            const safeBadgeLabel = Sanitizer.escapeHTML(getModeLabel(reasonMode));

            const builder = TOOLTIP_BUILDERS[type] || TOOLTIP_BUILDERS.DEFAULT;
            tooltip.innerHTML = builder({ safeIconUrl, safeBadgeLabel });

            container.appendChild(badge);
            container.appendChild(tooltip);
            
            badge.addEventListener('mouseenter', () => { tooltip.style.visibility = 'visible'; tooltip.style.opacity = '1'; });
            badge.addEventListener('mouseleave', () => { tooltip.style.visibility = 'hidden'; tooltip.style.opacity = '0'; });
        }
    }

    window.ILAP.Explore.UI = ActionUI;
})();