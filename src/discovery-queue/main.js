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
        //   ownerId            this tab's identity in the registry
        constructor(deps) {
            this.automator = deps.automator;
            this.ui = deps.ui;
            this.registry = deps.registry;
            this.insertion = deps.insertionStrategy;
            this.masterSwitch = deps.masterSwitch;
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

        // Start/stop the loop, gated by the cross-tab DQ-automator cap. Stopping
        // needs no registry check; starting claims a slot first and refuses (with
        // a transient button message) when other tabs already fill the cap. The
        // _starting latch swallows clicks landing while the acquire is in flight
        // (isRunning is still false then, so they'd read as a second Start).
        async _toggle() {
            if (this._starting) return;
            if (this.automator.isRunning) {
                this.automator.stop();     // the UI observer frees the slot
                return;
            }
            this._starting = true;
            try {
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
                        onToggle: () => this._toggle(),
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
            }),
            ui: new I.Discovery.UI(),
            registry: I.Discovery.Registry,
            insertionStrategy: InsertionStrategy,
            masterSwitch: I.MasterSwitch,
            ownerId: I.newOwnerId('dq_'),
        }).init();
    };
    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot);

})();