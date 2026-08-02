// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';
    
    /**
     * Strategy to find where to inject the UI in the Steam Modal
     */
    class InsertionStrategy {
        static find(modal) {
            // The X-icon vector shape is language-independent, so match it FIRST.
            // aria-label="Close" is localized by Steam's UI language, so it serves
            // only as a fallback (and is matched case-insensitively).
            let closeBtnInner = null;
            const polygons = modal.querySelectorAll('polygon');
            for(const poly of polygons) {
                const points = poly.getAttribute('points');
                if (points && points.startsWith("-74.9,117.2")) {
                    closeBtnInner = poly.closest('div[role="button"]');
                    break;
                }
            }

            // Fallback: localized close button by aria-label.
            if (!closeBtnInner) {
                closeBtnInner = modal.querySelector('div[aria-label="Close" i]');
            }

            if (closeBtnInner) {
                const wrapper = closeBtnInner.parentElement;
                if (wrapper && wrapper.classList.contains('Focusable')) {
                    return {
                        parent: wrapper.parentElement, 
                        referenceNode: wrapper         
                    };
                }
            }
            return null;
        }
    }

    /**
     * Main Controller.
     * Orchestrates the initialization and binding of components.
     */
    class DiscoveryQueueController {
        constructor() {
            this.automator = null;
            this.ui = null;
            this.observer = null;
            // Default to enabled to match popup's default and avoid a flicker
            // where the panel briefly mounts before the storage read returns.
            // init() awaits the read before starting the observer, so this
            // value is only consulted once it has been refreshed.
            this.masterEnabled = true;
            // Identity + heartbeat handle for this tab's slot in the cross-tab
            // DQ-automator registry (caps how many DQ loops run per profile).
            this.ownerId = window.ILAP.newOwnerId('dq_');
            this._beat = null;
            this.registry = null;      // bound in init(), like the other adapters
            this._starting = false;    // latch: a registry acquire is in flight
        }

        init() {
            // 1. Create Adapters (DIP)
            // No direct API calls in Logic class
            const apiAdapter = {
                ignore: (appid, reason) => window.ILAP.apiIgnoreGame(appid, reason) // Using global utils facade for now
            };
            const statsAdapter = {
                // Stats + the undo log ride one adapter call (appid → ilap_ignore_log).
                // The log is optional, same stance as the drainer's log hooks: a
                // partial build must degrade to stats-only, not throw mid-ignore.
                save: (name, source, appid) => {
                    window.ILAP.saveStats(name, source);
                    if (window.ILAP.IgnoreLog) window.ILAP.IgnoreLog.append({ appid, name, source: 'dq' });
                }
            };
            const nameExtractorAdapter = { get: (appid, el) => window.ILAP.getGameName(appid, el) };
            // DQ is a visible source: it never yields to the background and marks foreground activity.
            const gateAdapter = { reserve: () => window.ILAP.IgnoreGate.reserve({ foreground: true }) };
            this.registry = window.ILAP.Discovery.Registry;

            // 2. Instantiate Components
            const AutomatorClass = window.ILAP.Discovery.Automator;
            const UIClass = window.ILAP.Discovery.UI;

            this.automator = new AutomatorClass(apiAdapter, statsAdapter, nameExtractorAdapter, gateAdapter);
            this.ui = new UIClass();

            // 3. Bind UI Updates (Logic -> UI). When the loop stops (Stop click,
            //    queue done, or a master-off teardown), free this tab's registry
            //    slot and stop the heartbeat so another tab can start.
            this.automator.setUiObserver((isRunning, count) => {
                this.ui.updateState(isRunning, count);
                if (!isRunning) this._releaseSlot();
            });

            // 4. Resolve the master flag before observing so the very first
            //    modal we see is gated correctly. Subsequent flips are handled
            //    by the storage.onChanged listener below.
            chrome.storage.local.get('ilap_q_master', (res) => {
                this.masterEnabled = res.ilap_q_master !== false;
                this._subscribeMasterChanges();
                this.startObserver();
            });
        }

        // Start/stop the loop, gated by the cross-tab DQ-automator cap. Stopping
        // needs no registry check; starting claims a slot first and refuses (with
        // a transient button message) when other tabs already fill the cap. The
        // _starting latch swallows clicks landing while the acquire is in flight
        // (isRunning is still false then, so they'd read as a second Start).
        async _toggle() {
            if (this._starting) return;
            if (this.automator.isRunning) {
                this.automator.stop();     // the UI observer frees the slot
                return;
            }
            this._starting = true;
            try {
                const ok = await this.registry.tryAcquire(this.ownerId);
                if (!ok) { this.ui.showRefused(this.registry.CAP); return; }
                this._startHeartbeat();
                this.automator.start();    // observer tracks running; frees on stop
            } finally {
                this._starting = false;
            }
        }

        _startHeartbeat() {
            this._stopHeartbeat();
            this._beat = setInterval(() => this.registry.renew(this.ownerId), this.registry.HEARTBEAT_MS);
        }

        _stopHeartbeat() {
            if (this._beat) { clearInterval(this._beat); this._beat = null; }
        }

        _releaseSlot() {
            this._stopHeartbeat();
            this.registry.release(this.ownerId);
        }

        _subscribeMasterChanges() {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local' || !changes.ilap_q_master) return;
                this.masterEnabled = changes.ilap_q_master.newValue !== false;
                // If the user disabled the queue while the panel was already
                // mounted, retract it and stop any in-flight loop.
                if (!this.masterEnabled) {
                    this.ui.unmount();
                    this.automator.stop();
                }
            });
        }

        startObserver() {
            this.observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.addedNodes.length > 0) this.checkForDialog();
                    if (m.removedNodes.length > 0) {
                        // If dialog is gone, cleanup UI and stop logic
                        if (!document.querySelector('.FullModalOverlay div[role="dialog"]')) {
                            this.ui.unmount();
                            this.automator.stop();
                        }
                    }
                }
            });

            this.observer.observe(document.body, { childList: true, subtree: true });
            this.checkForDialog();
        }

        checkForDialog() {
            if (!this.masterEnabled) return;
            const modal = document.querySelector('.FullModalOverlay div[role="dialog"]');
            if (modal) {
                const insertion = InsertionStrategy.find(modal);
                if (insertion) {
                    // Bind User Events (UI -> Logic)
                    this.ui.mount(insertion, {
                        onToggle: () => this._toggle(),
                        onCheckboxChange: (val) => this.automator.setSkipPositive(val)
                    });
                }
            }
        }
    }

    // Bootstrap. See the readyState note in src/manual-ignore/main.js: on Firefox
    // the content script can be injected after window.onload has already fired,
    // and a bare 'load' listener would then never run at all.
    const boot = () => { new DiscoveryQueueController().init(); };
    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot);

})();