// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The user's settings: storage keys, defaults and the normalizers every
    // reader applies. Pure, loaded in all three worlds, so no reader spells a
    // key or a default of its own.

    const KEYS = Object.freeze({
        MASTER: 'ilap_master_enabled',
        SHORTCUT: 'ilap_shortcut_key',
        PLATFORM: 'ilap_platform_key',
        UNIGNORE: 'ilap_unignore_key',
        MASK: 'ilap_mask_enabled',
        Q_MASTER: 'ilap_q_master',
        Q_NEXT: 'ilap_q_next',
        Q_MODE: 'ilap_q_mode',
        LANG: 'ilap_lang',
        SETTINGS_OPEN: 'ilap_settings_open',
        DQ_OPEN: 'ilap_dq_open',
        MI_OPEN: 'ilap_mi_open',
    });

    // The Queue Helper's two modes: ignore bad reviews only, or everything.
    const Q_MODES = Object.freeze({ BAD: 'bad', ALL: 'all' });

    const DEFAULTS = Object.freeze({
        SHORTCUT: 'swipeRight',
        PLATFORM: 'swipeLeft',
        UNIGNORE: 'zigzag',
        Q_MODE: Q_MODES.BAD,
    });

    // Every binding the three gesture selects offer, in menu order; OFF is the
    // shared "no binding".
    const BINDINGS = Object.freeze(['swipeRight', 'swipeLeft', 'zigzag', 'ctrlKey', 'shiftKey', 'altKey']);
    const OFF = 'off';
    const UNIGNORE_KEYS = Object.freeze(BINDINGS.concat(OFF));

    // Switches default to on: only an explicit false turns one off.
    const isOn = (value) => value !== false;

    // Values older builds wrote into the two ignore-binding keys.
    const LEGACY_SHORTCUTS = { swipeRightRight: 'swipeRight', swipeRightLeft: 'swipeLeft' };
    // Legacy first, then the same clamp normalizeUnignore applies: a value from
    // no build we ever shipped is null, so the reader falls back instead of
    // carrying it. Unclamped it reached `event[key]` as undefined — a gesture
    // dead with no symptom — and a <select> with no such option, i.e. blank.
    const isBinding = (v) => BINDINGS.includes(v) || v === OFF;
    const normalizeShortcut = (value) => {
        const v = LEGACY_SHORTCUTS[value] || value;
        return isBinding(v) ? v : null;
    };

    // The un-ignore binding has no legacy values; one it does not know (a
    // hand-edited key) is null, so the reader keeps what it has.
    const normalizeUnignore = (value) => (UNIGNORE_KEYS.includes(value) ? value : null);

    window.ILAP = window.ILAP || {};
    window.ILAP.Settings = Object.freeze({
        KEYS, DEFAULTS, Q_MODES, BINDINGS, OFF, UNIGNORE_KEYS,
        isOn, normalizeShortcut, normalizeUnignore,
    });
})();
