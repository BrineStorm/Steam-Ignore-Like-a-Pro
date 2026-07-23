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
            // Gate is optional, but if supplied it must be a valid adapter (the
            // project's construction-time duck-typing contract).
            if (deps.gate && typeof deps.gate.reserve !== 'function') throw new TypeError("[ILAP] Invalid GateAdapter provided");

            this.settings = deps.settings;
            this.ui = deps.ui;
            this.api = deps.api;
            this.gate = deps.gate;   // { reserve() } — aggregate rate governor (optional)
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
                if (changes.ilap_q_master || changes.ilap_master_enabled) {
                    this._handleMasterChange(changes);
                }
            };
            this.settings.subscribeToChanges(this.settingsListener);
        }

        // React live when the queue/global master is toggled elsewhere (widget or
        // popup): turning it off must tear down any Queue-Helper toast and stop
        // automation; turning it back on re-shows the start prompt.
        _handleMasterChange(changes) {
            if (changes.ilap_q_master) this.currentSettings.ilap_q_master = changes.ilap_q_master.newValue;
            if (changes.ilap_master_enabled) this.currentSettings.ilap_master_enabled = changes.ilap_master_enabled.newValue;

            const disabled = this.currentSettings.ilap_q_master === false
                || this.currentSettings.ilap_master_enabled === false;

            if (disabled) {
                this._stopAutomation();
                this.ui.removeToast();
            } else {
                this.run();
            }
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
                        this.ui.clearStartPrompt();
                        this._executeLogic(currentAppid);
                    },
                    onFastForward: () => {
                        const currentAppid = this.context.getAppID();
                        this.nav.setIntent('FF', currentAppid);
                        this.ui.clearStartPrompt();
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
                // Pre-mark to keep the in-flight re-entrancy dedupe (run() skips
                // a marked appid), but un-mark when the ignore did NOT land
                // (gate stop / failed POST) — otherwise the game is silently
                // skipped for the rest of the session after a re-enable.
                this.processedSession.add(appid);
                const ignored = await this._performIgnore(appid, autoNext, mode);
                if (!ignored) this.processedSession.delete(appid);
            } else {
                // Game is SPARED. 
                // Apply visual badge and STOP. Do not show start prompt. Do not auto-next.
                // Automation remains "ACTIVE" in background waiting for manual next click.
                this.ui.applyVisuals(reviewState, mode);
            }
        }

        // Resolves true only when the ignore actually landed — the caller keeps
        // the appid session-marked on true and un-marks it on false.
        async _performIgnore(appid, shouldNext, mode) {
            // Reserve an aggregate rate slot first (paces EQ against the drainer
            // and any DQ tabs). A stop verdict (master off / dead session) tears
            // the automation down instead of leaving a zombie "running" toast
            // behind a silent no-op.
            if (this.gate) {
                const slot = await this.gate.reserve();
                if (!slot.ok) {
                    this._stopAutomation();
                    this.ui.removeToast();
                    return false;
                }
            }
            const res = await this.api.ignore(appid, 0);
            if (!res || !res.ok) {
                // A 429 is account-level throttling: escalate the shared gate
                // penalty so the drainer and every other tab go quiet too.
                if (res && res.rateLimited && this.gate && this.gate.reportRateLimited) {
                    await this.gate.reportRateLimited(res.retryAfterMs);
                }
                return false;
            }

            const gameContainer = this.context.getGameContainer();
            const name = this.nameExtractor.get(appid, gameContainer);
            
            this.stats.save(name, "Explore Auto-Queue", appid);
            
            this.ui.applyVisuals('IGNORE', mode);

            const nextBtn = this.context.getNextButton();

            if (shouldNext && nextBtn) {
                this.ui.showIgnoredToast(name, () => { this._stopAutomation(); });
                this._scheduleNextClick(nextBtn, TIMING.IGNORE_ADVANCE_DELAY_MS);
            }
            return true;
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