(function() {
    'use strict';

    function getShortcutDisplayName(key) {
        const names = { 'ctrlKey': 'Ctrl', 'shiftKey': 'Shift', 'altKey': 'Alt' };
        return names[key] || 'Off';
    }

    function updateBasicUI(data) {
        const isEnabled = data.ilap_master_enabled !== false;
        
        const master = document.getElementById('master-toggle');
        if (master) master.checked = isEnabled;

        const wrapper = document.getElementById('ui-wrapper');
        if (isEnabled) wrapper.classList.remove('disabled');
        else wrapper.classList.add('disabled');

        document.getElementById('count-link').textContent = data.ilap_ignored_count || 0;
        document.getElementById('last-game').textContent = data.ilap_last_ignored_name || 'None';
        
        const defKey = getShortcutDisplayName(data.ilap_shortcut_key || 'ctrlKey');
        const platKey = data.ilap_platform_key || 'off';
        
        // Provided SVG Mouse Icon (Optimized viewBox for text alignment and colors for Steam theme)
        const mouseIcon = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 14 48 54" width="16" height="18" fill="none" class="mouse-icon">
              <!-- Mouse body -->
              <rect x="4" y="18" width="40" height="46" rx="20" ry="20" fill="#1b2838" stroke="#3d4a5d" stroke-width="2"/>
              <!-- Left button highlight (active) -->
              <path d="M4 28 C4 22 8 18 14 18 L23 18 L23 38 L4 38 Z" fill="#66c0f4" opacity="0.9"/>
              <path d="M4 28 C4 22 8 18 14 18 L23 18 L23 38 L4 38 Z" fill="url(#leftGlow)" opacity="0.6"/>
              <!-- Divider line -->
              <line x1="24" y1="18" x2="24" y2="38" stroke="#3d4a5d" stroke-width="2"/>
              <!-- Right button (inactive) -->
              <path d="M25 18 L34 18 C40 18 44 22 44 28 L44 38 L25 38 Z" fill="#171a21"/>
              <!-- Scroll wheel -->
              <rect x="21" y="22" width="6" height="12" rx="3" fill="#ffffff" opacity="0.85"/>
              <!-- Click ripple indicator -->
              <circle cx="12" cy="28" r="3" fill="white" opacity="0.4"/>
              <!-- Bottom rounded cap -->
              <path d="M4 42 L4 46 C4 57 14 64 24 64 C34 64 44 57 44 46 L44 42 Z" fill="#171a21"/>
              <defs>
                <linearGradient id="leftGlow" x1="4" y1="18" x2="23" y2="38" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stop-color="#fff"/>
                  <stop offset="100%" stop-color="#66c0f4" stop-opacity="0"/>
                </linearGradient>
              </defs>
            </svg>
        `;
        
        let hintHtml = `
            <div class="hint-line">
                <span class="hint-label">Ignore:</span>
                <span class="kbd-key">${defKey}</span> + <span>Click</span> ${mouseIcon}
            </div>
        `;
        
        if (platKey !== 'off') {
            const pKeyDisp = getShortcutDisplayName(platKey);
            hintHtml += `
                <div class="hint-line" style="margin-top: 8px;">
                    <span class="hint-label">Played:</span>
                    <span class="kbd-key">${pKeyDisp}</span> + <span>Click</span> ${mouseIcon}
                </div>
            `;
        }
        
        const hintContainer = document.getElementById('dynamic-hint');
        if (hintContainer) {
            hintContainer.innerHTML = hintHtml;
        }

        const history = data.ilap_ignored_history || [];
        const historyDiv = document.getElementById('history-list');
        if (historyDiv) {
            if (history.length > 0) {
                historyDiv.innerHTML = history.slice(0, 3).map(i => `<div class="history-entry">â€ ${i.name}</div>`).join('');
            } else {
                historyDiv.innerHTML = '<div class="history-entry"><i>No recent history</i></div>';
            }
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        chrome.storage.local.get(null, (res) => {
            updateBasicUI(res);

            const accordion = document.getElementById('settings-accordion');
            accordion.open = false; 

            accordion.addEventListener('toggle', () => {
                if (accordion.open && window.ILAP_Settings) {
                    window.ILAP_Settings.init();
                }
            });

            document.getElementById('master-toggle').addEventListener('change', (e) => {
                chrome.storage.local.set({ ilap_master_enabled: e.target.checked });
            });

            setTimeout(() => document.body.classList.remove('no-transition'), 100);
        });
    });

    chrome.storage.onChanged.addListener(() => {
        chrome.storage.local.get(null, (current) => updateBasicUI(current));
    });

})();