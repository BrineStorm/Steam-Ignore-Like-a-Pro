// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';
    
    window.ILAP = window.ILAP || {};
    window.ILAP.Discovery = window.ILAP.Discovery || {};

    const IDS = {
        CONTAINER: 'ilap-queue-controls',
        BUTTON: 'queue-auto-ignore-btn'
    };

    class Styles {
        static inject() {
            if (document.getElementById('ilap-queue-styles')) return;
            const style = document.createElement('style');
            style.id = 'ilap-queue-styles';
            style.textContent = `
                .ilap-controls-container {
                    display: flex; align-items: center; gap: 10px; margin-right: 15px;
                    height: 34px; flex-grow: 0; flex-shrink: 0; font-size: 13px;
                }
                #${IDS.BUTTON} {
                    height: 32px; line-height: 30px; padding: 0 15px; font-size: 14px;
                    border-radius: 2px; cursor: pointer; font-family: "Motiva Sans", Sans-serif;
                    font-weight: normal; box-shadow: 2px 2px 5px rgba(0,0,0,0.2); white-space: nowrap;
                    background-color: #5c7e10; color: #fff; border: 1px solid #4c6b22;
                    display: flex; align-items: center; justify-content: center;
                }
                #${IDS.BUTTON}:hover { filter: brightness(1.1); }
                #${IDS.BUTTON}:active { transform: scale(0.98); }
                
                #${IDS.BUTTON}.running {
                    background-color: #d32f2f; border: 1px solid #b71c1c;
                }
                /* Transient "cap reached" state: greyed, non-actionable look while
                   the message shows, then it reverts to the idle Start button. */
                #${IDS.BUTTON}.refused {
                    background-color: #4a4a4a; border: 1px solid #333; cursor: default;
                }
                
                .ilap-checkbox-label {
                    display: flex; align-items: center; font-size: 12px;
                    cursor: pointer; user-select: none; margin-right: 8px;
                    color: #ffffff;
                    font-weight: 600;
                    text-shadow: 
                        1px 1px 0 #000, 
                       -1px -1px 0 #000, 
                        1px -1px 0 #000, 
                       -1px 1px 0 #000, 
                        0px 2px 4px rgba(0,0,0,0.8);
                    transition: color 0.2s;
                }
                .ilap-checkbox-label:hover { color: #45A1FA; }
                
                .ilap-checkbox { margin-right: 6px; margin-top: 0; cursor: pointer; }
                
                .btn-symbol { margin-right: 8px; font-size: 12px; line-height: 1; }
            `;
            document.head.appendChild(style);
        }
    }

    const t = (k, p) => (window.ILAP && window.ILAP.t) ? window.ILAP.t(k, p) : k;
    const escapeHTML = (s) => (window.ILAP && window.ILAP.Sanitizer) ? window.ILAP.Sanitizer.escapeHTML(s) : String(s);

    class DiscoveryQueueUI {
        constructor() {
            this.container = null;
            this.button = null;
            this.checkbox = null;
            this._refuseTimer = null;
            Styles.inject();
        }

        mount(insertionPoint, events) {
            if (this.container) return;

            this.container = document.createElement('div');
            this.container.className = 'ilap-controls-container';
            this.container.id = IDS.CONTAINER;

            const label = document.createElement('label');
            label.className = 'ilap-checkbox-label';

            this.checkbox = document.createElement('input');
            this.checkbox.type = 'checkbox';
            this.checkbox.className = 'ilap-checkbox';
            this.checkbox.addEventListener('change', (e) => events.onCheckboxChange(e.target.checked));

            label.appendChild(this.checkbox);
            label.appendChild(document.createTextNode(t('keep_high_score')));

            this.button = document.createElement('button');
            this.button.id = IDS.BUTTON;
            this.button.innerHTML = `<span class="btn-symbol">▶</span> ${escapeHTML(t('start_auto_ignore'))}`;
            this.button.addEventListener('click', events.onToggle);

            this.container.appendChild(label);
            this.container.appendChild(this.button);

            if (insertionPoint.parent && !insertionPoint.parent.contains(this.container)) {
                insertionPoint.parent.insertBefore(this.container, insertionPoint.referenceNode);
            }
        }

        unmount() {
            if (this.container) {
                this.container.remove();
                this.container = null;
                this.button = null;
                this.checkbox = null;
            }
        }

        // Briefly show "already running in N tabs" on the Start button when the
        // cross-tab cap refuses a start, then revert to the idle label.
        showRefused(cap) {
            if (!this.button) return;
            clearTimeout(this._refuseTimer);
            this.button.textContent = t('dq_cap_reached', { n: cap });
            this.button.classList.remove('running');
            this.button.classList.add('refused');
            this._refuseTimer = setTimeout(() => {
                if (this.button) { this.button.classList.remove('refused'); this.updateState(false, 0); }
            }, 3500);
        }

        updateState(isRunning, processedCount) {
            if (!this.button) return;
            this.button.classList.remove('refused');
            clearTimeout(this._refuseTimer);

            if (isRunning) {
                this.button.innerHTML = `<span class="btn-symbol">⏹</span> ${escapeHTML(t('stop_with_count', { count: processedCount }))}`;
                this.button.classList.add('running');
            } else {
                this.button.innerHTML = `<span class="btn-symbol">▶</span> ${escapeHTML(t('start_auto_ignore'))}`;
                this.button.classList.remove('running');
            }
        }
    }

    window.ILAP.Discovery.UI = DiscoveryQueueUI;

})();
