(function() {
    'use strict';
    
    // Dependencies
    const UI = window.ILAP.QueueUI;
    const Logic = window.ILAP.QueueLogic;

    function init() {
        // Connect Logic to UI updates
        Logic.init((isRunning, count) => {
            UI.updateState(isRunning, count);
        });

        // Start the DOM Observer
        setInterval(() => {
            const modal = document.querySelector('.FullModalOverlay div[role="dialog"]');
            
            if (modal) {
                const insertion = UI.findInsertionPoint(modal);
                
                if (insertion && insertion.parent) {
                    const container = UI.create(
                        // On Button Click
                        () => Logic.toggle(),
                        // On Checkbox Change
                        (val) => Logic.setSkipPositive(val)
                    );

                    // Inject if not present
                    if (!insertion.parent.contains(container)) {
                        insertion.parent.insertBefore(container, insertion.referenceNode);
                        
                        // Sync visual state in case of re-injection
                        // (We need to expose a getter for isRunning in Logic really, 
                        // but re-clicking stop/start is fine for now or pass state via closure)
                    }
                }
            } else {
                // Modal closed -> Cleanup UI
                UI.remove();
                // Logic handles its own stop condition when dialog disappears
            }
        }, 1000);
    }

    window.addEventListener('load', init);

})();