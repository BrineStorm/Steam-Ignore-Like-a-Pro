(function() {
    'use strict';
    
    const Logic = window.ILAP.QueueLogic;
    const UI = window.ILAP.QueueUI;

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
                // Steam uses 'Focusable' class wrappers often
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
     * Main Controller
     */
    class QueueController {
        constructor() {
            this.observer = null;
        }

        init() {
            // Bind UI updates from Logic
            Logic.init((isRunning, count) => {
                UI.updateState(isRunning, count);
            });

            this.startObserver();
        }

        startObserver() {
            // Watch body for the Modal appearing
            this.observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    // Check if nodes added
                    if (m.addedNodes.length > 0) {
                        this.checkForDialog();
                    }
                    // Check if nodes removed (to cleanup)
                    if (m.removedNodes.length > 0) {
                        // If dialog is gone, cleanup UI
                        if (!document.querySelector('.FullModalOverlay div[role="dialog"]')) {
                            UI.unmount();
                            Logic.stop(); // Ensure logic stops if user closes modal manually
                        }
                    }
                }
            });

            this.observer.observe(document.body, { childList: true, subtree: true });
            
            // Initial check in case it's already open
            this.checkForDialog();
        }

        checkForDialog() {
            const modal = document.querySelector('.FullModalOverlay div[role="dialog"]');
            if (modal) {
                const insertion = InsertionStrategy.find(modal);
                if (insertion) {
                    UI.mount(insertion, {
                        onStartStop: () => Logic.toggle(),
                        onCheckbox: (val) => Logic.setSkipPositive(val)
                    });
                }
            }
        }
    }

    // Initialize on Load
    window.addEventListener('load', () => {
        new QueueController().init();
    });

})();