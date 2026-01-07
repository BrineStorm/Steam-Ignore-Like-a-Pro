function getShortcutDisplayName(key) {
    switch(key) {
        case 'ctrlKey': return 'Ctrl';
        case 'shiftKey': return 'Shift';
        case 'altKey': return 'Alt';
        default: return 'Off';
    }
}

function updateBasicUI(data) {
    const isEnabled = data.ilap_master_enabled !== false;
    
    // Master Toggle & UI State
    document.getElementById('master-toggle').checked = isEnabled;
    const wrapper = document.getElementById('ui-wrapper');
    if (isEnabled) wrapper.classList.remove('disabled');
    else wrapper.classList.add('disabled');

    // Stats & Hint
    document.getElementById('count-link').textContent = data.ilap_ignored_count || 0;
    document.getElementById('last-game').textContent = data.ilap_last_ignored_name || 'None';
    document.getElementById('hint-key').textContent = getShortcutDisplayName(data.ilap_shortcut_key || 'ctrlKey');

    // History Tooltip: Full Width Wrap
    const history = data.ilap_ignored_history || [];
    const historyDiv = document.getElementById('history-list');
    if (history.length > 0) {
        historyDiv.innerHTML = history.slice(0, 3).map(item => 
            `<div class="history-entry">â€ ${item.name}</div>`
        ).join('');
    }
}

/**
 * Renders settings content only when needed (Lazy loading)
 */
function renderSettings(data) {
    const container = document.getElementById('settings-placeholder');
    if (container.children.length > 0) return; 

    container.innerHTML = `
        <div class="section-title">Your Discovery Queue</div>
        <label class="checkbox-label" title="Ignore games with Mixed/Negative reviews automatically.">
          <input type="checkbox" id="keep-high-score"> Auto-ignore non-positive
        </label>

        <div class="section-title">Manual Ignore</div>
        <div class="stat-row">
          <span>Default Ignore:</span>
          <select id="default-key">
            <option value="ctrlKey">Ctrl</option>
            <option value="shiftKey">Shift</option>
            <option value="altKey">Alt</option>
          </select>
          <span class="click-badge">Click</span>
        </div>

        <div class="stat-row">
          <span>Ignore (Platform):</span>
          <select id="platform-key">
            <option value="off">Off</option>
            <option value="ctrlKey">Ctrl</option>
            <option value="shiftKey">Shift</option>
            <option value="altKey">Alt</option>
          </select>
          <span class="click-badge">Click</span>
        </div>
    `;

    const dKey = data.ilap_shortcut_key || 'ctrlKey';
    const pKey = data.ilap_platform_key || 'off';
    
    const dSelector = document.getElementById('default-key');
    const pSelector = document.getElementById('platform-key');
    const hsCheckbox = document.getElementById('keep-high-score');

    dSelector.value = dKey;
    pSelector.value = pKey;
    hsCheckbox.checked = !!data.ilap_keep_high_score_explore;

    // Listeners for newly created elements
    dSelector.addEventListener('change', (e) => chrome.storage.local.set({ ilap_shortcut_key: e.target.value }));
    pSelector.addEventListener('change', (e) => chrome.storage.local.set({ ilap_platform_key: e.target.value }));
    hsCheckbox.addEventListener('change', (e) => chrome.storage.local.set({ ilap_keep_high_score_explore: e.target.checked }));
}

document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(null, (res) => {
        updateBasicUI(res);
        const accordion = document.getElementById('settings-accordion');
        
        if (res.ilap_settings_open) {
            accordion.open = true;
            renderSettings(res);
        }

        accordion.addEventListener('toggle', () => {
            chrome.storage.local.set({ ilap_settings_open: accordion.open });
            if (accordion.open) renderSettings(res);
        });
    });

    document.getElementById('master-toggle').addEventListener('change', (e) => {
        chrome.storage.local.set({ ilap_master_enabled: e.target.checked });
    });
});

chrome.storage.onChanged.addListener(() => {
    chrome.storage.local.get(null, (current) => updateBasicUI(current));
});