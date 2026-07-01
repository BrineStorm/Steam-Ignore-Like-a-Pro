// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Single HTML-escaper for the whole extension, exposed as
    // window.ILAP.Sanitizer.escapeHTML. Loaded FIRST in both worlds — before
    // src/utils.js in the content_scripts list, and first in popup.html (which
    // does not load utils.js) — so every content-script module and popup surface
    // shares one definition instead of re-declaring its own copy.
    function escapeHTML(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    window.ILAP = window.ILAP || {};
    window.ILAP.Sanitizer = window.ILAP.Sanitizer || {};
    window.ILAP.Sanitizer.escapeHTML = escapeHTML;

})();
