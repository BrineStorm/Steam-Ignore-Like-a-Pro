(function() {
    'use strict';

    // === SECURITY FIX: XSS Sanitizer ===
    const Sanitizer = {
        escapeHTML(str) {
            if (!str) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }
    };

    function getShortcutHintHtml(key) {
        const mouseIcon = (isRight) => `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 14 48 54" width="16" height="18" fill="none" class="mouse-icon">
              <rect x="4" y="18" width="40" height="46" rx="20" ry="20" fill="#1b2838" stroke="#3d4a5d" stroke-width="2"/>
              <path d="M4 28 C4 22 8 18 14 18 L23 18 L23 38 L4 38 Z" fill="${!isRight ? '#66c0f4' : '#171a21'}"/>
              <line x1="24" y1="18" x2="24" y2="38" stroke="#3d4a5d" stroke-width="2"/>
              <path d="M25 18 L34 18 C40 18 44 22 44 28 L44 38 L25 38 Z" fill="${isRight ? '#66c0f4' : '#171a21'}"/>
              <rect x="21" y="22" width="6" height="12" rx="3" fill="#ffffff" opacity="0.85"/>
              <path d="M4 42 L4 46 C4 57 14 64 24 64 C34 64 44 57 44 46 L44 42 Z" fill="#171a21"/>
            </svg>
        `;

        if (key === 'swipeRightRight') return `<span class="kbd-key" style="margin-left:0;">Hold & Swipe &rarr;</span> ${mouseIcon(true)}`;
        if (key === 'swipeRightLeft') return `<span class="kbd-key" style="margin-left:0;">Hold & Swipe &larr;</span> ${mouseIcon(true)}`;
        
        const names = { 'ctrlKey': 'Ctrl', 'shiftKey': 'Shift', 'altKey': 'Alt' };
        
        const safeKeyName = Sanitizer.escapeHTML(names[key] || key);
        return `<span class="kbd-key" style="margin-left:0;">${safeKeyName}</span> <span style="margin: 0 4px;">+</span> <span class="kbd-key">L-Click</span> ${mouseIcon(false)}`;
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
        
        const defKey = data.ilap_shortcut_key || 'swipeRightRight';
        const platKey = data.ilap_platform_key || 'swipeRightLeft';
        
        let hintHtml = `
            <div class="hint-line">
                <span class="hint-label">Ignore:</span>
                ${getShortcutHintHtml(defKey)}
            </div>
        `;
        
        if (platKey !== 'off') {
            hintHtml += `
                <div class="hint-line" style="margin-top: 8px;">
                    <span class="hint-label" style="color: #3ca8fc;">Already played:</span>
                    ${getShortcutHintHtml(platKey)}
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
                // innerHTML needs sanitization
                historyDiv.innerHTML = history.slice(0, 3).map(i => {
                    const safeGameName = Sanitizer.escapeHTML(i.name);
                    return `<div class="history-entry">• ${safeGameName}</div>`;
                }).join('');
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