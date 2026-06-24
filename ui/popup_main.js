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

    const t = (k, p) => (window.ILAP && window.ILAP.t) ? window.ILAP.t(k, p) : k;

    const normalizeShortcut = (v) => (window.ILAP && window.ILAP.normalizeShortcut) ? window.ILAP.normalizeShortcut(v) : v;

    // Compact chip label: primary subtag only (pt-BR -> PT, zh-TW -> ZH).
    const langCode = (lang) => String(lang || 'en').split('-')[0].toUpperCase();

    // Mouse glyph with the right button lit — represents the "hold right-click" gesture.
    const mouseRightSvg = () => `
        <svg class="mouse-ico" viewBox="0 0 28 40" width="15" height="21" aria-hidden="true">
          <rect x="2" y="2" width="24" height="36" rx="12" fill="#0d141c" stroke="#3d4a5d" stroke-width="1.6"/>
          <path d="M14.8 2.8 H16 C21 2.8 25.2 7 25.2 12 V18.5 H14.8 Z" fill="#66c0f4"/>
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
              <path d="M4 28 C4 22 8 18 14 18 L23 18 L23 38 L4 38 Z" fill="${!isRight ? '#66c0f4' : '#171a21'}"/>
              <line x1="24" y1="18" x2="24" y2="38" stroke="#3d4a5d" stroke-width="2"/>
              <path d="M25 18 L34 18 C40 18 44 22 44 28 L44 38 L25 38 Z" fill="${isRight ? '#66c0f4' : '#171a21'}"/>
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

    function updateBasicUI(data) {
        const isEnabled = data.ilap_master_enabled !== false;
        
        const master = document.getElementById('master-toggle');
        if (master) master.checked = isEnabled;

        const wrapper = document.getElementById('ui-wrapper');
        if (isEnabled) wrapper.classList.remove('disabled');
        else wrapper.classList.add('disabled');

        document.getElementById('count-link').textContent = data.ilap_ignored_count || 0;
        document.getElementById('last-game').textContent = data.ilap_last_ignored_name || t('none');

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
                const safeEmpty = Sanitizer.escapeHTML(t('no_recent_history'));
                historyDiv.innerHTML = `<div class="history-entry"><i>${safeEmpty}</i></div>`;
            }
        }

        if (window.ILAP && window.ILAP.i18n) window.ILAP.i18n.applyDom(document);

        // Keep the quick language chip in sync with external changes.
        const chip = document.getElementById('lang-quick');
        if (chip && window.ILAP && window.ILAP.i18n) {
            const cur = window.ILAP.i18n.getLang();
            if (chip.value !== cur) chip.value = cur;
            const code = document.getElementById('lang-quick-code');
            if (code) code.textContent = langCode(cur);
        }
    }

    // Populate + wire the language chip sitting inside the SETTINGS summary bar.
    // Clicking it opens the native language list without toggling the accordion.
    function setupLangChip() {
        const chip = document.getElementById('lang-quick');
        const code = document.getElementById('lang-quick-code');
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

        // Stop the summary's click from toggling <details>; the select still opens on mousedown.
        chip.addEventListener('mousedown', (e) => e.stopPropagation());
        chip.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
        chip.addEventListener('change', (e) => {
            if (code) code.textContent = langCode(e.target.value);
            chrome.storage.local.set({ ilap_lang: e.target.value });
            chip.blur(); // shrink back so it stops overlapping the settings bar
        });

        // Clicking anywhere outside the chip drops focus, so the widened select can't
        // keep intercepting clicks meant for the settings toggle.
        document.addEventListener('mousedown', (e) => {
            if (document.activeElement === chip && !chip.parentElement.contains(e.target)) chip.blur();
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        chrome.storage.local.get(null, (res) => {
            if (window.ILAP && window.ILAP.i18n && res.ilap_lang) {
                window.ILAP.i18n.setLang(res.ilap_lang);
            }
            setupLangChip();
            updateBasicUI(res);

            const accordion = document.getElementById('settings-accordion');
            accordion.open = !!res.ilap_settings_open;
            if (accordion.open && window.ILAP_Settings) {
                window.ILAP_Settings.init();
            }

            accordion.addEventListener('toggle', () => {
                chrome.storage.local.set({ ilap_settings_open: accordion.open });
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

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area && area !== 'local') return;
        chrome.storage.local.get(null, (current) => {
            if (window.ILAP && window.ILAP.i18n && current.ilap_lang) {
                window.ILAP.i18n.setLang(current.ilap_lang);
            }
            updateBasicUI(current);
            // Only rebuild the settings panel when the language actually changed.
            // Rebuilding on every storage write (e.g. the mode toggle) recreates the
            // DOM mid-interaction and kills CSS transitions like the segmented slider.
            if (changes && changes.ilap_lang && window.ILAP_Settings && window.ILAP_Settings.relabel) {
                window.ILAP_Settings.relabel(current);
            }
        });
    });

})();