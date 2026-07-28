// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};

    // Which surface hosts the popup UI: the on-page shadow-DOM widget (default)
    // or the browser-toolbar action popup. One shared key, read by the widget,
    // the curator enqueue button, the settings toggle and popup.html itself.
    const KEY = 'ilap_surface_mode';

    // The Steam desktop client (CEF) has no browser toolbar, so the action popup
    // is unreachable there — the widget is forced regardless of the stored value
    // (which is never rewritten; the client profile has its own chrome.storage).
    // Candidate signature, pending confirmation via a live probe in the client.
    const CLIENT_UA = /Valve Steam/i;

    // Escape hatch from a popup mode whose popup turned out unreachable: this
    // rare hotkey, pressed on any store page, flips the surface back to the
    // widget (see the keydown listener in src/widget/main.js). Ctrl+Alt+Shift
    // deliberately clears the browser's own namespace (DevTools is Ctrl+Shift+I),
    // and the match is on e.code, so an AltGr layout that turns Ctrl+Alt+I into a
    // character still triggers it.
    const ESCAPE_HOTKEY_LABEL = 'Ctrl+Alt+Shift+I';
    // Same physical keys, macOS glyphs: "Ctrl+Alt" there sends people looking for
    // keys their keyboard doesn't label.
    const ESCAPE_HOTKEY_LABEL_MAC = '⌃⌥⇧I';
    const MAC_UA = /Mac OS X|Macintosh/i;

    function isSteamClientUA(ua) {
        return CLIENT_UA.test(String(ua || ''));
    }

    function isMacUA(ua) {
        return MAC_UA.test(String(ua || ''));
    }

    function escapeHotkeyLabel(ua) {
        return isMacUA(ua) ? ESCAPE_HOTKEY_LABEL_MAC : ESCAPE_HOTKEY_LABEL;
    }

    // Stored value + user agent → effective mode.
    function resolve(stored, ua) {
        return (stored === 'popup' && !isSteamClientUA(ua)) ? 'popup' : 'widget';
    }

    function isEscapeHotkey(e) {
        return !!e && e.ctrlKey === true && e.altKey === true && e.shiftKey === true && e.code === 'KeyI';
    }

    // Mouse twin of the escape hotkey: a shift-click on the parked ghost chevron.
    // The hotkey is an ordinary page keydown, so anything that claims the combo
    // upstream — an OS shortcut, a window manager, a launcher app — swallows it
    // before the page ever sees it, and we have no way to detect that. A gesture
    // on our own element can't be taken away, so it's the escape hatch's escape
    // hatch. Modifier-only check: the element it's wired to is the ghost chevron,
    // which is inert on a plain click.
    function isEscapeClick(e) {
        return !!e && e.shiftKey === true;
    }

    window.ILAP.Surface = {
        KEY, ESCAPE_HOTKEY_LABEL, ESCAPE_HOTKEY_LABEL_MAC,
        isSteamClientUA, isMacUA, escapeHotkeyLabel,
        resolve, isEscapeHotkey, isEscapeClick,
    };
})();
