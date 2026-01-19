(function() {
    'use strict';

    /**
     * Settings Module
     * Handles UI for automation and manual ignore keys with cross-validation.
     */
    window.ILAP_Settings = {
        
        init: function() {
            chrome.storage.local.get(null, (data) => {
                this.render(data);
            });
        },

        render: function(data) {
            const container = document.getElementById('settings-placeholder');
            if (!container || container.children.length > 0) return; 

            container.innerHTML = `
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

                    <div class="stat-row">
                        <span id="q-logic-label" style="font-size: 12px;">Mode: Ignore every game</span>
                        <label class="switch" title="Toggle between Every game or Bad reviews only.">
                            <input type="checkbox" id="q-all">
                            <span class="slider"></span>
                        </label>
                    </div>
                </div>

                <!-- Manual Ignore Section -->
                <div class="section-title-row" style="margin-top: 5px;">
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

            this.bindEvents(data);
        },

        /**
         * Disables options in one selector if they are selected in the other
         */
        syncShortcutSelectors: function(dSel, pSel) {
            const dVal = dSel.value;
            const pVal = pSel.value;

            // 1. In Default Selector: disable what's selected in Platform (unless it's 'off')
            Array.from(dSel.options).forEach(opt => {
                opt.disabled = (pVal !== 'off' && opt.value === pVal);
            });

            // 2. In Platform Selector: disable what's selected in Default
            Array.from(pSel.options).forEach(opt => {
                if (opt.value === 'off') return; // 'Off' is always available
                opt.disabled = (opt.value === dVal);
            });
        },

        bindEvents: function(data) {
            const qMaster = document.getElementById('q-master');
            const qNext = document.getElementById('q-next');
            const qAll = document.getElementById('q-all');
            const qSub = document.getElementById('q-sub-settings');
            const qLogicLabel = document.getElementById('q-logic-label');
            
            const dSel = document.getElementById('default-key');
            const pSel = document.getElementById('platform-key');
            
            const pLabel = document.getElementById('p-label');
            const pBadge = document.getElementById('p-badge');

            // Set initial states
            qMaster.checked = data.ilap_q_master !== false;
            qNext.checked = !!data.ilap_q_next;
            qAll.checked = !!data.ilap_q_all;
            dSel.value = data.ilap_shortcut_key || 'ctrlKey';
            pSel.value = data.ilap_platform_key || 'off';

            const updateVisuals = () => {
                // Dimming Discovery Queue
                if (qMaster.checked) qSub.classList.remove('dimmed');
                else qSub.classList.add('dimmed');
                
                qLogicLabel.textContent = qAll.checked ? "Mode: Good reviews" : "Mode: Every game";

                // Partial Dimming for Already Played
                if (pSel.value === 'off') {
                    pLabel.classList.add('dimmed');
                    pBadge.classList.add('dimmed');
                } else {
                    pLabel.classList.remove('dimmed');
                    pBadge.classList.remove('dimmed');
                }

                // Cross-sync selectors
                this.syncShortcutSelectors(dSel, pSel);
            };

            updateVisuals();

            // Listeners for Discovery settings
            qMaster.addEventListener('change', () => {
                chrome.storage.local.set({ ilap_q_master: qMaster.checked });
                updateVisuals();
            });
            qNext.addEventListener('change', () => chrome.storage.local.set({ ilap_q_next: qNext.checked }));
            qAll.addEventListener('change', () => {
                chrome.storage.local.set({ ilap_q_all: qAll.checked });
                updateVisuals();
            });

            // Listeners for Manual Ignore keys
            dSel.addEventListener('change', (e) => {
                chrome.storage.local.set({ ilap_shortcut_key: e.target.value });
                updateVisuals();
            });

            pSel.addEventListener('change', (e) => {
                chrome.storage.local.set({ ilap_platform_key: e.target.value });
                updateVisuals();
            });
        }
    };

})();