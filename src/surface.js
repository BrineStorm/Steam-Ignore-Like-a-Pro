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
    // widget (see the keydown listener in src/widget/main.js).
    const ESCAPE_HOTKEY_LABEL = 'Ctrl+Alt+Shift+I';

    function isSteamClientUA(ua) {
        return CLIENT_UA.test(String(ua || ''));
    }

    // Stored value + user agent → effective mode.
    function resolve(stored, ua) {
        return (stored === 'popup' && !isSteamClientUA(ua)) ? 'popup' : 'widget';
    }

    function isEscapeHotkey(e) {
        return !!e && e.ctrlKey === true && e.altKey === true && e.shiftKey === true && e.code === 'KeyI';
    }

    window.ILAP.Surface = { KEY, ESCAPE_HOTKEY_LABEL, isSteamClientUA, resolve, isEscapeHotkey };
})();
