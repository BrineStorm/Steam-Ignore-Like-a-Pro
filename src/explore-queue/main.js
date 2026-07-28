// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    function init() {
        const Explore = window.ILAP.Explore;
        const sessionState = new window.ILAP.SessionStateService();

        // 1. GLOBAL WATCHDOG
        if (!Explore.Context.isQueuePage()) {
            sessionState.remove(Explore.KEYS.ACTIVE);
            sessionState.remove(Explore.KEYS.FF);
            sessionState.remove(Explore.KEYS.NAV_TOKEN);
            sessionState.remove(Explore.KEYS.ACTIVE_APPID);
            return;
        }

        // 2. Infrastructure Initialization
        const extSettings = new Explore.ExtensionSettingsService();
        const resourceService = new window.ILAP.ResourceService();
        
        // 3. Domain Service Initialization
        const navGuard = new Explore.NavigationGuard(sessionState);

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
        // Stats + the undo log ride one adapter call (appid → ilap_ignore_log).
        // The log is optional, same stance as the drainer's log hooks: a partial
        // build must degrade to stats-only, not throw mid-ignore.
        const statsAdapter = { save: (name, source, appid) => {
            window.ILAP.saveStats(name, source);
            if (window.ILAP.IgnoreLog) window.ILAP.IgnoreLog.append({ appid, name, source: 'eq' });
        } };
        const nameExtractorAdapter = { get: (appid, el) => window.ILAP.getGameName(appid, el) };

        // 6. Automator DI Assembly
        const automator = new Explore.AutomatorClass({
            settings: extSettings,
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
        automator.run();
        
        // 8. Re-run on same-document navigation (Steam advances the queue without
        //    a page load). This used to be a childList+subtree MutationObserver on
        //    document.body — a callback per mutation batch of a React page that
        //    mutates constantly, to answer a question that is one string compare.
        //    A patched history.pushState can't replace it: in the isolated world
        //    the patch never sees the PAGE's own pushState calls. So: popstate for
        //    back/forward (instant), plus a bounded poll for pushState-driven
        //    advances. Both live as long as the queue page does — by design, and
        //    now at a fixed 2 checks/s instead of unbounded work.
        let lastUrl = location.href;
        const onUrlMaybeChanged = () => {
            if (location.href === lastUrl) return;
            lastUrl = location.href;
            automator.run();
        };
        window.addEventListener('popstate', onUrlMaybeChanged);
        setInterval(onUrlMaybeChanged, 500);
    }

    if (window.ILAP && window.ILAP.Explore) {
        init();
    } else {
        window.addEventListener('load', init);
    }
})();