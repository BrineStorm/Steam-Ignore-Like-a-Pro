// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Shared HTML-escaper (src/escape.js, loaded first in popup.html + content_scripts).
    const Sanitizer = window.ILAP.Sanitizer;

    const t = (k, p) => (window.ILAP && window.ILAP.t) ? window.ILAP.t(k, p) : k;

    const normalizeShortcut = (v) => (window.ILAP && window.ILAP.normalizeShortcut) ? window.ILAP.normalizeShortcut(v) : v;

    // Compact chip label: primary subtag only (pt-BR -> PT, zh-TW -> ZH).
    const langCode = (lang) => String(lang || 'en').split('-')[0].toUpperCase();

    // Mouse glyph with the right button lit — represents the "hold right-click" gesture.
    const mouseRightSvg = () => `
        <svg class="mouse-ico" viewBox="0 0 28 40" width="15" height="21" aria-hidden="true">
          <rect x="2" y="2" width="24" height="36" rx="12" fill="#0d141c" stroke="#3d4a5d" stroke-width="1.6"/>
          <path d="M14.8 2.8 H16 C21 2.8 25.2 7 25.2 12 V18.5 H14.8 Z" fill="#45A1FA"/>
          <line x1="14" y1="3" x2="14" y2="18.5" stroke="#3d4a5d" stroke-width="1.4"/>
          <rect x="11.6" y="7" width="4.8" height="9" rx="2.4" fill="#cfe9fb"/>
        </svg>`;

    // Gradient swoosh arrow; flipped horizontally for a left swipe.
    const swooshSvg = (isRight, slot) => {
        const gid = 'swoosh-' + slot;
        const flip = isRight ? '' : ' style="transform:scaleX(-1)"';
        return `
        <svg class="sw-arrow" viewBox="0 0 34 16" width="30" height="15" aria-hidden="true"${flip}>
          <defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#3ca8fc" stop-opacity="0"/>
            <stop offset=".5" stop-color="#3ca8fc" stop-opacity=".85"/>
            <stop offset="1" stop-color="#3ca8fc"/>
          </linearGradient></defs>
          <path d="M2 8 C9 6.6 14 6.6 19 7.2 L19 2.5 L32 8 L19 13.5 L19 8.8 C14 9.4 9 9.4 2 8 Z" fill="url(#${gid})"/>
        </svg>`;
    };

    // Build "Hold [mouse] & Swipe [swoosh]" from the localized label, dropping its
    // trailing text arrow in favour of the SVG swoosh.
    function gestureChip(labelKey, isRight, slot) {
        const stripped = t(labelKey).replace(/\s*[→←➜]\s*$/, '').trim();
        const sp = stripped.indexOf(' ');
        const first = sp === -1 ? stripped : stripped.slice(0, sp);
        const rest = sp === -1 ? '' : stripped.slice(sp + 1);
        let inner = `${Sanitizer.escapeHTML(first)}${mouseRightSvg()}`;
        if (rest) inner += Sanitizer.escapeHTML(rest);
        inner += swooshSvg(isRight, slot);
        return `<span class="kbd-key" style="margin-left:0;">${inner}</span>`;
    }

    function getShortcutHintHtml(key, slot) {
        const mouseIcon = (isRight) => `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 14 48 54" width="16" height="18" fill="none" class="mouse-icon">
              <rect x="4" y="18" width="40" height="46" rx="20" ry="20" fill="#1b2838" stroke="#3d4a5d" stroke-width="2"/>
              <path d="M4 28 C4 22 8 18 14 18 L23 18 L23 38 L4 38 Z" fill="${!isRight ? '#45A1FA' : '#171a21'}"/>
              <line x1="24" y1="18" x2="24" y2="38" stroke="#3d4a5d" stroke-width="2"/>
              <path d="M25 18 L34 18 C40 18 44 22 44 28 L44 38 L25 38 Z" fill="${isRight ? '#45A1FA' : '#171a21'}"/>
              <rect x="21" y="22" width="6" height="12" rx="3" fill="#ffffff" opacity="0.85"/>
              <path d="M4 42 L4 46 C4 57 14 64 24 64 C34 64 44 57 44 46 L44 42 Z" fill="#171a21"/>
            </svg>
        `;

        if (key === 'swipeRight') return gestureChip('hold_and_swipe_right', true, slot);
        if (key === 'swipeLeft') return gestureChip('hold_and_swipe_left', false, slot);

        const names = { 'ctrlKey': 'Ctrl', 'shiftKey': 'Shift', 'altKey': 'Alt' };

        const safeKeyName = Sanitizer.escapeHTML(names[key] || key);
        const safeLeftClick = Sanitizer.escapeHTML(t('left_click'));
        return `<span class="kbd-key" style="margin-left:0;">${safeKeyName}</span> <span style="margin: 0 4px;">+</span> <span class="kbd-key">${safeLeftClick}</span> ${mouseIcon(false)}`;
    }

    function updateBasicUI(root, data) {
        const isEnabled = data.ilap_master_enabled !== false;

        const master = root.getElementById('master-toggle');
        if (master) master.checked = isEnabled;

        const wrapper = root.getElementById('ui-wrapper');
        if (isEnabled) wrapper.classList.remove('disabled');
        else wrapper.classList.add('disabled');

        root.getElementById('count-link').textContent = data.ilap_ignored_count || 0;
        root.getElementById('last-game').textContent = data.ilap_last_ignored_name || t('none');

        const defKey = normalizeShortcut(data.ilap_shortcut_key) || 'swipeRight';
        const platKey = normalizeShortcut(data.ilap_platform_key) || 'swipeLeft';

        const safeIgnoreLabel = Sanitizer.escapeHTML(t('hint_ignore'));
        const safeAlreadyPlayedLabel = Sanitizer.escapeHTML(t('hint_already_played'));

        let hintHtml = `
            <div class="hint-line">
                <span class="hint-label">${safeIgnoreLabel}</span>
                ${getShortcutHintHtml(defKey, 'def')}
            </div>
        `;

        if (platKey !== 'off') {
            hintHtml += `
                <div class="hint-line" style="margin-top: 8px;">
                    <span class="hint-label" style="color: #3ca8fc;">${safeAlreadyPlayedLabel}</span>
                    ${getShortcutHintHtml(platKey, 'plat')}
                </div>
            `;
        }

        const hintContainer = root.getElementById('dynamic-hint');
        if (hintContainer) {
            hintContainer.innerHTML = hintHtml;
        }

        const history = data.ilap_ignored_history || [];
        const historyDiv = root.getElementById('history-list');
        if (historyDiv) {
            if (history.length > 0) {
                // innerHTML needs sanitization
                historyDiv.innerHTML = history.slice(0, 3).map(i => {
                    const safeGameName = Sanitizer.escapeHTML(i.name);
                    return `<div class="history-entry">• ${safeGameName}</div>`;
                }).join('');
            } else {
                const safeEmpty = Sanitizer.escapeHTML(t('no_recent_history'));
                historyDiv.innerHTML = `<div class="history-entry"><i>${safeEmpty}</i></div>`;
            }
        }

        if (window.ILAP && window.ILAP.i18n) window.ILAP.i18n.applyDom(root);

        // Keep the quick language chip in sync with external changes.
        const chip = root.getElementById('lang-quick');
        if (chip && window.ILAP && window.ILAP.i18n) {
            const cur = window.ILAP.i18n.getLang();
            if (chip.value !== cur) chip.value = cur;
            const code = root.getElementById('lang-quick-code');
            if (code) code.textContent = langCode(cur);
        }
    }

    // Populate + wire the language chip sitting inside the SETTINGS summary bar.
    // The native <select> stays as the inert value store (opacity 0, no pointer
    // events — same pattern as the settings shortcut selects, and the element the
    // language tests drive); the visible list is our own styled .select-menu, so
    // the OS-rendered dropdown (white flash, unstylable edges) never shows. This
    // also retires the old focus-trap workaround: the select no longer widens on
    // focus, so it can never overlap the SETTINGS bar and swallow its clicks.
    function setupLangChip(root) {
        const chip = root.getElementById('lang-quick');
        const code = root.getElementById('lang-quick-code');
        if (!chip || !window.ILAP || !window.ILAP.i18n) return;

        // List shows full native names; the chip itself only ever shows the short code.
        chip.innerHTML = window.ILAP.i18n.getLanguages()
            .filter(l => l.translated)
            .map(l => {
                const label = l.beta ? `${l.name} (beta)` : l.name;
                return `<option value="${Sanitizer.escapeHTML(l.code)}">${Sanitizer.escapeHTML(label)}</option>`;
            })
            .join('');
        const cur = window.ILAP.i18n.getLang();
        chip.value = cur;
        if (code) code.textContent = langCode(cur);

        chip.addEventListener('change', (e) => {
            if (code) code.textContent = langCode(e.target.value);
            chrome.storage.local.set({ ilap_lang: e.target.value });
        });

        const wrap = chip.parentElement; // .lang-chip (position:relative anchor)
        const menu = document.createElement('div');
        menu.className = 'select-menu lang-menu';
        wrap.appendChild(menu);

        // The chip lives inside the SETTINGS <summary>: preventDefault stops the
        // native accordion toggle, stopPropagation keeps the exclusive-collapse
        // logic and the outside-click menu closer (SettingsManager) out of it.
        wrap.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.target.closest('.select-opt')) return; // picks are handled below
            const wasOpen = menu.classList.contains('open');
            root.querySelectorAll('.select-menu.open').forEach(m => m.classList.remove('open'));
            if (wasOpen) return;
            menu.innerHTML = Array.from(chip.options).map(opt =>
                `<div class="select-opt${opt.value === chip.value ? ' selected' : ''}" data-value="${Sanitizer.escapeHTML(opt.value)}">${Sanitizer.escapeHTML(opt.textContent)}</div>`
            ).join('');
            menu.classList.add('open');
            // Centre the current language in the scrollable list (menu.scrollTop,
            // NOT scrollIntoView — that would also scroll the popup body).
            const sel = menu.querySelector('.select-opt.selected');
            if (sel) menu.scrollTop = sel.offsetTop - (menu.clientHeight - sel.offsetHeight) / 2;
        });

        menu.addEventListener('click', (e) => {
            const item = e.target.closest('.select-opt');
            if (!item) return;
            menu.classList.remove('open');
            const val = item.getAttribute('data-value');
            if (val !== chip.value) {
                chip.value = val;
                chip.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
    }

    // Wire the popup UI against a query root: `document` for the browser popup
    // window, or a shadowRoot for the on-page widget. Both are views over the
    // same chrome.storage.local — the single source of truth.
    function initPopup(root) {
        const settings = window.ILAP_Settings.create(root);
        const queue = window.ILAP_Queue ? window.ILAP_Queue.create(root) : null;

        chrome.storage.local.get(null, (res) => {
            if (window.ILAP && window.ILAP.i18n && res.ilap_lang) {
                window.ILAP.i18n.setLang(res.ilap_lang);
            }

            const icon = root.getElementById('ilap-header-icon');
            if (icon) icon.src = chrome.runtime.getURL('assets/icons/icon48.png');

            setupLangChip(root);
            updateBasicUI(root, res);
            if (queue) queue.render(res);

            const accordion = root.getElementById('settings-accordion');
            const queueAcc = root.getElementById('queue-accordion');
            accordion.open = !!res.ilap_settings_open;
            if (accordion.open) settings.init();

            // The two applets are mutually exclusive: opening one collapses the other.
            // We only act on the open transition, so closing the other can't loop back.
            accordion.addEventListener('toggle', () => {
                chrome.storage.local.set({ ilap_settings_open: accordion.open });
                if (accordion.open) {
                    settings.init();
                    if (queueAcc) queueAcc.open = false;
                }
            });

            if (queueAcc) {
                queueAcc.addEventListener('toggle', () => {
                    if (queueAcc.open) accordion.open = false;
                });
            }

            // Collapse the sibling SYNCHRONOUSLY on the summary click (shared helper;
            // see wireExclusiveDetails in popup_settings.js for why in-frame). The
            // `toggle` handlers above still own persistence + lazy settings.init()
            // (and the lang-chip open path), so those keep working. The language chip
            // sits in the SETTINGS summary and owns its own click.
            const wireExclusive = window.ILAP_Settings.wireExclusiveDetails;
            wireExclusive(accordion, queueAcc, '.lang-chip');
            wireExclusive(queueAcc, accordion, '.lang-chip');

            root.getElementById('master-toggle').addEventListener('change', (e) => {
                chrome.storage.local.set({ ilap_master_enabled: e.target.checked });
            });

            const rootEl = root.getElementById('popup-root');
            setTimeout(() => rootEl && rootEl.classList.remove('no-transition'), 100);
        });

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area && area !== 'local') return;
            // The queue applet derives progress from the drainer-owned cursor/lock
            // keys (and the pulse), so it must re-render on those; the rest of the
            // popup (stats, hints, history, settings) does not. During a bulk drain
            // those are written 1–3×/s — rebuilding all of that innerHTML each time
            // is pure waste, so skip it when ONLY drain-progress keys changed.
            // ilap_curator_queue itself is NOT a drain-progress key: it feeds the
            // settings surface-guard and job list, so it stays on the full path.
            const isDrainKey = (k) => k === 'ilap_curator_pulse'
                || k.indexOf('ilap_curator_cursor_') === 0
                || k.indexOf('ilap_curator_lock_') === 0;
            const heavyNeeded = Object.keys(changes || {}).some(k => !isDrainKey(k));
            chrome.storage.local.get(null, (current) => {
                if (!heavyNeeded) {
                    if (queue) queue.render(current);
                    return;
                }
                if (window.ILAP && window.ILAP.i18n && current.ilap_lang) {
                    window.ILAP.i18n.setLang(current.ilap_lang);
                }
                // Queue renders AFTER the locale switch — its labels go through t(),
                // so rendering first would leave them in the previous language.
                if (queue) queue.render(current);
                updateBasicUI(root, current);
                // Reflect external setting changes (e.g. EQ "Disable" → q_master=false)
                // onto the open settings panel. Value-only, preserves CSS transitions.
                settings.syncValues(current);
                // Only rebuild the settings panel when the language actually changed.
                // Rebuilding on every storage write (e.g. the mode toggle) recreates the
                // DOM mid-interaction and kills CSS transitions like the segmented slider.
                if (changes && changes.ilap_lang && settings.relabel) {
                    settings.relabel(current);
                }
            });
        });
    }

    window.ILAP_Popup = { init: initPopup };

    // Widget-mode signpost shown in the toolbar popup: the real UI lives on the
    // store pages, so this is just a pointer at the on-page widget plus a button
    // that moves the interface into this popup — guarded by the same
    // "popup mode ⇒ empty curator queue" invariant as the settings toggle.
    function renderPopupStub(mount) {
        mount.innerHTML = `
            <div id="ilap-popup-stub">
                <img src="${chrome.runtime.getURL('assets/icons/icon48.png')}" alt="">
                <p id="ilap-stub-msg" data-i18n="popup_stub_message"></p>
                <span id="ilap-stub-btnwrap">
                    <button type="button" id="ilap-stub-switch" data-i18n="popup_stub_switch"></button>
                </span>
            </div>`;
        if (window.ILAP && window.ILAP.i18n) window.ILAP.i18n.applyDom(mount);

        const btn = mount.querySelector('#ilap-stub-switch');
        // A disabled <button> receives no hover events, so its title never shows —
        // carry the "why is this locked" tooltip on the always-hoverable wrapper.
        const btnWrap = mount.querySelector('#ilap-stub-btnwrap');
        const Store = window.ILAP.Curator && window.ILAP.Curator.Store;
        const syncGuard = () => {
            if (!Store) return;
            Store.getQueue().then((queue) => {
                btn.disabled = queue.length > 0;
                btn.style.opacity = btn.disabled ? '.55' : '';
                btn.style.cursor = btn.disabled ? 'default' : 'pointer';
                if (btn.disabled) btnWrap.title = t('surface_popup_blocked');
                else btnWrap.removeAttribute('title');
            });
        };
        syncGuard();
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area && area !== 'local') return;
            if (changes.ilap_curator_queue) syncGuard();
        });
        btn.addEventListener('click', () => {
            if (!Store) return;
            // Disabled covers the common case; re-check for a queue staged
            // since the last sync before committing the switch.
            Store.getQueue().then((queue) => {
                if (queue.length > 0) { syncGuard(); return; }
                chrome.storage.local.set({ [window.ILAP.Surface.KEY]: 'popup' });
            });
        });
    }

    // Browser-popup bootstrap: mount the shared markup into the popup window and
    // wire it against `document`. On a Steam page there is no mount point, so this
    // is a no-op there — the widget mounts and inits its own shadow root instead.
    // The view depends on the surface mode: in widget mode the popup is only a
    // signpost (stub) pointing at the on-page widget; in popup mode it hosts the
    // full UI. A surface flip simply reloads the window — the popup is stateless,
    // so re-bootstrapping beats swapping live views (and their listeners) in place.
    function bootstrapPopupWindow() {
        const mount = document.getElementById('ilap-popup-mount');
        if (!mount || mount.dataset.ilapMounted) return;
        mount.dataset.ilapMounted = '1';

        const Surface = window.ILAP.Surface;
        chrome.storage.local.get({ [Surface.KEY]: 'widget', ilap_lang: null, ilap_update_glow: false }, (res) => {
            if (window.ILAP && window.ILAP.i18n && res.ilap_lang) {
                window.ILAP.i18n.setLang(res.ilap_lang);
            }
            const mode = Surface.resolve(res[Surface.KEY], navigator.userAgent);
            if (mode === 'popup') {
                mount.innerHTML = window.ILAP_PopupMarkup;
                initPopup(document);
                // One-shot post-update welcome (armed by src/migrate.js on the
                // popup-migration update only): a 5 s gold wash over the popup.
                if (res.ilap_update_glow) {
                    const rootEl = document.getElementById('popup-root');
                    if (rootEl) rootEl.classList.add('update-glow'); // animation ends transparent; no cleanup needed
                }
            } else {
                renderPopupStub(mount);
            }
            // Consume the flag on the FIRST bootstrap, whatever it rendered: a
            // reopen (even within the 5 s) must not replay the glow, and a user
            // who reached widget mode before ever opening the popup has plainly
            // found the extension — their stale flag is retired silently here.
            if (res.ilap_update_glow) chrome.storage.local.set({ ilap_update_glow: false });
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area && area !== 'local') return;
                if (!changes[Surface.KEY]) return;
                if (Surface.resolve(changes[Surface.KEY].newValue, navigator.userAgent) !== mode) {
                    location.reload();
                }
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrapPopupWindow);
    } else {
        bootstrapPopupWindow();
    }

})();