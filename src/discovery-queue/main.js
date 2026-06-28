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
        }

        init() {
            // 1. Create Adapters (DIP)
            // No direct API calls in Logic class
            const apiAdapter = {
                ignore: (appid, reason) => window.ILAP.apiIgnoreGame(appid, reason) // Using global utils facade for now
            };
            const statsAdapter = {
                save: (name, source) => window.ILAP.saveStats(name, source)
            };
            const nameExtractorAdapter = { get: (appid, el) => window.ILAP.getGameName(appid, el) };

            // 2. Instantiate Components
            const AutomatorClass = window.ILAP.Discovery.Automator;
            const UIClass = window.ILAP.Discovery.UI;

            this.automator = new AutomatorClass(apiAdapter, statsAdapter, nameExtractorAdapter);
            this.ui = new UIClass();

            // 3. Bind UI Updates (Logic -> UI)
            this.automator.setUiObserver((isRunning, count) => {
                this.ui.updateState(isRunning, count);
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
                        onToggle: () => this.automator.toggle(),
                        onCheckboxChange: (val) => this.automator.setSkipPositive(val)
                    });
                }
            }
        }
    }

    // Bootstrap
    window.addEventListener('load', () => {
        new DiscoveryQueueController().init();
    });

})();