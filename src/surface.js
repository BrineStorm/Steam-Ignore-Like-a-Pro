// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};

    // Which surface hosts the popup UI: the on-page shadow-DOM widget (default)
    // or the browser-toolbar action popup. One shared key, read by the widget,
    // the curator enqueue button, the settings toggle and popup.html itself.
    const KEY = 'ilap_surface_mode';

    // The Steam desktop client has no toolbar, so the widget is forced there
    // (the stored value is left alone). Signature not yet confirmed in the client.
    const CLIENT_UA = /Valve Steam/i;

    // Escape hatch from an unreachable popup: on any store page this hotkey flips
    // the surface back to the widget. Clear of the browser's own shortcuts, and
    // matched on e.code so an AltGr layout still triggers it.
    const ESCAPE_HOTKEY_LABEL = 'Ctrl+Alt+Shift+I';
    // Same keys, labelled the way a Mac keyboard is.
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

    // The hotkey's mouse twin, a shift-click on the parked chevron, for when
    // something upstream swallows the combo. Modifier-only: the chevron is inert
    // on a plain click.
    function isEscapeClick(e) {
        return !!e && e.shiftKey === true;
    }

    window.ILAP.Surface = {
        KEY, ESCAPE_HOTKEY_LABEL, ESCAPE_HOTKEY_LABEL_MAC,
        isSteamClientUA, isMacUA, escapeHotkeyLabel,
        resolve, isEscapeHotkey, isEscapeClick,
    };
})();
