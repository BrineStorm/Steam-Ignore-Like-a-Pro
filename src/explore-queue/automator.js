(function() {
    'use strict';

    const { Context, Analyzer, DecisionEngine } = window.ILAP.Explore;

    class ExploreAutomator {
        constructor(storage, ui, api, stats, navGuard, nameExtractor) {
            this.storage = storage;
            this.ui = ui;
            this.api = api;
            this.stats = stats;
            this.nav = navGuard;
            this.nameExtractor = nameExtractor;
            
            this.processedSession = new Set();
            this.nextTimeoutId = null;
            this.storageListener = null;
            this.currentSettings = {}; 
        }

        async run() {
            if (!Context.isQueuePage()) return;
            if (!Context.getNextButton()) return;

            const appid = Context.getAppID();
            if (!appid || this.processedSession.has(appid)) return;

            this.currentSettings = await this.storage.getSettings(['ilap_q_master', 'ilap_q_next', 'ilap_q_mode', 'ilap_master_enabled']);
            this._setupListener();
            
            if (this.currentSettings.ilap_master_enabled === false || this.currentSettings.ilap_q_master === false) return;

            const isAuthorized = this.nav.isAuthorized();
            const intent = this.nav.getUserIntent();

            if ((intent.wantsActive || intent.wantsFF) && !isAuthorized) {
                console.log('[ILAP] Unauthorized navigation. Resetting.');
                this._stopAutomation();
                this._showStartPrompt(); 
                return;
            }

            if (intent.wantsActive && isAuthorized) {
                this._executeLogic(appid);
            } else if (intent.wantsFF && isAuthorized) {
                this._executeFastForward();
            } else {
                this._showStartPrompt();
            }
        }

        _setupListener() {
            if (this.storageListener) return;
            this.storageListener = (changes) => {
                if (changes.ilap_q_mode) {
                    this.currentSettings.ilap_q_mode = changes.ilap_q_mode.newValue;
                    this.ui.updateRunButtonMode(changes.ilap_q_mode.newValue);
                }
                if (changes.ilap_q_next) {
                    this.currentSettings.ilap_q_next = changes.ilap_q_next.newValue;
                }
            };
            this.storage.subscribeToChanges(this.storageListener);
        }

        _stopAutomation() {
            this.nav.resetState();
            clearTimeout(this.nextTimeoutId);
        }

        _showStartPrompt() {
            const currentMode = this.currentSettings.ilap_q_mode || 'bad';
            
            this.ui.showStartPrompt(
                currentMode, 
                {
                    onRun: () => {
                        this.nav.setIntent('ACTIVE');
                        this._executeLogic(Context.getAppID());
                    },
                    onFastForward: () => {
                        this.nav.setIntent('FF');
                        this._executeFastForward();
                    },
                    onDisable: () => {
                        this.storage.updateSettings({ ilap_q_master: false });
                    }
                }
            );
        }

        _executeFastForward() {
            const nextBtn = Context.getNextButton();
            if (nextBtn) {
                this.ui.showRunningToast("Fast Forwarding...", () => this._stopAutomation());
                this._scheduleNextClick(nextBtn, 800);
            }
        }

        async _executeLogic(appid) {
            const mode = this.currentSettings.ilap_q_mode || 'bad';
            const autoNext = !!this.currentSettings.ilap_q_next;
            
            const reviewState = Analyzer.getState();
            
            const decision = DecisionEngine.decide(reviewState, mode);

            if (decision === 'SHOULD_IGNORE') {
                this.processedSession.add(appid);
                await this._performIgnore(appid, autoNext, mode);
            } else {
                this.ui.applyVisuals(reviewState, mode);
                
                // FIX for Bug 1: Only show toast and click if autoNext is TRUE
                if (autoNext) {
                    const nextBtn = Context.getNextButton();
                    if (nextBtn) {
                        this.ui.showRunningToast("Game OK. Moving next...", () => this._stopAutomation());
                        this._scheduleNextClick(nextBtn, 1500);
                    }
                }
            }
        }

        async _performIgnore(appid, shouldNext, mode) {
            const success = await this.api.ignore(appid, 0);
            if (!success) return;

            const name = this.nameExtractor.get(appid);
            this.stats.save(name, "Explore Auto-Queue");
            
            this.ui.applyVisuals('IGNORE', mode);

            const nextBtn = Context.getNextButton();
            
            // FIX for Bug 1: Only show toast and click if shouldNext (autoNext) is TRUE
            if (shouldNext && nextBtn) {
                this.ui.showRunningToast(
                    `<b>${name}</b> ignored. Moving next...`,
                    () => { this._stopAutomation(); }
                );
                this._scheduleNextClick(nextBtn, 2000);
            }
        }

        _scheduleNextClick(buttonElement, delay) {
            this.nav.authorizeNextStep();
            
            this.nextTimeoutId = setTimeout(() => {
                buttonElement.click();
            }, delay);
        }
    }

    window.ILAP.Explore.AutomatorClass = ExploreAutomator;
})();