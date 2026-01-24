(function() {
    'use strict';

    class SettingsManager {
        constructor() {
            this.container = document.getElementById('settings-placeholder');
        }

        init() {
            chrome.storage.local.get(null, (data) => {
                this.render();
                this.bindEvents(data);
            });
        }

        render() {
            if (!this.container || this.container.children.length > 0) return; 

            this.container.innerHTML = `
                <!-- Discovery Queue Section -->
                <div class="section-title-row">
                    <div class="section-title">Your Discovery Queue</div>
                    <label class="switch" title="Master toggle for Discovery Queue automation.">
                        <input type="checkbox" id="q-master">
                        <span class="slider"></span>
                    </label>
                </div>
                
                <div id="q-sub-settings">
                    <div class="stat-row" title="Enable automatic transition after ignore.">
                        <span>Click Next after ignore</span>
                        <label class="switch">
                            <input type="checkbox" id="q-next">
                            <span class="slider"></span>
                        </label>
                    </div>

                    <div style="margin-top: 8px;">
                        <span style="font-size: 12px; display: block; margin-bottom: 4px;">Ignore Mode:</span>
                        <label class="wide-switch">
                            <input type="checkbox" id="q-mode-toggle">
                            <div class="wide-track">
                                <span class="wide-bg"></span>
                                <span class="wide-label">Bad Reviews</span>
                                <span class="wide-label">Every Game</span>
                            </div>
                        </label>
                    </div>
                </div>

                <!-- Manual Ignore Section -->
                <div class="section-title-row" style="margin-top: 15px;">
                    <div class="section-title">Manual Ignore</div>
                </div>
                
                <div class="stat-row">
                    <span style="flex: 1;">Default Ignore:</span>
                    <div style="display: flex; align-items: center; gap: 5px;">
                        <select id="default-key">
                            <option value="ctrlKey">Ctrl</option>
                            <option value="shiftKey">Shift</option>
                            <option value="altKey">Alt</option>
                        </select>
                        <span style="font-size: 11px; color: #8f98a0;">+</span>
                        <span class="click-badge">Click</span>
                    </div>
                </div>

                <div class="stat-row">
                    <span id="p-label" style="flex: 1;">Already Played:</span>
                    <div style="display: flex; align-items: center; gap: 5px;">
                        <select id="platform-key">
                            <option value="off">Off</option>
                            <option value="ctrlKey">Ctrl</option>
                            <option value="shiftKey">Shift</option>
                            <option value="altKey">Alt</option>
                        </select>
                        <span style="font-size: 11px; color: #8f98a0;">+</span>
                        <span id="p-badge" class="click-badge">Click</span>
                    </div>
                </div>
            `;
        }

        bindEvents(data) {
            const els = {
                qMaster: document.getElementById('q-master'),
                qNext: document.getElementById('q-next'),
                qMode: document.getElementById('q-mode-toggle'), // The new slider checkbox
                qSub: document.getElementById('q-sub-settings'),
                dSel: document.getElementById('default-key'),
                pSel: document.getElementById('platform-key'),
                pLabel: document.getElementById('p-label'),
                pBadge: document.getElementById('p-badge')
            };

            // Initial State
            els.qMaster.checked = data.ilap_q_master !== false;
            els.qNext.checked = !!data.ilap_q_next;
            
            // Logic for Mode: if stored is 'all', box is checked. Else (undefined or 'bad') unchecked.
            els.qMode.checked = (data.ilap_q_mode === 'all');

            els.dSel.value = data.ilap_shortcut_key || 'ctrlKey';
            els.pSel.value = data.ilap_platform_key || 'off';

            const updateVisuals = () => {
                els.qSub.classList.toggle('dimmed', !els.qMaster.checked);
                
                const isPlatformOff = els.pSel.value === 'off';
                els.pLabel.classList.toggle('dimmed', isPlatformOff);
                els.pBadge.classList.toggle('dimmed', isPlatformOff);

                this.syncSelectors(els.dSel, els.pSel);
            };

            updateVisuals();

            // Listeners
            els.qMaster.addEventListener('change', () => {
                chrome.storage.local.set({ ilap_q_master: els.qMaster.checked });
                updateVisuals();
            });
            els.qNext.addEventListener('change', () => chrome.storage.local.set({ ilap_q_next: els.qNext.checked }));
            
            // Mode Listener: checked = 'all', unchecked = 'bad'
            els.qMode.addEventListener('change', () => {
                const val = els.qMode.checked ? 'all' : 'bad';
                chrome.storage.local.set({ ilap_q_mode: val });
            });

            els.dSel.addEventListener('change', (e) => {
                chrome.storage.local.set({ ilap_shortcut_key: e.target.value });
                updateVisuals();
            });
            els.pSel.addEventListener('change', (e) => {
                chrome.storage.local.set({ ilap_platform_key: e.target.value });
                updateVisuals();
            });
        }

        syncSelectors(dSel, pSel) {
            Array.from(dSel.options).forEach(opt => opt.disabled = (pSel.value !== 'off' && opt.value === pSel.value));
            Array.from(pSel.options).forEach(opt => {
                if (opt.value !== 'off') opt.disabled = (opt.value === dSel.value);
            });
        }
    }

    window.ILAP_Settings = new SettingsManager();

})();