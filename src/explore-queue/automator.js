(function() {
    'use strict';

    class ExploreAutomator {
        constructor(deps) {
            if (!deps.api || typeof deps.api.ignore !== 'function') throw new TypeError("[ILAP] Invalid ApiAdapter provided");
            if (!deps.stats || typeof deps.stats.save !== 'function') throw new TypeError("[ILAP] Invalid StatsAdapter provided");
            if (!deps.nameExtractor || typeof deps.nameExtractor.get !== 'function') throw new TypeError("[ILAP] Invalid NameExtractorAdapter provided");
            
            this.settings = deps.settings;
            this.ui = deps.ui;
            this.api = deps.api;
            this.stats = deps.stats;
            this.nav = deps.navGuard;
            this.nameExtractor = deps.nameExtractor;
            this.context = deps.context;
            this.analyzer = deps.analyzer;
            this.decisionEngine = deps.decisionEngine;
            
            this.processedSession = new Set();
            this.nextTimeoutId = null;
            this.settingsListener = null;
            this.currentSettings = {}; 
        }

        async run() {
            if (!this.context.isQueuePage()) return;
            
            const nextBtn = this.context.getNextButton();
            if (!nextBtn) return;

            // Grant a token when the user manually clicks "Next", 
            // so automation can seamlessly resume on the next page.
            this._bindManualNextButton(nextBtn);

            const appid = this.context.getAppID();
            if (!appid || this.processedSession.has(appid)) return;

            this.currentSettings = await this.settings.getSettings(['ilap_q_master', 'ilap_q_next', 'ilap_q_mode', 'ilap_master_enabled']);
            this._setupListener();
            
            if (this.currentSettings.ilap_master_enabled === false || this.currentSettings.ilap_q_master === false) return;

            const isAuthorized = this.nav.isAuthorized();
            const intent = this.nav.getUserIntent();

            if ((intent.wantsActive || intent.wantsFF) && !isAuthorized) {
                console.log('[ILAP] Unauthorized manual navigation detected. Resetting automation.');
                this._stopAutomation();
                this._showStartPrompt(); 
                return;
            }

            // If automation is actively running from a previous page
            if (intent.wantsActive && isAuthorized) {
                this._executeLogic(appid);
            } else if (intent.wantsFF && isAuthorized) {
                this._executeFastForward();
            } else {
                // First time arriving on the page manually, show the prompt
                this._showStartPrompt();
            }
        }

        _bindManualNextButton(nextBtn) {
            if (nextBtn.dataset.ilapBound) return;
            nextBtn.dataset.ilapBound = 'true';
            
            nextBtn.addEventListener('click', () => {
                const intent = this.nav.getUserIntent();
                if (intent.wantsActive || intent.wantsFF) {
                    this.nav.authorizeNextStep();
                }
            });
        }

        _setupListener() {
            if (this.settingsListener) return;
            this.settingsListener = (changes) => {
                if (changes.ilap_q_mode) {
                    this.currentSettings.ilap_q_mode = changes.ilap_q_mode.newValue;
                    this.ui.updateRunButtonMode(changes.ilap_q_mode.newValue);
                }
                if (changes.ilap_q_next) {
                    this.currentSettings.ilap_q_next = changes.ilap_q_next.newValue;
                }
            };
            this.settings.subscribeToChanges(this.settingsListener);
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
                        this._executeLogic(this.context.getAppID());
                    },
                    onFastForward: () => {
                        this.nav.setIntent('FF');
                        this._executeFastForward();
                    },
                    onDisable: () => {
                        this.settings.updateSettings({ ilap_q_master: false });
                    }
                }
            );
        }

        _executeFastForward() {
            const nextBtn = this.context.getNextButton();
            if (nextBtn) {
                this.ui.showRunningToast("Fast Forwarding...", () => this._stopAutomation());
                this._scheduleNextClick(nextBtn, 800);
            }
        }

        async _executeLogic(appid) {
            const mode = this.currentSettings.ilap_q_mode || 'bad';
            const autoNext = !!this.currentSettings.ilap_q_next;
            
            const reviewState = this.analyzer.getState();
            const decision = this.decisionEngine.decide(reviewState, mode);

            // Removing the start prompt if it exists (in case user just clicked "Run" on this page)
            const prompt = document.getElementById('ilap-toast');
            if (prompt && !prompt.querySelector('#ilap-stop-btn')) {
                prompt.remove();
            }

            if (decision === 'SHOULD_IGNORE') {
                this.processedSession.add(appid);
                await this._performIgnore(appid, autoNext, mode);
            } else {
                // Game is SPARED. 
                // We apply visuals (Blue border) but DO NOT auto-next and DO NOT show toasts.
                // The user must manually review and click the "Next" button.
                this.ui.applyVisuals(reviewState, mode);
            }
        }

        async _performIgnore(appid, shouldNext, mode) {
            const success = await this.api.ignore(appid, 0);
            if (!success) return;

            const name = this.nameExtractor.get(appid);
            this.stats.save(name, "Explore Auto-Queue");
            
            this.ui.applyVisuals('IGNORE', mode);

            const nextBtn = this.context.getNextButton();
            
            if (shouldNext && nextBtn) {
                // Auto-next is ON: Show toast and skip
                this.ui.showRunningToast(
                    `<b>${name}</b> ignored. Moving next...`,
                    () => { this._stopAutomation(); }
                );
                this._scheduleNextClick(nextBtn, 2000);
            } else {
                // Auto-next is OFF: Just apply the ignore badge and stop.
                // User will click next manually.
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