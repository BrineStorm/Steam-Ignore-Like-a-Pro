// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    const Sanitizer = window.ILAP.Sanitizer;
    const t = (k, p) => (window.ILAP && window.ILAP.t) ? window.ILAP.t(k, p) : k;

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
                <span style="color: #8f98a0;">${Sanitizer.escapeHTML(t('ignore_criteria'))} -</span>
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
                <span style="color: #8f98a0;">${Sanitizer.escapeHTML(t('ignore_criteria'))} -</span>
                <span style="background: #3d4a5d; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: bold;">
                    ${safeBadgeLabel}
                </span>
            </div>
        `,
        DEFAULT: ({ safeIconUrl, safeBadgeLabel }) => `
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 8px;">
                <img src="${safeIconUrl}" style="width: 14px; height: 14px; vertical-align: middle;">
                <span style="color: #66c0f4;">${Sanitizer.escapeHTML(t('not_auto_ignored_by'))}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
                <span style="color: #8f98a0;">${Sanitizer.escapeHTML(t('ignore_criteria'))} -</span>
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
        }

        clearStartPrompt() {
            const prompt = document.getElementById('ilap-toast');
            if (prompt && !prompt.querySelector('#ilap-stop-btn')) {
                prompt.remove();
            }
        }

        // Remove any Queue-Helper toast (start prompt OR running/FF toast). Used when
        // the master switch is turned off live and automation is being torn down.
        removeToast() {
            document.querySelectorAll('#ilap-toast').forEach(el => el.remove());
        }

        showStartPrompt(initialMode, handlers) {
            const existingToasts = document.querySelectorAll('#ilap-toast');
            existingToasts.forEach(t => t.remove());
            
            const toast = document.createElement('div');
            toast.id = 'ilap-toast';
            toast.style.cssText = `
                position: fixed; bottom: 20px; right: 20px; background: #1b2838; color: #c7d5e0;
                padding: 12px 15px; border-radius: 4px; border: 1px solid #66c0f4; z-index: 99999;
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

            document.getElementById('ilap-run-btn').onclick = handlers.onRun;

            document.getElementById('ilap-ff-btn').onclick = () => {
                const btn = document.getElementById('ilap-ff-btn');
                btn.textContent = t('skipping');
                btn.style.opacity = "0.7";
                handlers.onFastForward();
            };

            const disableBtn = document.getElementById('ilap-disable-btn');
            disableBtn.onclick = () => { toast.remove(); handlers.onDisable(); };
            
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

            const closeX = document.getElementById('ilap-close-x');
            closeX.onclick = () => toast.remove();
            closeX.onmouseenter = () => closeX.style.color = '#fff';
            closeX.onmouseleave = () => closeX.style.color = '#8f98a0';
        }

        updateRunButtonMode(newMode) {
            const badge = document.getElementById('ilap-mode-badge');
            if (badge) badge.textContent = `[${getModeLabel(newMode)}]`; 
        }

        showRunningToast(message, onStop) {
            const existingToasts = document.querySelectorAll('#ilap-toast');
            existingToasts.forEach(t => t.remove());

            let toast = document.createElement('div');
            toast.id = 'ilap-toast';
            toast.style.cssText = `
                position: fixed; bottom: 20px; right: 20px; background: #1b2838; color: #fff;
                padding: 15px; border-radius: 4px; border: 1px solid #66c0f4; z-index: 99999;
                box-shadow: 0 5px 20px rgba(0,0,0,0.8); font-family: sans-serif; min-width: 250px;
                display: flex; flex-direction: column; gap: 10px;
            `;
            document.body.appendChild(toast);

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

            const btn = document.getElementById('ilap-stop-btn');
            btn.onclick = () => {
                btn.textContent = t('toast_stopped');
                btn.style.opacity = "0.7";
                btn.style.cursor = "default";
                onStop();
            };
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

            container.style.boxShadow = `0 0 0 2px ${color}`;
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
            badge.style.cssText = `position: absolute; top: -12px; left: 50%; transform: translateX(-50%); background: ${badgeBg}; color: white; font-size: 11px; font-weight: 800; padding: 2px 9px; border-radius: 4px; z-index: 100; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; cursor: help;`;
            const BADGE_LABELS = { 'NO_REVIEWS': 'NO REVIEWS', 'SPARE': 'SPARED' };
            badge.textContent = BADGE_LABELS[type] || type;

            const tooltip = document.createElement('div');
            tooltip.className = 'ilap-tooltip';
            tooltip.style.cssText = `position: absolute; bottom: 140%; right: -10px; background: #171a21; color: #c7d5e0; padding: 8px 12px; border-radius: 4px; border: 1px solid ${color}; min-width: 200px; font-size: 11px; z-index: 1000; pointer-events: none; visibility: hidden; opacity: 0; transition: 0.15s; text-align: left; line-height: 1.4;`;
            
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