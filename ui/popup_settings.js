// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    const t = (k, p) => (window.ILAP && window.ILAP.t) ? window.ILAP.t(k, p) : k;

    const normalizeShortcut = (v) => (window.ILAP && window.ILAP.normalizeShortcut) ? window.ILAP.normalizeShortcut(v) : v;

    // Shared HTML-escaper (src/escape.js, loaded first in popup.html + content_scripts).
    const esc = window.ILAP.Sanitizer.escapeHTML;

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

    // Replace the OS-rendered <select> list with a styled menu, while keeping the
    // real <select> as the value store (and the element Playwright drives in tests).
    function enhanceSelect(shell, select, slot, root) {
        if (!shell || !select) return;
        const closeAll = () => root.querySelectorAll('.select-menu.open').forEach(m => m.classList.remove('open'));
        const display = shell.querySelector('.select-display');
        const menu = document.createElement('div');
        menu.className = 'select-menu';
        shell.appendChild(menu);

        display.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasOpen = menu.classList.contains('open');
            closeAll();
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
        constructor(root) {
            this.root = root;
            this.container = root.getElementById('settings-placeholder');
            // Close any open custom dropdown when clicking elsewhere within this root.
            root.addEventListener('click', () => this.closeAllMenus());
        }

        closeAllMenus() {
            this.root.querySelectorAll('.select-menu.open').forEach(m => m.classList.remove('open'));
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
                        <span data-i18n="click_next_after_ignore">Auto-advance after ignore</span>
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
                    <span data-i18n="blur_ignored_covers">Blur ignored covers</span>
                    <label class="switch">
                        <input type="checkbox" id="mask-toggle">
                        <span class="slider"></span>
                    </label>
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
            const els = this.els = {
                qMaster: this.root.getElementById('q-master'),
                qNext: this.root.getElementById('q-next'),
                qMode: this.root.getElementById('q-mode-toggle'),
                qSub: this.root.getElementById('q-sub-settings'),
                dSel: this.root.getElementById('default-key'),
                pSel: this.root.getElementById('platform-key'),
                pLabel: this.root.getElementById('p-label'),
                mask: this.root.getElementById('mask-toggle')
            };

            this._applyValues(data);

            enhanceSelect(els.dSel.closest('.select-shell'), els.dSel, 'def', this.root);
            enhanceSelect(els.pSel.closest('.select-shell'), els.pSel, 'plat', this.root);

            els.qMaster.addEventListener('change', () => {
                chrome.storage.local.set({ ilap_q_master: els.qMaster.checked });
                this._updateVisuals();
            });
            els.qNext.addEventListener('change', () => chrome.storage.local.set({ ilap_q_next: els.qNext.checked }));
            els.mask.addEventListener('change', () => chrome.storage.local.set({ ilap_mask_enabled: els.mask.checked }));

            els.qMode.addEventListener('change', () => {
                const val = els.qMode.checked ? 'all' : 'bad';
                chrome.storage.local.set({ ilap_q_mode: val });
            });

            els.dSel.addEventListener('change', (e) => {
                chrome.storage.local.set({ ilap_shortcut_key: e.target.value });
                this._updateVisuals();
            });
            els.pSel.addEventListener('change', (e) => {
                chrome.storage.local.set({ ilap_platform_key: e.target.value });
                this._updateVisuals();
            });
        }

        _applyValues(data) {
            const els = this.els;
            if (!els) return;
            els.qMaster.checked = data.ilap_q_master !== false;
            els.qNext.checked = !!data.ilap_q_next;
            els.qMode.checked = (data.ilap_q_mode === 'all');
            els.mask.checked = !!data.ilap_mask_enabled;
            els.dSel.value = normalizeShortcut(data.ilap_shortcut_key) || 'swipeRight';
            els.pSel.value = normalizeShortcut(data.ilap_platform_key) || 'swipeLeft';
            this._updateVisuals();
        }

        _updateVisuals() {
            const els = this.els;
            if (!els) return;
            els.qSub.classList.toggle('dimmed', !els.qMaster.checked);
            els.pLabel.classList.toggle('dimmed', els.pSel.value === 'off');
            this.syncSelectors(els.dSel, els.pSel);
            const dDisp = this.root.getElementById('default-key-display');
            const pDisp = this.root.getElementById('platform-key-display');
            if (dDisp) dDisp.innerHTML = shortcutDisplay(els.dSel.value, 'def');
            if (pDisp) pDisp.innerHTML = shortcutDisplay(els.pSel.value, 'plat');
        }

        /**
         * Reflect external storage changes (e.g. the Explore-Queue "Disable" button
         * writes ilap_q_master=false) onto the already-rendered controls. Value-only,
         * so it never re-creates the DOM and never kills the segmented-toggle CSS
         * transition. No-op when the settings panel isn't rendered yet.
         */
        syncValues(data) {
            if (!this.container || this.container.children.length === 0) return;
            this._applyValues(data);
        }

        syncSelectors(dSel, pSel) {
            Array.from(dSel.options).forEach(opt => opt.disabled = (pSel.value !== 'off' && opt.value === pSel.value));
            Array.from(pSel.options).forEach(opt => {
                if (opt.value !== 'off') opt.disabled = (opt.value === dSel.value);
            });
        }
    }

    window.ILAP_Settings = { create: (root) => new SettingsManager(root) };

})();
