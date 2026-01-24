(function() {
    'use strict';

    const { Context, Analyzer } = window.ILAP.Explore;
    const UI = window.ILAP.Explore.UI;

    class ExploreAutomator {
        constructor() {
            this.processedSession = new Set();
            this.nextTimeoutId = null;
            this.storageListener = null;
        }

        async run() {
            if (!Context.isQueuePage()) return;
            
            const appid = Context.getAppID();
            if (!appid || this.processedSession.has(appid)) return;

            // Setup Storage Listener for Real-time UI updates
            if (!this.storageListener) {
                this.storageListener = (changes) => {
                    if (changes.ilap_q_mode) {
                        UI.updateRunButtonMode(changes.ilap_q_mode.newValue);
                    }
                };
                chrome.storage.onChanged.addListener(this.storageListener);
            }

            chrome.storage.local.get(['ilap_q_master', 'ilap_q_next', 'ilap_q_mode', 'ilap_master_enabled'], async (settings) => {
                if (settings.ilap_master_enabled === false || settings.ilap_q_master === false) return;

                const isActive = sessionStorage.getItem('ilap_queue_active') === 'true';
                const isFF = sessionStorage.getItem('ilap_queue_ff') === 'true';
                const currentMode = settings.ilap_q_mode || 'bad';

                if (!isActive && !isFF) {
                    UI.showStartPrompt(
                        currentMode, 
                        {
                            onRun: () => {
                                sessionStorage.setItem('ilap_queue_active', 'true');
                                this._executeLogic(appid, settings);
                            },
                            onFastForward: () => {
                                sessionStorage.setItem('ilap_queue_ff', 'true');
                                this._executeFastForward();
                            },
                            onDisable: () => {
                                chrome.storage.local.set({ ilap_q_master: false });
                            }
                        }
                    );
                } else if (isFF) {
                    this._executeFastForward();
                } else {
                    this._executeLogic(appid, settings);
                }
            });
        }

        _executeFastForward() {
            const nextBtn = Context.getNextButton();
            if (nextBtn) {
                UI.showRunningToast("Fast Forwarding...", () => {
                    clearTimeout(this.nextTimeoutId);
                    sessionStorage.removeItem('ilap_queue_ff');
                });
                this.nextTimeoutId = setTimeout(() => nextBtn.click(), 800);
            }
        }

        async _executeLogic(appid, settings) {
            const mode = settings.ilap_q_mode || 'bad';
            const autoNext = !!settings.ilap_q_next;
            const reviewState = Analyzer.getState();

            let shouldIgnore = false;
            
            // Logic Decision
            if (mode === 'all') {
                shouldIgnore = true;
            } else {
                // Mode: Bad Reviews only
                if (reviewState === 'IGNORE') shouldIgnore = true;
            }

            if (reviewState === 'NO_REVIEWS') {
                shouldIgnore = false;
            }

            if (shouldIgnore) {
                this.processedSession.add(appid);
                await this._performIgnore(appid, autoNext, mode);
            } else {
                // Apply visual feedback for SPARED or NO_REVIEWS
                UI.applyVisuals(reviewState, mode);
            }
        }

        async _performIgnore(appid, shouldNext, mode) {
            const success = await window.ILAP.apiIgnoreGame(appid, 0);
            if (!success) return;

            const name = window.ILAP.getGameName(appid);
            window.ILAP.saveStats(name, "Explore Auto-Queue");
            
            UI.applyVisuals('IGNORE', mode);

            const nextBtn = Context.getNextButton();
            if (shouldNext && nextBtn) {
                UI.showRunningToast(
                    `<b>${name}</b> ignored. Moving next...`,
                    () => {
                        clearTimeout(this.nextTimeoutId);
                        this.nextTimeoutId = null;
                        sessionStorage.removeItem('ilap_queue_active');
                    }
                );
                this.nextTimeoutId = setTimeout(() => nextBtn.click(), 2500);
            }
        }
    }

    window.ILAP.Explore.Automator = new ExploreAutomator();
})();