(function() {
    'use strict';
    
    /**
     * Strategy to find where to inject the UI in the Steam Modal
     */
    class InsertionStrategy {
        static find(modal) {
            // Look for the "Close" button (X) usually in the top right
            let closeBtnInner = modal.querySelector('div[aria-label="Close"]');
            
            // Fallback for SVG detection
            if (!closeBtnInner) {
                const polygons = modal.querySelectorAll('polygon');
                for(const poly of polygons) {
                    const points = poly.getAttribute('points');
                    if (points && points.startsWith("-74.9,117.2")) {
                        closeBtnInner = poly.closest('div[role="button"]');
                        break;
                    }
                }
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

            // 4. Start DOM Observer
            this.startObserver();
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