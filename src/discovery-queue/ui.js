// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';
    
    window.ILAP = window.ILAP || {};
    window.ILAP.Discovery = window.ILAP.Discovery || {};

    const IDS = {
        CONTAINER: 'ilap-queue-controls',
        BUTTON: 'queue-auto-ignore-btn'
    };

    // The colour of a lock the user can lift: the sale's queue reward, theirs to earn.
    const LOCK = '#f2c94c';

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
                    position: relative;
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
                /* Start waiting on the sale-reward check (a request or two). */
                #${IDS.BUTTON}.checking { cursor: progress; opacity: .7; }
                /* Refused by the sale-reward check: outlined, and the reason on
                   hover in the tip right after the button, above it. */
                #${IDS.BUTTON}.locked {
                    box-shadow: 0 0 0 2px ${LOCK}, 0 0 12px rgba(242,201,76,.55);
                }
                .ilap-dq-tip {
                    position: absolute; bottom: calc(100% + 8px); right: 0; width: 300px; z-index: 10;
                    background: #171a21; color: #c7d5e0; border: 1px solid ${LOCK}; border-radius: 4px;
                    padding: 8px 12px; font: 12px/1.4 "Motiva Sans", Arial, sans-serif; text-align: left;
                    display: flex; align-items: flex-start; gap: 6px;
                    visibility: hidden; opacity: 0; transition: opacity .15s; pointer-events: none;
                }
                .ilap-dq-tip img { width: 14px; height: 14px; flex-shrink: 0; margin-top: 2px; }
                #${IDS.BUTTON}.locked:hover + .ilap-dq-tip,
                #${IDS.BUTTON}.locked:focus-visible + .ilap-dq-tip { visibility: visible; opacity: 1; }
                
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
        // resources: { getIconUrl(fileName) } (src/utils.js ResourceService)
        constructor(resources) {
            this.resources = resources;
            this.container = null;
            this.button = null;
            this.checkbox = null;
            this._refuseTimer = null;
            this._labelText = null;   // the checkbox label's text node, for live relabel
            this._tipText = null;     // the lock tip's text node, and the key it shows
            this._tipKey = null;
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
            if (this._tipText && this._tipKey) this._tipText.nodeValue = t(this._tipKey);
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
            const real = window.ILAP.realInput;
            this.checkbox.addEventListener('change',
                real((e) => events.onCheckboxChange(e.target.checked)));

            label.appendChild(this.checkbox);
            this._labelText = document.createTextNode(t('keep_high_score'));
            label.appendChild(this._labelText);

            this.button = document.createElement('button');
            this.button.id = IDS.BUTTON;
            this.button.innerHTML = `<span class="btn-symbol">▶</span> ${escapeHTML(t('start_auto_ignore'))}`;
            this.button.addEventListener('click', real(events.onToggle));

            // The sale-reward lock's reason, shown on hover while the button is
            // locked. Right after the button: the stylesheet reveals it with `+`.
            const tip = document.createElement('div');
            tip.className = 'ilap-dq-tip';
            const icon = document.createElement('img');
            icon.src = this.resources.getIconUrl('icon16.png');
            icon.alt = '';
            this._tipText = document.createTextNode('');
            tip.appendChild(icon);
            tip.appendChild(this._tipText);

            this.container.appendChild(label);
            this.container.appendChild(this.button);
            this.container.appendChild(tip);

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
                this._tipText = null;
                this._tipKey = null;
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

        // A Start refused by the sale-reward check (src/sale-reward.js): the
        // button stays outlined in gold and says why on hover — the reward is
        // unearned (`pending`), or its status could not be read. Lifted by
        // clearRewardLock() once a check lets a Start through.
        showRewardRefused(pending) {
            if (!this.button) return;
            this._tipKey = pending ? 'reward_pending' : 'reward_unknown';
            this._tipText.nodeValue = t(this._tipKey);
            this.button.classList.add('locked');
        }

        clearRewardLock() {
            this._tipKey = null;
            if (this.button) this.button.classList.remove('locked');
        }

        // Start is waiting on the sale-reward check: the click has landed.
        setChecking(on) {
            if (this.button) this.button.classList.toggle('checking', on);
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
