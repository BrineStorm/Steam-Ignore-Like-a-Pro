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
        const statsAdapter = { save: (name, source) => window.ILAP.saveStats(name, source) };      
        const nameExtractorAdapter = { get: (appid, el) => window.ILAP.getGameName(appid, el) };

        // 6. Automator DI Assembly
        const automator = new Explore.AutomatorClass({
            settings: extSettings,
            ui: uiService,
            api: apiAdapter,
            stats: statsAdapter,
            navGuard: navGuard,
            nameExtractor: nameExtractorAdapter,
            context: Explore.Context,
            analyzer: { getState: () => Explore.Analyzer.getState(Explore.COLORS) }, 
            decisionEngine: Explore.DecisionEngine
        });

        // 7. Run
        automator.run();
        
        let lastUrl = location.href;
        const observer = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                automator.run();
            }
        });
        observer.observe(document.body, { subtree: true, childList: true });
    }

    if (window.ILAP && window.ILAP.Explore) {
        init();
    } else {
        window.addEventListener('load', init);
    }
})();