(function() {
    'use strict';

    function init() {
        // Safe access to module exports
        const Explore = window.ILAP.Explore;
        
        // 1. GLOBAL WATCHDOG
        if (!Explore.Context.isQueuePage()) {
            sessionStorage.removeItem('ilap_queue_active');
            sessionStorage.removeItem('ilap_queue_ff');
            sessionStorage.removeItem('ilap_queue_nav_token');
            return; 
        }

        // 2. Infrastructure Initialization
        const extSettings = new Explore.ExtensionSettingsService();
        const sessionState = new Explore.SessionStateService();
        const resourceService = new Explore.ResourceService();
        
        // 3. Domain Service Initialization
        const navGuard = new Explore.NavigationGuard(sessionState);

        // 4. UI Initialization (DIP passed)
        const uiService = new Explore.UI(
            resourceService, 
            Explore.COLORS, 
            () => Explore.Context.getIgnoreContainer() // Context injected as a function
        );

        // 5. External Adapters Creation
        const apiAdapter = { ignore: (appid, reason) => window.ILAP.apiIgnoreGame(appid, reason) };
        const statsAdapter = { save: (name, source) => window.ILAP.saveStats(name, source) };
        const nameExtractorAdapter = { get: (appid) => window.ILAP.getGameName(appid) };

        // 6. Automator DI Assembly
        const automator = new Explore.AutomatorClass({
            settings: extSettings,
            ui: uiService,
            api: apiAdapter,
            stats: statsAdapter,
            navGuard: navGuard,
            nameExtractor: nameExtractorAdapter,
            context: Explore.Context,
            analyzer: { getState: () => Explore.Analyzer.getState(Explore.COLORS) }, // Bound config
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

    // Ensure dependencies exist before loading
    if (window.ILAP && window.ILAP.Explore) {
        init();
    } else {
        window.addEventListener('load', init);
    }
})();