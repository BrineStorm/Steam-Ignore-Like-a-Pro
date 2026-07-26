// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The extension's string-boundary hygiene, exposed as window.ILAP.Sanitizer
    // and shared by ALL THREE worlds: loaded before src/utils.js in the
    // content_scripts list, first in popup.html (which does not load utils.js),
    // and first in the service worker's importScripts (which loads neither).
    // Everything here is pure string work with no chrome.* or DOM dependency —
    // that is exactly why it can be one definition, unlike the storage shims and
    // lease math that are knowingly duplicated per world (see the canonical note
    // in src/curator/store.js).
    function escapeHTML(str) {
        // Only "nothing to render" becomes the empty string: a falsy-but-real
        // value (0, false) must survive as its own text, or a caller escaping a
        // count silently loses the zero.
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Plain-text boundary normalizer for names captured from Steam's DOM (game
    // titles, curator names) before they are persisted to storage. Render paths
    // already escape, but stripping tag delimiters + control chars and clamping
    // length HERE means a future render path that forgets to escape can't become
    // a stored-XSS sink, and a pathological name can't bloat storage.
    const NAME_MAX_LEN = 120;
    function sanitizeName(str, maxLen) {
        return String(str == null ? '' : str)
            .replace(/[<>]/g, '')                    // no tag delimiters survive
            .replace(/\p{Cc}/gu, ' ')                 // drop control chars
            .replace(/\s+/g, ' ')                    // collapse runs of whitespace
            .trim()
            .slice(0, maxLen || NAME_MAX_LEN);
    }

    window.ILAP = window.ILAP || {};
    window.ILAP.Sanitizer = window.ILAP.Sanitizer || {};
    window.ILAP.Sanitizer.escapeHTML = escapeHTML;
    window.ILAP.Sanitizer.sanitizeName = sanitizeName;

})();
