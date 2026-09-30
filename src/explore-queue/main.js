// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    function init() {
        const Explore = window.ILAP.Explore;
        const sessionState = new window.ILAP.SessionStateService();
        const navGuard = new Explore.NavigationGuard(sessionState);

        // 1. GLOBAL WATCHDOG: off a queue page, no automation intent survives.
        if (!Explore.Context.isQueuePage()) {
            navGuard.resetState();
            return;
        }

        // 2. Infrastructure Initialization
        const queueSettings = new Explore.QueueSettings(window.ILAP.Settings);
        const resourceService = new window.ILAP.ResourceService();
        
        // 3. Domain Service Initialization: the NavigationGuard, built above for the watchdog.

        // 4. UI Initialization
        const uiService = new Explore.UI(
            resourceService, 
            Explore.COLORS, 
            () => Explore.Context.getIgnoreContainer() 
        );

        // 5. External Adapters Creation
        const apiAdapter = { ignore: (appid, reason) => window.ILAP.apiIgnoreGame(appid, reason) };
        const gateAdapter = {
            // EQ is a visible source: it never yields to the background and marks foreground activity.
            reserve: () => window.ILAP.IgnoreGate.reserve({ foreground: true }),
            reportRateLimited: (ms) => window.ILAP.IgnoreGate.reportRateLimited(ms)
        };
        // Stats and the undo log ride one adapter call. Nothing awaits either:
        // saveStats swallows its own rejection, and the log append needs its own
        // catch for the same reason (serialChain hands the CALLER its rejection).
        // What rejects in practice is an extension update — this page's script
        // keeps running with no storage behind it — and one unhandled rejection
        // per ignore is all it would produce.
        const statsAdapter = { save: (name, appid) => {
            window.ILAP.saveStats(name, window.ILAP.StatsLogic.SOURCE.EQ);
            window.ILAP.IgnoreLog.append({ appid, name, source: 'eq' })
                .catch((e) => console.warn('[ILAP] ignore-log append failed:', e));
        } };
        const nameExtractorAdapter = { get: (appid, el) => window.ILAP.getGameName(appid, el) };

        // 6. Automator DI Assembly
        const automator = new Explore.AutomatorClass({
            settings: queueSettings,
            ui: uiService,
            api: apiAdapter,
            gate: gateAdapter,
            stats: statsAdapter,
            navGuard: navGuard,
            nameExtractor: nameExtractorAdapter,
            context: Explore.Context,
            analyzer: { getState: () => Explore.Analyzer.getState(Explore.COLORS) }, 
            decisionEngine: Explore.DecisionEngine
        });

        // 7. Run
        automator.kick();
        
        // 8. Re-run on a same-document URL change. Next is a full page load
        //    (verified), so this is a cheap guard for a navigation Steam does not
        //    do today. The isolated world cannot see the page's pushState, hence
        //    popstate plus a poll of one string compare.
        let lastUrl = location.href;
        const onUrlMaybeChanged = () => {
            if (location.href === lastUrl) return;
            lastUrl = location.href;
            automator.kick();
        };
        window.addEventListener('popstate', onUrlMaybeChanged);
        setInterval(onUrlMaybeChanged, 500);
    }

    // Explore's modules load before this file in the same content_scripts list,
    // and document_idle injection means the DOM is already parsed.
    init();
})();