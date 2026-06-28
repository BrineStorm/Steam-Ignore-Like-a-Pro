// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    const TIMING = {
        FAST_FORWARD_DELAY_MS: 800,   // delay before auto-clicking Next while fast-forwarding
        IGNORE_ADVANCE_DELAY_MS: 2000 // delay before auto-clicking Next after an ignore
    };

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

            this._bindManualNextButton(nextBtn);

            const appid = this.context.getAppID();
            if (!appid || this.processedSession.has(appid)) return;

            this.currentSettings = await this.settings.getSettings(['ilap_q_master', 'ilap_q_next', 'ilap_q_mode', 'ilap_master_enabled']);
            this._setupListener();
            
            if (this.currentSettings.ilap_master_enabled === false || this.currentSettings.ilap_q_master === false) return;

            const wasAuthorized = this.nav.consumeAuthorization();
            const intent = this.nav.getUserIntent();

            if (intent.wantsActive || intent.wantsFF) {
                // A reload of the same queue page is legitimate even without a nav token.
                const isSamePageReload = appid === this.nav.getActiveAppid();

                if (!wasAuthorized && !isSamePageReload) {
                    console.log('[ILAP] Unauthorized manual navigation detected. Resetting automation.');
                    this._stopAutomation();
                    this._showStartPrompt();
                    return;
                }

                this.nav.setActiveAppid(appid);

                if (intent.wantsActive) {
                    this._executeLogic(appid);
                } else {
                    this._executeFastForward();
                }
            } else {
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
                        const currentAppid = this.context.getAppID();
                        this.nav.setIntent('ACTIVE', currentAppid);
                        this.ui.clearStartPrompt(); // DIP: Delegated to UI
                        this._executeLogic(currentAppid);
                    },
                    onFastForward: () => {
                        const currentAppid = this.context.getAppID();
                        this.nav.setIntent('FF', currentAppid);
                        this.ui.clearStartPrompt(); // DIP: Delegated to UI
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
                this.ui.showFastForwardToast(() => this._stopAutomation());
                this._scheduleNextClick(nextBtn, TIMING.FAST_FORWARD_DELAY_MS);
            }
        }

        async _executeLogic(appid) {
            const mode = this.currentSettings.ilap_q_mode || 'bad';
            const autoNext = !!this.currentSettings.ilap_q_next;
            
            const reviewState = this.analyzer.getState();
            const decision = this.decisionEngine.decide(reviewState, mode);

            // Ensure start prompt is cleared if logic executes via navigation token
            this.ui.clearStartPrompt();

            if (decision === 'SHOULD_IGNORE') {
                this.processedSession.add(appid);
                await this._performIgnore(appid, autoNext, mode);
            } else {
                // Game is SPARED. 
                // Apply visual badge and STOP. Do not show start prompt. Do not auto-next.
                // Automation remains "ACTIVE" in background waiting for manual next click.
                this.ui.applyVisuals(reviewState, mode);
            }
        }

        async _performIgnore(appid, shouldNext, mode) {
            const success = await this.api.ignore(appid, 0);
            if (!success) return;

            const gameContainer = this.context.getGameContainer();
            const name = this.nameExtractor.get(appid, gameContainer);
            
            this.stats.save(name, "Explore Auto-Queue");
            
            this.ui.applyVisuals('IGNORE', mode);

            const nextBtn = this.context.getNextButton();

            if (shouldNext && nextBtn) {
                this.ui.showIgnoredToast(name, () => { this._stopAutomation(); });
                this._scheduleNextClick(nextBtn, TIMING.IGNORE_ADVANCE_DELAY_MS);
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