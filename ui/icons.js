// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Inline SVG glyphs drawn by more than one UI file, one drawing each. Loaded in
    // the content-script world and in popup.html, before the ui/popup_* files.

    // Queue job actions: the queue applet rows.
    const PAUSE = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';
    const PLAY = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
    const TRASH = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9zm4 2v8h1v-8h-1zm3 0v8h1v-8h-1z"/></svg>';

    // The built-in lists: a list with a blue plus at its lower right, under the
    // ends of the upper two lines, which reach a little further than the bottom
    // one, up to the plus. The lines darken toward the bottom. The plus is lit
    // from above (a gradient down it, a shadow under it in popup.css). On the
    // queue bar's icon and in the empty queue's hint that points at it, where
    // the CSS draws the plus flat grey (popup.css .ico-plus).
    const lines = (end) => `<g class="ico-lines" fill="currentColor"><path d="M2 2H${end}v2.4H2z"/><path fill-opacity=".7" d="M2 6.8H${end}v2.4H2z"/><path fill-opacity=".42" d="M2 11.6h13V14H2z"/></g>`;
    const PRESETS = '<svg viewBox="0.6 0 29 16" width="28" height="14" aria-hidden="true">'
        + '<defs><linearGradient id="ilap-plus-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b5e2ff"/><stop offset=".45" stop-color="#5cc0ff"/><stop offset="1" stop-color="#1f7fd0"/></linearGradient></defs>'
        + lines(21) + '<path class="ico-plus" fill="url(#ilap-plus-fill)" d="M19 10.2h3V7.2h2.8v3h3V13h-3v3h-2.8v-3h-3z"/></svg>';
    // An un-ignore job: the same list with the Undo button's turning arrow in
    // green where the plus is. Its lines stay short, clear of the arrowhead.
    // In the history.
    const UNIGNORE = '<svg class="ico-wide" viewBox="0.25 0 28.5 16" width="20" height="10" aria-hidden="true">' + lines(15)
        + '<path fill="#4fd64f" transform="translate(15.5 4.7) scale(.5)" d="M12 5V1.8L6.5 6.5 12 11.2V8c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8z"/></svg>';
    // The list alone, with no plus: a queued job that came from one of those lists.
    const LIST = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M0 2h16v2.4H0zM0 6.8h16v2.4H0zM0 11.6h10V14H0z"/></svg>';
    // A bundle: two capsules, one behind the other. A queued bundle job and its history entry.
    const BUNDLE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" opacity=".45" d="M4 1h12v9H4z"/><path fill="currentColor" d="M0 5h12v10H0z"/></svg>';

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

    window.ILAP_Icons = { PAUSE, PLAY, TRASH, PRESETS, UNIGNORE, LIST, BUNDLE, swoosh, ring };
})();
