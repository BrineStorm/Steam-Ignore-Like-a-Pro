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
        // Every collaborator comes in through deps; boot() below is the one place
        // they are assembled.
        //   automator          Discovery.Automator — the slide loop
        //   ui                 Discovery.UI — the panel (isMounted() gates the probe)
        //   registry           Discovery.Registry — cross-tab DQ-automator cap (lease)
        //   insertionStrategy  { find(modal) → { parent, referenceNode } | null }
        //   masterSwitch       { watch({ onInit, onChange }) } (src/master-switch.js)
        //   reward             { check({ fresh }) → a STATUS value, STATUS } (src/sale-reward.js)
        //   notice             { confirmOnce() → Promise<boolean> } (src/automation-notice.js)
        //   ownerId            this tab's identity in the registry
        constructor(deps) {
            this.automator = deps.automator;
            this.ui = deps.ui;
            this.registry = deps.registry;
            this.insertion = deps.insertionStrategy;
            this.masterSwitch = deps.masterSwitch;
            // The two that guard Start are checked up front, as the Classic
            // Discovery Queue automator checks them: a fake without STATUS
            // would otherwise fail only at the first click.
            if (!deps.reward || typeof deps.reward.check !== 'function'
                || !deps.reward.STATUS || !deps.reward.STATUS.ALLOWED || !deps.reward.STATUS.PENDING) {
                throw new TypeError('[ILAP] DiscoveryQueueController needs deps.reward');
            }
            if (!deps.notice || typeof deps.notice.confirmOnce !== 'function') {
                throw new TypeError('[ILAP] DiscoveryQueueController needs deps.notice');
            }
            this.reward = deps.reward;
            this.notice = deps.notice;
            this.ownerId = deps.ownerId;
            this.observer = null;
            // Default to enabled to match popup's default and avoid a flicker
            // where the panel briefly mounts before the storage read returns.
            // init() awaits the read before starting the observer, so this
            // value is only consulted once it has been refreshed.
            this.masterEnabled = true;
            this._beat = null;         // heartbeat for this tab's registry slot
            this._starting = false;    // latch: a registry acquire is in flight
        }

        init() {
            // 1. Bind UI Updates (Logic -> UI). When the loop stops (Stop click,
            //    queue done, or a master-off teardown), free this tab's registry
            //    slot and stop the heartbeat so another tab can start.
            this.automator.setUiObserver((isRunning, count) => {
                this.ui.updateState(isRunning, count);
                if (!isRunning) this._releaseSlot();
                // A run the sale-reward check ended mid-way says why, as a
                // refused Start does.
                if (!isRunning && this.automator.refusal) {
                    this.ui.showRewardRefused(this.automator.refusal === this.reward.STATUS.PENDING);
                }
            });

            // 2. Resolve the master flag before observing so the very first
            //    modal we see is gated correctly; later flips go to
            //    _onMasterChange. Only the GLOBAL master: `ilap_q_master` is the
            //    Classic Discovery Queue's own switch and does not gate this panel
            //    (a Start nobody presses does nothing).
            this.masterSwitch.watch({
                onInit: (on) => { this.masterEnabled = on; this.startObserver(); },
                onChange: (on) => { this.masterEnabled = on; this._onMasterChange(); },
            });
        }

        // Start/stop the loop. Stopping needs no check. Starting asks, in order:
        // the sale reward (the loop advances the queue, and an unearned sale
        // reward is the user's to earn by hand), the one-time automation notice,
        // and the cross-tab DQ-automator cap, which refuses with a transient
        // button message when other tabs already fill it. The _starting latch
        // swallows clicks landing meanwhile (isRunning is still false then, so
        // they'd read as a second Start).
        async _toggle() {
            if (this._starting) return;
            if (this.automator.isRunning) {
                this.automator.stop();     // the UI observer frees the slot
                return;
            }
            this._starting = true;
            try {
                // A click: a queue the user has just finished by hand counts now.
                this.ui.setChecking(true);
                const STATUS = this.reward.STATUS;
                // A check that throws reads as unreadable, as it does in the loop
                // and in the Classic Discovery Queue: refused, and the panel says so.
                const reward = await this.reward.check({ fresh: true })
                    .catch(() => STATUS.UNKNOWN)
                    .finally(() => this.ui.setChecking(false));
                if (reward !== STATUS.ALLOWED) { this.ui.showRewardRefused(reward === STATUS.PENDING); return; }
                // Let through: whatever stops this Start below, the lock is over.
                this.ui.clearRewardLock();
                if (!(await this.notice.confirmOnce())) return;
                // Both waits can be long (a request, a dialog): the master switch
                // or the modal may have gone meanwhile, and the loop's
                // Keep-High-Score skips take no gate slot that would stop it.
                if (!this.masterEnabled || !this.ui.isMounted()) return;
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

        // Take the panel off the page and stop the loop behind it. Keep High Score
        // is reset too: `ui.mount` draws a fresh, unticked checkbox, and the
        // automator's config must not disagree with it.
        _teardown() {
            this.ui.unmount();
            this.automator.stop();
            this.automator.setSkipPositive(false);
        }

        _onMasterChange() {
            // Disabled live: retract the panel and stop the loop, including
            // the clicks that need no rate slot (Keep-High-Score skips, "Continue").
            if (!this.masterEnabled) {
                this._teardown();
                return;
            }
            // Re-enabled with the modal still open: re-mount on idle Start.
            this.checkForDialog();
        }

        startObserver() {
            this.observer = new MutationObserver((mutations) => {
                // Once per BATCH, not once per record. Steam's React modal
                // delivers hundreds of records per re-render — and the loop
                // itself causes them, since every automator click re-renders the
                // carousel — so a per-record probe ran the modal scan hundreds of
                // times for one visual change.
                let added = false;
                let removed = false;
                for (const m of mutations) {
                    if (m.addedNodes.length > 0) added = true;
                    if (m.removedNodes.length > 0) removed = true;
                    if (added && removed) break;
                }
                if (added) this.checkForDialog();
                // If dialog is gone, cleanup UI and stop logic
                if (removed && !document.querySelector('.FullModalOverlay div[role="dialog"]')) {
                    this._teardown();
                }
            });

            this.observer.observe(document.body, { childList: true, subtree: true });
            this.checkForDialog();
        }

        checkForDialog() {
            if (!this.masterEnabled) return;
            // Already on screen: there is nothing to insert, and finding where
            // to insert it means walking every <polygon> in the modal
            // (InsertionStrategy). mount() would no-op on it anyway.
            if (this.ui.isMounted()) return;
            const modal = document.querySelector('.FullModalOverlay div[role="dialog"]');
            if (modal) {
                const insertion = this.insertion.find(modal);
                if (insertion) {
                    // Bind User Events (UI -> Logic)
                    this.ui.mount(insertion, {
                        // Nothing awaits a click handler: a rejection (storage
                        // gone after an extension update) stops here.
                        onToggle: () => { this._toggle().catch((e) => console.warn('[ILAP] DQ start failed:', e)); },
                        onCheckboxChange: (val) => this.automator.setSkipPositive(val)
                    });
                }
            }
        }
    }

    // Exported for the Node unit suite only; the bootstrap below is the one construction site.
    window.ILAP.Discovery.Controller = DiscoveryQueueController;

    // Bootstrap. See the readyState note in src/manual-ignore/main.js: on Firefox
    // the content script can be injected after window.onload has already fired,
    // and a bare 'load' listener would then never run at all.
    const boot = () => {
        const I = window.ILAP;
        // Adapters (DIP): the automator never calls the global facade itself.
        // Lenient read: a transient failure is an empty Set, one spent attempt.
        const userdataAdapter = { fetchIgnored: () => I.fetchIgnoredApps() };
        // Stats and the undo log ride one adapter call. Nothing awaits either:
        // saveStats swallows its own rejection, and the log append needs its own
        // catch for the same reason (serialChain hands the CALLER its rejection).
        // What rejects in practice is an extension update — this page's script
        // keeps running with no storage behind it — and one unhandled rejection
        // per ignore is all it would produce.
        const statsAdapter = {
            save: (name, appid) => {
                I.saveStats(name, I.StatsLogic.SOURCE.DQ);
                I.IgnoreLog.append({ appid, name, source: 'dq' })
                    .catch((e) => console.warn('[ILAP] ignore-log append failed:', e));
            }
        };
        const nameExtractorAdapter = { get: (appid, el) => I.getGameName(appid, el) };
        // DQ is a visible source: it never yields to the background and marks foreground activity.
        const gateAdapter = { reserve: () => I.IgnoreGate.reserve({ foreground: true }) };

        new DiscoveryQueueController({
            automator: new I.Discovery.Automator({
                userdata: userdataAdapter,
                stats: statsAdapter,
                nameExtractor: nameExtractorAdapter,
                gate: gateAdapter,
                reward: I.SaleReward,
            }),
            ui: new I.Discovery.UI(new I.ResourceService()),
            registry: I.Discovery.Registry,
            insertionStrategy: InsertionStrategy,
            masterSwitch: I.MasterSwitch,
            reward: I.SaleReward,
            notice: I.AutomationNotice,
            ownerId: I.newOwnerId('dq_'),
        }).init();
    };
    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot);

})();