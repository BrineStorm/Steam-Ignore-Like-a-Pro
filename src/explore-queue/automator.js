// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    const TIMING = {
        FAST_FORWARD_DELAY_MS: 800,   // delay before auto-clicking Next while fast-forwarding
        IGNORE_ADVANCE_DELAY_MS: 2000 // delay before auto-clicking Next after an ignore
    };

    class ExploreAutomator {
        constructor(deps) {
            const need = (adapter, fns, what) => {
                if (!adapter || !fns.every(fn => typeof adapter[fn] === 'function')) {
                    throw new TypeError(`[ILAP] ExploreAutomator needs deps.${what}`);
                }
            };
            need(deps.api, ['ignore'], 'api');
            need(deps.stats, ['save'], 'stats');                  // save(name, appid)
            need(deps.nameExtractor, ['get'], 'nameExtractor');
            need(deps.gate, ['reserve', 'reportRateLimited'], 'gate');
            need(deps.settings, ['read', 'subscribe', 'disableQueue'], 'settings');
            need(deps.ui, ['applyVisuals', 'clearStartPrompt', 'clearVisuals', 'removeToast',
                'showFastForwardToast', 'showIgnoredToast', 'showStartPrompt', 'updateRunButtonMode'], 'ui');
            need(deps.navGuard, ['authorizeNextStep', 'consumeAuthorization', 'getActiveAppid',
                'getUserIntent', 'resetState', 'setActiveAppid', 'setIntent'], 'navGuard');
            need(deps.context, ['getAppID', 'getGameContainer', 'getNextButton', 'isQueuePage'], 'context');
            need(deps.analyzer, ['getState'], 'analyzer');
            need(deps.decisionEngine, ['decide'], 'decisionEngine');

            this.settings = deps.settings;   // explore-queue/utils.js QueueSettings
            this.ui = deps.ui;
            this.api = deps.api;
            this.gate = deps.gate;
            this.stats = deps.stats;
            this.nav = deps.navGuard;
            this.nameExtractor = deps.nameExtractor;
            this.context = deps.context;
            this.analyzer = deps.analyzer;
            this.decisionEngine = deps.decisionEngine;
            
            this.processedSession = new Set();
            this.nextTimeoutId = null;
            // Bumped by every stop, so an ignore waiting on the gate can tell it
            // was stopped meanwhile.
            this._stops = 0;
            this._inFlight = null;
            this._runAfterFlight = false;
            // Sticky: set once the GLOBAL master is seen off on this page, which
            // counts as leaving it — from then on nothing revives the page in place.
            // Never cleared: an EQ advance is a full reload, so the next queue page
            // is a new automator anyway.
            this._leftByMaster = false;
            this.settingsListener = null;
            this.currentSettings = {};
        }

        // The fire-and-forget entry point, like the drainer's kick(): nothing
        // awaits a pass — not the boot call, the URL poller, a master flip or a
        // re-run after a flight — so a rejected storage read would surface as an
        // unhandled rejection. In practice that is an extension update, which
        // leaves this page's script running with no storage behind it and no
        // pass worth retrying. `run()` stays awaitable for the unit specs.
        kick() {
            this.run().catch((e) => console.warn('[ILAP] EQ pass failed:', e));
        }

        async run() {
            if (!this.context.isQueuePage()) return;
            
            const nextBtn = this.context.getNextButton();
            if (!nextBtn) return;

            this._bindManualNextButton(nextBtn);

            const appid = this.context.getAppID();
            if (!appid) return;
            // Re-entered while this game's ignore is in flight (a revive): run
            // again once it settles, since a stopped ignore un-marks the game.
            if (this._inFlight === appid) {
                this._runAfterFlight = true;
                return;
            }
            if (this.processedSession.has(appid)) return;

            this.currentSettings = await this.settings.read();
            this._setupListener();

            if (!this.currentSettings.globalOn || !this.currentSettings.queueOn) return;

            const wasAuthorized = this.nav.consumeAuthorization();
            const intent = this.nav.getUserIntent();

            if (intent.wantsActive || intent.wantsFF) {
                // A reload of the same queue page is legitimate even without a nav token.
                const isSamePageReload = appid === this.nav.getActiveAppid();

                if (!wasAuthorized && !isSamePageReload) {
                    console.warn('[ILAP] Unauthorized manual navigation detected. Resetting automation.');
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
            this.settingsListener = (change) => {
                if (change.mode !== undefined) {
                    this.currentSettings.mode = change.mode;
                    this.ui.updateRunButtonMode(change.mode);
                }
                if (change.autoNext !== undefined) {
                    this.currentSettings.autoNext = change.autoNext;
                }
                if (change.queueOn || change.globalOn) {
                    this._handleMasterChange(change);
                }
            };
            this.settings.subscribe(this.settingsListener);
        }

        // React live when the queue/global master is toggled elsewhere (widget or
        // popup). Either switch off stops automation and takes the toast. Only the
        // GLOBAL one also strips the card's outline and badge and leaves the page for
        // good; the queue toggle pauses in place, verdict still drawn, and resumes.
        _handleMasterChange(change) {
            const globalWasOff = !this.currentSettings.globalOn;
            if (change.queueOn) this.currentSettings.queueOn = change.queueOn.now;
            if (change.globalOn) this.currentSettings.globalOn = change.globalOn.now;
            const globalOff = !this.currentSettings.globalOn;
            // Off before this write (an earlier write, or already at boot) or off now.
            if (globalWasOff || globalOff) this._leftByMaster = true;

            if (globalOff || !this.currentSettings.queueOn) {
                this._stopAutomation();
                this.ui.removeToast();
                if (globalOff) this.ui.clearVisuals();
                return;
            }
            // Re-enabled. Only the queue toggle's own false→on TRANSITION revives in
            // place (onChanged also fires for same-value writes, and run() is not a
            // no-op mid-flight), and only on a page the global master never left.
            const queueReturned = change.queueOn && !change.queueOn.was;
            if (queueReturned && !this._leftByMaster) this.kick();
        }

        _stopAutomation() {
            this._stops++;
            this.nav.resetState();
            clearTimeout(this.nextTimeoutId);
        }

        _showStartPrompt() {
            const currentMode = this.currentSettings.mode;

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
                        this.settings.disableQueue();
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
            const mode = this.currentSettings.mode;
            const autoNext = this.currentSettings.autoNext;
            
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
                this._inFlight = appid;
                // Nothing awaits this (run() and the Run button fire it), and a
                // throw that skipped the reset below would leave the latch set:
                // every later run() on this page would stop at it. A throw counts
                // as not landed, so the game stays retryable.
                let ignored = false;
                try {
                    ignored = await this._performIgnore(appid, autoNext, mode);
                } catch (e) {
                    console.warn('[ILAP] EQ ignore failed:', e);
                }
                this._inFlight = null;
                if (!ignored) this.processedSession.delete(appid);
                const rerun = this._runAfterFlight;
                this._runAfterFlight = false;
                if (rerun && !ignored) this.kick();
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
            // Paced through the shared gate. A stop verdict tears the automation
            // down rather than leaving a "running" toast over a silent no-op.
            const stops = this._stops;
            const slot = await this.gate.reserve();
            if (!slot.ok) {
                this._stopAutomation();
                this.ui.removeToast();
                return false;
            }
            // The gate checks only the global master, and the wait can be minutes
            // under a 429 penalty: Stop or the queue toggle may have come meanwhile.
            if (stops !== this._stops) return false;
            const res = await this.api.ignore(appid, 0);
            if (!res || !res.ok) {
                // A 429 throttles the account: back every source off.
                if (res && res.rateLimited) {
                    await this.gate.reportRateLimited(res.retryAfterMs);
                }
                return false;
            }

            const gameContainer = this.context.getGameContainer();
            const name = this.nameExtractor.get(appid, gameContainer);
            
            this.stats.save(name, appid);

            // A stop during the POST: the ignore stands, the advance does not. So
            // does the mark, unless the global master took the page's marks away.
            const stopped = stops !== this._stops;
            if (!stopped || this.currentSettings.globalOn) this.ui.applyVisuals('IGNORE', mode);
            if (stopped) return true;

            const nextBtn = this.context.getNextButton();

            if (shouldNext && nextBtn) {
                this.ui.showIgnoredToast(name, () => { this._stopAutomation(); });
                this._scheduleNextClick(nextBtn, TIMING.IGNORE_ADVANCE_DELAY_MS);
            }
            return true;
        }

        _scheduleNextClick(buttonElement, delay) {
            // ONE pending advance at a time, so _stopAutomation's clearTimeout
            // always cancels it. Only same-document re-entry (_handleMasterChange
            // → run()) could stack two; an EQ advance is a full page load.
            clearTimeout(this.nextTimeoutId);
            this.nav.authorizeNextStep();

            this.nextTimeoutId = setTimeout(() => {
                buttonElement.click();
            }, delay);
        }
    }

    window.ILAP.Explore.AutomatorClass = ExploreAutomator;
})();