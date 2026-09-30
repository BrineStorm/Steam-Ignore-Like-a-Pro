// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Inline SVG glyphs drawn by more than one UI file, one drawing each. Loaded in
    // the content-script world (before src/curator/main.js and the ui/popup_* files)
    // and in popup.html (before the ui/popup_* files).

    // Queue job actions: the curator droplist rows and the queue applet rows.
    const PAUSE = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';
    const PLAY = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
    const TRASH = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9zm4 2v8h1v-8h-1zm3 0v8h1v-8h-1z"/></svg>';

    // The swipe glyph: a gradient swoosh arrow, flipped for a left swipe. `gradientId`
    // must be unique in its document — several swooshes share one panel.
    function swoosh({ isRight, gradientId, cls, width, height }) {
        const flip = isRight ? '' : ' style="transform:scaleX(-1)"';
        return `<svg class="${cls}" viewBox="0 0 34 16" width="${width}" height="${height}" aria-hidden="true"${flip}>`
            + `<defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="0">`
            + '<stop offset="0" stop-color="#3ca8fc" stop-opacity="0"/>'
            + '<stop offset=".5" stop-color="#3ca8fc" stop-opacity=".85"/>'
            + '<stop offset="1" stop-color="#3ca8fc"/>'
            + '</linearGradient></defs>'
            + `<path d="M2 8 C9 6.6 14 6.6 19 7.2 L19 2.5 L32 8 L19 13.5 L19 8.8 C14 9.4 9 9.4 2 8 Z" fill="url(#${gradientId})"/>`
            + '</svg>';
    }

    // The circle gesture's glyph: an open ring closing counter-clockwise into an
    // arrowhead. The direction is a drawing choice, not a rule — the detector reads
    // the X axis alone, so either rotation fires (see ZigzagTracker).
    function ring({ gradientId, cls, size }) {
        return `<svg class="${cls}" viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true">`
            + `<defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="0">`
            + '<stop offset="0" stop-color="#3ca8fc" stop-opacity=".35"/>'
            + '<stop offset="1" stop-color="#3ca8fc"/>'
            + '</linearGradient></defs>'
            + `<path d="M5.4 6.64 A6 6 0 1 0 10 4.5" fill="none" stroke="url(#${gradientId})" stroke-width="2.4" stroke-linecap="round"/>`
            + '<path d="M0,-2.6 L4.6,0 L0,2.6 Z" fill="#3ca8fc" transform="translate(10,4.5) rotate(180)"/>'
            + '</svg>';
    }

    window.ILAP_Icons = { PAUSE, PLAY, TRASH, swoosh, ring };
})();
