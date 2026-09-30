// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';
    
    window.ILAP = window.ILAP || {};
    window.ILAP.Discovery = window.ILAP.Discovery || {};

    const IDS = {
        CONTAINER: 'ilap-queue-controls',
        BUTTON: 'queue-auto-ignore-btn'
    };

    // The panel's ONLY stylesheet. It used to share the job with a block in
    // styles/styles.css, which set some of the same properties to other values
    // and some that were only there — so what the panel looked like was decided
    // by injection order, and neither half could be read on its own.
    class Styles {
        static inject() {
            if (document.getElementById('ilap-queue-styles')) return;
            const style = document.createElement('style');
            style.id = 'ilap-queue-styles';
            style.textContent = `
                /* margin-left:auto parks the panel at the right end of the
                   modal's header row, next to the close button. */
                .ilap-controls-container {
                    display: flex; align-items: center; gap: 10px;
                    margin-left: auto; margin-right: 15px;
                    height: 34px; flex-grow: 0; flex-shrink: 0; font-size: 13px;
                }
                #${IDS.BUTTON} {
                    height: 32px; line-height: 30px; padding: 0 15px; font-size: 14px;
                    border-radius: 2px; cursor: pointer; font-family: "Motiva Sans", Sans-serif;
                    font-weight: normal; box-shadow: 2px 2px 5px rgba(0,0,0,0.2); white-space: nowrap;
                    background-color: #5c7e10; color: #fff; border: 1px solid #4c6b22;
                    display: flex; align-items: center; justify-content: center;
                    transition: background-color 0.2s, transform 0.1s;
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
                    font-family: Arial, sans-serif;
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
                
                /* Scoped: the span lives inside the button and nowhere else, and
                   a bare .btn-symbol on a third-party page is asking for it. */
                #${IDS.BUTTON} .btn-symbol {
                    margin-right: 8px; font-size: 12px; line-height: 1; vertical-align: middle;
                }
                #${IDS.BUTTON}.running .btn-symbol {
                    font-size: 14px; font-weight: bold; animation: ilap-blink-symbol 1.5s infinite;
                }
                @keyframes ilap-blink-symbol {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }
            `;
            document.head.appendChild(style);
        }
    }

    const t = window.ILAP.t;
    const escapeHTML = (s) => (window.ILAP && window.ILAP.Sanitizer) ? window.ILAP.Sanitizer.escapeHTML(s) : String(s);

    class DiscoveryQueueUI {
        constructor() {
            this.container = null;
            this.button = null;
            this.checkbox = null;
            this._refuseTimer = null;
            this._labelText = null;   // the checkbox label's text node, for live relabel
            this._lastRunning = false;
            this._lastCount = 0;
            Styles.inject();
            // Live language switch: re-render the mounted panel's labels in place
            // (the panel otherwise only gets its strings at mount/updateState time).
            if (window.ILAP && window.ILAP.i18n && window.ILAP.i18n.onLangChange) {
                window.ILAP.i18n.onLangChange(() => this._relabel());
            }
        }

        _relabel() {
            if (!this.isMounted()) return;
            if (this._labelText) this._labelText.nodeValue = t('keep_high_score');
            // Re-render the button from the last known state. A transient
            // "cap reached" message reverts early — acceptable for a 3.5 s flash.
            this.updateState(this._lastRunning, this._lastCount);
        }

        // Is the panel on the page right now? isConnected, not truthiness: a
        // stale ref to a container the closed modal took down with it is not a
        // mounted panel. The controller asks before probing the modal for an
        // insertion point, which is the expensive half.
        isMounted() {
            return !!(this.container && this.container.isConnected);
        }

        mount(insertionPoint, events) {
            if (this.isMounted()) return;

            this.container = document.createElement('div');
            this.container.className = 'ilap-controls-container';
            this.container.id = IDS.CONTAINER;

            const label = document.createElement('label');
            label.className = 'ilap-checkbox-label';

            this.checkbox = document.createElement('input');
            this.checkbox.type = 'checkbox';
            this.checkbox.className = 'ilap-checkbox';
            // Real user input only, like every other control this extension puts
            // on a Steam page (curator menu, MI gestures, the popup panel). The
            // panel lives in the page's DOM, so a page script can reach it: a
            // forged click on Start would begin an unattended ignore run, and a
            // forged change here would untick Keep High Score — turning off the
            // filter that decides WHICH games the run ignores. The master switch
            // and the rate gate are checked later, inside the loop, and on an
            // enabled extension with a live session they would let it through.
            const real = (fn) => (e) => { if (e && e.isTrusted) fn(e); };
            this.checkbox.addEventListener('change',
                real((e) => events.onCheckboxChange(e.target.checked)));

            label.appendChild(this.checkbox);
            this._labelText = document.createTextNode(t('keep_high_score'));
            label.appendChild(this._labelText);

            this.button = document.createElement('button');
            this.button.id = IDS.BUTTON;
            this.button.innerHTML = `<span class="btn-symbol">▶</span> ${escapeHTML(t('start_auto_ignore'))}`;
            this.button.addEventListener('click', real(events.onToggle));

            this.container.appendChild(label);
            this.container.appendChild(this.button);

            if (insertionPoint.parent && !insertionPoint.parent.contains(this.container)) {
                insertionPoint.parent.insertBefore(this.container, insertionPoint.referenceNode);
            }
        }

        unmount() {
            clearTimeout(this._refuseTimer);
            this._refuseTimer = null;
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
            this._lastRunning = isRunning;
            this._lastCount = processedCount;
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
