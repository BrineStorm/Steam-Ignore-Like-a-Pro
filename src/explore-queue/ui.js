(function() {
    'use strict';

    const { COLORS, Context } = window.ILAP.Explore;

    function getModeLabel(mode) {
        return mode === 'all' ? "Every Game" : "Bad Reviews";
    }

    class ActionUI {
        /**
         * @param {Object} resourceService - Instance of ResourceService
         */
        constructor(resourceService) {
            this.resources = resourceService;
        }

        showStartPrompt(initialMode, handlers) {
            document.getElementById('ilap-toast')?.remove();
            
            const toast = document.createElement('div');
            toast.id = 'ilap-toast';
            toast.style.cssText = `
                position: fixed; bottom: 20px; right: 20px; background: #1b2838; color: #c7d5e0;
                padding: 12px 15px; border-radius: 4px; border: 1px solid #66c0f4; z-index: 99999;
                box-shadow: 0 5px 20px rgba(0,0,0,0.8); font-family: sans-serif; min-width: 280px;
                display: flex; flex-direction: column; gap: 12px;
            `;

            // Use injected resource service
            const iconUrl = this.resources.getIconUrl('icon16.png');
            const modeLabel = getModeLabel(initialMode);

            toast.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-weight: bold; color: #fff; display: flex; align-items: center; gap: 8px;">
                        <img src="${iconUrl}" style="width:16px;">
                        Queue Helper
                    </div>
                    <div style="display: flex; align-items: center;">
                        <div id="ilap-disable-btn" style="font-size: 10px; color: #8f98a0; border: 1px solid #3d4a5d; padding: 3px 8px; border-radius: 3px; cursor: pointer; margin-right: 12px; background: transparent; transition: all 0.2s;">Disable</div>
                        <span id="ilap-close-x" style="font-size: 14px; color: #8f98a0; cursor: pointer; line-height: 1;">â</span>
                    </div>
                </div>

                <button id="ilap-run-btn" style="background: #5c7e10; color: white; border: none; padding: 10px; border-radius: 2px; cursor: pointer; font-size: 13px; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 8px;">
                    Auto-Ignore & Next
                    <span id="ilap-mode-badge" style="background: rgba(0,0,0,0.2); font-size: 10px; padding: 2px 6px; border-radius: 3px; color: #e1e1e1;">
                        [${modeLabel}]
                    </span>
                </button>
                
                <button id="ilap-ff-btn" style="background: #3d4a5d; color: white; border: none; padding: 8px; border-radius: 2px; cursor: pointer; font-size: 11px;">
                    Fast Forward (No Ignore)
                </button>
            `;

            document.body.appendChild(toast);

            document.getElementById('ilap-run-btn').onclick = handlers.onRun;
            
            document.getElementById('ilap-ff-btn').onclick = () => {
                const btn = document.getElementById('ilap-ff-btn');
                btn.textContent = "Skipping...";
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
            if (badge) {
                badge.textContent = `[${getModeLabel(newMode)}]`;
            }
        }

        showRunningToast(message, onStop) {
            let toast = document.getElementById('ilap-toast');
            if (!toast || !toast.querySelector('#ilap-stop-btn')) {
                toast?.remove();
                toast = document.createElement('div');
                toast.id = 'ilap-toast';
                toast.style.cssText = `
                    position: fixed; bottom: 20px; right: 20px; background: #1b2838; color: #fff;
                    padding: 15px; border-radius: 4px; border: 1px solid #66c0f4; z-index: 99999;
                    box-shadow: 0 5px 20px rgba(0,0,0,0.8); font-family: sans-serif; min-width: 250px;
                    display: flex; flex-direction: column; gap: 10px;
                `;
                document.body.appendChild(toast);
            }

            toast.innerHTML = `
                <div style="font-size: 13px; line-height: 1.4;">${message}</div>
                <div style="display: flex; justify-content: flex-end;">
                    <button id="ilap-stop-btn" style="background: #d32f2f; color: white; border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; font-size: 11px; font-weight: bold;">STOP</button>
                </div>
            `;

            const btn = document.getElementById('ilap-stop-btn');
            btn.onclick = () => {
                btn.textContent = "STOPPED";
                btn.style.opacity = "0.7";
                btn.style.cursor = "default";
                onStop();
            };
        }

        applyVisuals(type, reasonMode) {
            const container = Context.getIgnoreContainer();
            if (!container) return;
            
            const theme = { 
                'IGNORE': COLORS.RED_BG, 
                'SPARE': COLORS.BLUE_BG,
                'NO_REVIEWS': COLORS.BLUE_BG 
            };
            const color = theme[type] || COLORS.BLUE_BG;

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
            badge.style.cssText = `position: absolute; top: -10px; right: 2px; background: ${color}; color: white; font-size: 7px; font-weight: 800; padding: 1px 4px; border-radius: 3px; z-index: 100; text-transform: uppercase; cursor: help;`;            
            badge.textContent = type === 'NO_REVIEWS' ? 'NO REVIEWS' : type;

            const tooltip = document.createElement('div');
            tooltip.className = 'ilap-tooltip';
            tooltip.style.cssText = `position: absolute; bottom: 140%; right: -10px; background: #171a21; color: #c7d5e0; padding: 8px; border-radius: 4px; border: 1px solid ${color}; min-width: 180px; font-size: 11px; z-index: 1000; pointer-events: none; visibility: hidden; opacity: 0; transition: 0.15s; text-align: left;`;
            
            // Use injected resource service
            const iconUrl = this.resources.getIconUrl('icon16.png');
            const badgeLabel = reasonMode === 'all' ? "Every Game" : "Bad Reviews";
            
            let tooltipContent = '';

            if (type === 'NO_REVIEWS') {
                tooltipContent = `
                    <div style="display: flex; align-items: flex-start; gap: 6px;">
                        <span>Ignore isn't applied for game without reviews</span>    
                    </div>
                    <div>
                        <span style="color: #8f98a0;">Ignore setting - </span>
                        <div style="background: #3d4a5d; color: #fff; padding: 2px 6px; border-radius: 3px; display: inline-block; font-size: 10px; font-weight: bold;">
                            ${badgeLabel}
                        </div>
                    </div>
                `;
            } else {
                const intro = type === 'IGNORE' ? "Ignored by" : "Ignore skipped by";
                tooltipContent = `
                    <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
                        <span>${intro}</span>
                        <img src="${iconUrl}" style="width: 14px; vertical-align: middle;">
                    </div>
                    <div>
                        <span style="color: #8f98a0;">Ignore setting - </span>
                        <div style="background: #3d4a5d; color: #fff; padding: 2px 6px; border-radius: 3px; display: inline-block; font-size: 10px; font-weight: bold;">
                            ${badgeLabel}
                        </div>
                    </div>
                `;
            }

            tooltip.innerHTML = tooltipContent;

            container.appendChild(badge);
            container.appendChild(tooltip);
            
            badge.addEventListener('mouseenter', () => { tooltip.style.visibility = 'visible'; tooltip.style.opacity = '1'; });
            badge.addEventListener('mouseleave', () => { tooltip.style.visibility = 'hidden'; tooltip.style.opacity = '0'; });
        }
    }

    window.ILAP.Explore.UI = ActionUI;
})();