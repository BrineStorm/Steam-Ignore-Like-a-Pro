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
        DQ_OPEN: 'ilap_dq_open',
        MI_OPEN: 'ilap_mi_open',
        // The AI tab's checkboxes: keep AI games of that kind out of the AI
        // lists. Off unless set, so read with a strict `=== true` (not isOn).
        AI_KEEP_TRANSLATION: 'ilap_ai_keep_translation',
        AI_KEEP_INGAME: 'ilap_ai_keep_ingame',
        // The AI tab's level (AI_LEVELS): what store pages do with AI games,
        // from nothing to the ignore queue. Read through normalizeAiLevel.
        AI_LEVEL: 'ilap_ai_level',
        // How a game shot while browsing is drawn (SHOTS).
        AI_SHOT: 'ilap_ai_shot',
        // The emoji the 'emoji' shot stamps (SHOT_EMOJI), read through normalizeShotEmoji.
        AI_SHOT_EMOJI: 'ilap_ai_shot_emoji',
        // How many games the browsing switch has shot, across pages and tabs:
        // every 67th one is the 67 (manual-ignore/shot.js).
        AI_SHOT_COUNT: 'ilap_ai_shot_count',
        // The shot's animation on HIGH. On unless set to false (isOn): off,
        // the badge lands at once, as under reduced motion.
        AI_SHOT_ANIM: 'ilap_ai_shot_anim',
        // The AI note on a game page folded to the flag on the header image,
        // for every game page. Off unless true (manual-ignore/ai-page.js).
        AI_NOTE_COLLAPSED: 'ilap_ai_note_collapsed',
    });

    // The Queue Helper's two modes: ignore bad reviews only, or everything.
    const Q_MODES = Object.freeze({ BAD: 'bad', ALL: 'all' });

    const DEFAULTS = Object.freeze({
        SHORTCUT: 'swipeRight',
        PLATFORM: 'swipeLeft',
        UNIGNORE: 'zigzag',
        Q_MODE: Q_MODES.BAD,
        AI_SHOT: 'ai',
        AI_SHOT_EMOJI: '\u{1F44E}',
    });

    // The AI tab's levels, in slider order. LOW marks AI games, MEDIUM also
    // blurs them, HIGH also ignores them. MAX is only a message in the tab
    // and is never stored.
    const AI_LEVELS = Object.freeze({ OFF: 0, LOW: 1, MEDIUM: 2, HIGH: 3, MAX: 4 });
    // The AI tab's boxes each stored level sets as it is applied (OFF leaves them).
    const AI_LEVEL_KEEP = Object.freeze({
        [AI_LEVELS.LOW]: Object.freeze({ translation: false, ingame: false }),
        [AI_LEVELS.MEDIUM]: Object.freeze({ translation: true, ingame: true }),
        [AI_LEVELS.HIGH]: Object.freeze({ translation: true, ingame: true }),
    });

    // The HIGH level's shot styles, in the AI tab's order (manual-ignore/shot.js).
    // 'emoji' is the picked emoji (SHOT_EMOJI), 'ai' the crossed-out AI mark.
    // 'random' gives each capsule one of the others, its emoji any of the grid.
    // The 67 is no style to pick: every 67th game shot gets it (shot.js).
    const SHOTS = Object.freeze(['emoji', 'swipe', 'ai', 'tomato', 'random']);
    // The emoji the 'emoji' shot can stamp, in the AI tab's grid order. The
    // system's emoji font draws them, so all are old enough for Windows 10,
    // macOS, Android, ChromeOS and Firefox's own emoji font, but the headstone
    // (Emoji 13, the user's pick).
    const SHOT_EMOJI = Object.freeze([
        '\u{1F44E}', '\u{1F4A9}', '\u{1F92E}', '\u{270C}\u{FE0F}', '\u{1F5D1}\u{FE0F}',
        '\u{1F644}', '\u{1F634}', '\u{1F971}', '\u{1F480}', '\u{2620}\u{FE0F}',
        '\u{1F47B}', '\u{1F916}', '\u{1F6AB}', '\u{274C}', '\u{1F6D1}',
        '\u{26A0}\u{FE0F}', '\u{1F4B8}', '\u{1F40C}', '\u{1F9FB}', '\u{1FAA6}',
    ]);

    // The bindings fired by a right-button gesture; the rest are modifier-clicks.
    const GESTURES = Object.freeze(['swipeRight', 'swipeLeft', 'zigzag']);
    // Every binding the three gesture selects offer, in menu order; OFF is the
    // shared "no binding".
    const BINDINGS = Object.freeze(GESTURES.concat(['ctrlKey', 'shiftKey', 'altKey']));
    const OFF = 'off';
    const UNIGNORE_KEYS = Object.freeze(BINDINGS.concat(OFF));

    // Switches default to on: only an explicit false turns one off.
    const isOn = (value) => value !== false;

    // Values older builds wrote into the two ignore-binding keys.
    const LEGACY_SHORTCUTS = { swipeRightRight: 'swipeRight', swipeRightLeft: 'swipeLeft' };
    // Legacy first, then the same clamp normalizeUnignore applies: a value from
    // no build we ever shipped is null, so the reader falls back instead of
    // keeping it. Kept, it would reach `event[key]` as undefined (a gesture
    // dead with no symptom) and a <select> with no such option, i.e. blank.
    const isBinding = (v) => BINDINGS.includes(v) || v === OFF;
    const normalizeShortcut = (value) => {
        const v = LEGACY_SHORTCUTS[value] || value;
        return isBinding(v) ? v : null;
    };

    // The un-ignore binding has no legacy values; one it does not know (a
    // hand-edited key) is null, so the reader keeps what it has.
    const normalizeUnignore = (value) => (UNIGNORE_KEYS.includes(value) ? value : null);

    // A shot style this build does not know falls back to the default.
    const normalizeShot = (value) => (SHOTS.includes(value) ? value : DEFAULTS.AI_SHOT);
    // So does an emoji that is not in the grid.
    const normalizeShotEmoji = (value) => (SHOT_EMOJI.includes(value) ? value : DEFAULTS.AI_SHOT_EMOJI);

    // No stored level is LOW, the default. So is one this build does not know
    // (MAX among them). OFF is stored as 0 once picked.
    const normalizeAiLevel = (value) =>
        (Number.isInteger(value) && value >= AI_LEVELS.OFF && value < AI_LEVELS.MAX ? value : AI_LEVELS.LOW);

    window.ILAP = window.ILAP || {};
    window.ILAP.Settings = Object.freeze({
        KEYS, DEFAULTS, Q_MODES, GESTURES, BINDINGS, OFF, UNIGNORE_KEYS, SHOTS, SHOT_EMOJI, AI_LEVELS, AI_LEVEL_KEEP,
        isOn, normalizeShortcut, normalizeUnignore, normalizeShot, normalizeShotEmoji, normalizeAiLevel,
    });
})();
