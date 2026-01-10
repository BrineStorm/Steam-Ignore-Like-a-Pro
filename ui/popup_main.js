(function() {
    'use strict';

    /**
     * Formats the internal key name to human-readable text
     */
    function getShortcutDisplayName(key) {
        const names = { 'ctrlKey': 'Ctrl', 'shiftKey': 'Shift', 'altKey': 'Alt' };
        return names[key] || 'Off';
    }

    /**
     * Updates main popup stats and Master Switch state
     */
    function updateBasicUI(data) {
        const isEnabled = data.ilap_master_enabled !== false;
        
        // 1. Master Toggle
        const master = document.getElementById('master-toggle');
        if (master) master.checked = isEnabled;

        // 2. Grayscale UI effect
        const wrapper = document.getElementById('ui-wrapper');
        if (isEnabled) wrapper.classList.remove('disabled');
        else wrapper.classList.add('disabled');

        // 3. Stats & History
        document.getElementById('count-link').textContent = data.ilap_ignored_count || 0;
        document.getElementById('last-game').textContent = data.ilap_last_ignored_name || 'None';
        document.getElementById('hint-key').textContent = getShortcutDisplayName(data.ilap_shortcut_key || 'ctrlKey');

        const history = data.ilap_ignored_history || [];
        const historyDiv = document.getElementById('history-list');
        if (historyDiv) {
            if (history.length > 0) {
                historyDiv.innerHTML = history.slice(0, 3).map(i => `<div class="history-entry">â€ ${i.name}</div>`).join('');
            } else {
                historyDiv.innerHTML = '<i>No recent history</i>';
            }
        }
    }

    /**
     * Main Entry Point
     */
    document.addEventListener('DOMContentLoaded', () => {
        chrome.storage.local.get(null, (res) => {
            updateBasicUI(res);

            // Settings accordion logic
            const accordion = document.getElementById('settings-accordion');
            // Always start closed for performance
            accordion.open = false; 

            accordion.addEventListener('toggle', () => {
                if (accordion.open && window.ILAP_Settings) {
                    window.ILAP_Settings.init();
                }
            });

            // Global Master Toggle
            document.getElementById('master-toggle').addEventListener('change', (e) => {
                chrome.storage.local.set({ ilap_master_enabled: e.target.checked });
            });

            // Disable initial flicker protection
            setTimeout(() => document.body.classList.remove('no-transition'), 100);
        });
    });

    // Listen for storage changes from other tabs
    chrome.storage.onChanged.addListener(() => {
        chrome.storage.local.get(null, (current) => updateBasicUI(current));
    });

})();