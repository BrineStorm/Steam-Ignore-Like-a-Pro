(function() {
    'use strict';

    function init() {
        const automator = window.ILAP.Explore.Automator;
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

    init();
})();