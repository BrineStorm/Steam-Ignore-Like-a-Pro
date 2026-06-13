(function() {
    'use strict';

    const t = (k, p) => (window.ILAP && window.ILAP.t) ? window.ILAP.t(k, p) : k;

    const normalizeShortcut = (v) => (window.ILAP && window.ILAP.normalizeShortcut) ? window.ILAP.normalizeShortcut(v) : v;

    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Mini gradient swoosh (same look as the popup hint, smaller); flipped for a left swipe.
    const miniSwoosh = (isRight, id) => {
        const flip = isRight ? '' : ' style="transform:scaleX(-1)"';
        return `<svg class="mini-arrow" viewBox="0 0 34 16" width="22" height="11" aria-hidden="true"${flip}><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3ca8fc" stop-opacity="0"/><stop offset=".5" stop-color="#3ca8fc" stop-opacity=".85"/><stop offset="1" stop-color="#3ca8fc"/></linearGradient></defs><path d="M2 8 C9 6.6 14 6.6 19 7.2 L19 2.5 L32 8 L19 13.5 L19 8.8 C14 9.4 9 9.4 2 8 Z" fill="url(#${id})"/></svg>`;
    };

    // Visible label for a shortcut value: swipe directions render as a mini swoosh
    // instead of a text arrow; other shortcuts stay plain text.
    const SHORTCUT_LABELS = {
        swipeRight: ['shortcut_swipe_right', true],
        swipeLeft:  ['shortcut_swipe_left', false],
        ctrlKey:  ['shortcut_ctrl_left', null],
        shiftKey: ['shortcut_shift_left', null],
        altKey:   ['shortcut_alt_left', null],
        off:      ['off', null]
    };

    function shortcutDisplay(value, slot) {
        const entry = SHORTCUT_LABELS[value];
        if (!entry) return '';
        const text = t(entry[0]);
        if (entry[1] === null) return esc(text);
        const stripped = text.replace(/\s*[→←➜]\s*$/, '');
        return `${esc(stripped)} ${miniSwoosh(entry[1], 'sw-' + slot)}`;
    }

    function closeAllMenus() {
        document.querySelectorAll('.select-menu.open').forEach(m => m.classList.remove('open'));
    }
    document.addEventListener('click', closeAllMenus);

    // Replace the OS-rendered <select> list with a styled menu, while keeping the
    // real <select> as the value store (and the element Playwright drives in tests).
    function enhanceSelect(shell, select, slot) {
        if (!shell || !select) return;
        const display = shell.querySelector('.select-display');
        const menu = document.createElement('div');
        menu.className = 'select-menu';
        shell.appendChild(menu);

        display.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasOpen = menu.classList.contains('open');
            closeAllMenus();
            if (wasOpen) return;
            menu.innerHTML = Array.from(select.options).map((opt, i) => {
                const cls = (opt.value === select.value ? ' selected' : '') + (opt.disabled ? ' disabled' : '');
                return `<div class="select-opt${cls}" data-value="${esc(opt.value)}">${shortcutDisplay(opt.value, slot + '-' + i)}</div>`;
            }).join('');
            menu.classList.add('open');
        });

        menu.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = e.target.closest('.select-opt');
            if (!item || item.classList.contains('disabled')) return;
            menu.classList.remove('open');
            const val = item.getAttribute('data-value');
            if (val !== select.value) {
                select.value = val;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
    }

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

        /**
         * Called from popup_main.js when storage changes (e.g. language switch).
         * If settings panel was already rendered, rebuild it so all labels pick
         * up the new locale; otherwise no-op (init() will run on first open).
         */
        relabel(data) {
            if (!this.container || this.container.children.length === 0) return;
            this.render();
            this.bindEvents(data || {});
        }

        render() {
            if (!this.container) return;

            this.container.innerHTML = `
                <div class="section-title-row">
                    <div class="section-title" data-i18n="your_discovery_queue">Your Discovery Queue</div>
                    <label class="switch" data-i18n-title="tooltip_dq_master" title="Master toggle for Discovery Queue automation.">
                        <input type="checkbox" id="q-master">
                        <span class="slider"></span>
                    </label>
                </div>

                <div id="q-sub-settings">
                    <div class="stat-row" data-i18n-title="tooltip_dq_next" title="Enable automatic transition ONLY when a game is successfully ignored.">
                        <span data-i18n="click_next_after_ignore">Click Next after applied ignore</span>
                        <label class="switch">
                            <input type="checkbox" id="q-next">
                            <span class="slider"></span>
                        </label>
                    </div>

                    <div style="margin-top: 8px;">
                        <span style="font-size: 12px; display: block; margin-bottom: 4px;" data-i18n="ignore_mode">Ignore Mode:</span>
                        <label class="wide-switch">
                            <input type="checkbox" id="q-mode-toggle">
                            <div class="wide-track">
                                <span class="wide-bg"></span>
                                <span class="wide-label" data-i18n="mode_bad_reviews">Bad Reviews</span>
                                <span class="wide-label" data-i18n="mode_every_game">Every Game</span>
                            </div>
                        </label>
                    </div>
                </div>

                <div class="section-title-row" style="margin-top: 8px;">
                    <div class="section-title" data-i18n="section_manual_ignore">Manual Ignore</div>
                </div>

                <div class="stat-row">
                    <span style="flex: 1;" data-i18n="default_ignore">Default Ignore:</span>
                    <div class="select-shell">
                        <span class="select-display" id="default-key-display"></span>
                        <select id="default-key">
                            <option value="swipeRight" data-i18n="shortcut_swipe_right">Right-Click + Swipe &rarr;</option>
                            <option value="swipeLeft" data-i18n="shortcut_swipe_left">Right-Click + Swipe &larr;</option>
                            <option value="ctrlKey" data-i18n="shortcut_ctrl_left">Ctrl + Left-Click</option>
                            <option value="shiftKey" data-i18n="shortcut_shift_left">Shift + Left-Click</option>
                            <option value="altKey" data-i18n="shortcut_alt_left">Alt + Left-Click</option>
                        </select>
                    </div>
                </div>

                <div class="stat-row">
                    <span id="p-label" style="flex: 1;" data-i18n="already_played">Already Played:</span>
                    <div class="select-shell">
                        <span class="select-display" id="platform-key-display"></span>
                        <select id="platform-key">
                            <option value="off" data-i18n="off">Off</option>
                            <option value="swipeRight" data-i18n="shortcut_swipe_right">Right-Click + Swipe &rarr;</option>
                            <option value="swipeLeft" data-i18n="shortcut_swipe_left">Right-Click + Swipe &larr;</option>
                            <option value="ctrlKey" data-i18n="shortcut_ctrl_left">Ctrl + Left-Click</option>
                            <option value="shiftKey" data-i18n="shortcut_shift_left">Shift + Left-Click</option>
                            <option value="altKey" data-i18n="shortcut_alt_left">Alt + Left-Click</option>
                        </select>
                    </div>
                </div>
            `;

            if (window.ILAP && window.ILAP.i18n) window.ILAP.i18n.applyDom(this.container);
        }

        bindEvents(data) {
            const els = {
                qMaster: document.getElementById('q-master'),
                qNext: document.getElementById('q-next'),
                qMode: document.getElementById('q-mode-toggle'),
                qSub: document.getElementById('q-sub-settings'),
                dSel: document.getElementById('default-key'),
                pSel: document.getElementById('platform-key'),
                pLabel: document.getElementById('p-label')
            };

            els.qMaster.checked = data.ilap_q_master !== false;
            els.qNext.checked = !!data.ilap_q_next;
            els.qMode.checked = (data.ilap_q_mode === 'all');

            els.dSel.value = normalizeShortcut(data.ilap_shortcut_key) || 'swipeRight';
            els.pSel.value = normalizeShortcut(data.ilap_platform_key) || 'swipeLeft';

            const dDisp = document.getElementById('default-key-display');
            const pDisp = document.getElementById('platform-key-display');

            const updateVisuals = () => {
                els.qSub.classList.toggle('dimmed', !els.qMaster.checked);
                const isPlatformOff = els.pSel.value === 'off';
                els.pLabel.classList.toggle('dimmed', isPlatformOff);
                this.syncSelectors(els.dSel, els.pSel);
                if (dDisp) dDisp.innerHTML = shortcutDisplay(els.dSel.value, 'def');
                if (pDisp) pDisp.innerHTML = shortcutDisplay(els.pSel.value, 'plat');
            };

            updateVisuals();

            enhanceSelect(els.dSel.closest('.select-shell'), els.dSel, 'def');
            enhanceSelect(els.pSel.closest('.select-shell'), els.pSel, 'plat');

            els.qMaster.addEventListener('change', () => {
                chrome.storage.local.set({ ilap_q_master: els.qMaster.checked });
                updateVisuals();
            });
            els.qNext.addEventListener('change', () => chrome.storage.local.set({ ilap_q_next: els.qNext.checked }));

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
