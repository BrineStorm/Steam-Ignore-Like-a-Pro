(function() {
    'use strict';

    function init() {
        // --- 1. GLOBAL WATCHDOG ---
        const isQueuePage = window.ILAP.Explore.Context.isQueuePage();
        if (!isQueuePage) {
            sessionStorage.removeItem('ilap_queue_active');
            sessionStorage.removeItem('ilap_queue_ff');
            sessionStorage.removeItem('ilap_queue_nav_token');
            return; 
        }

        // --- 2. Initialization ---

        // Infrastructure
        const storageService = new window.ILAP.Explore.StorageService();
        const resourceService = new window.ILAP.Explore.ResourceService();
        
        // Domain Services
        const navGuard = new window.ILAP.Explore.NavigationGuard(storageService);

        // UI
        const uiService = new window.ILAP.Explore.UI(resourceService);

        // Adapters
        const apiAdapter = {
            ignore: (appid, reason) => window.ILAP.apiIgnoreGame(appid, reason)
        };
        const statsAdapter = {
            save: (name, source) => window.ILAP.saveStats(name, source)
        };
        // New Adapter
        const nameExtractorAdapter = {
            get: (appid) => window.ILAP.getGameName(appid)
        };

        // Automator (Controller)
        const AutomatorClass = window.ILAP.Explore.AutomatorClass;
        const automator = new AutomatorClass(
            storageService,
            uiService,
            apiAdapter,
            statsAdapter,
            navGuard,
            nameExtractorAdapter // Injection
        );

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