// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};

    // Steam's review-score palette, one table for both classifiers: the Explore
    // Queue's ReviewAnalyzer (app page) and the Discovery Queue's SlideScanner
    // (modal card). Steam paints one palette on both.
    //
    // Each band is a set, current shade first. Older shades keep a rollback or a
    // stale stylesheet from disabling ignoring, and cost nothing: a colour that
    // matches nothing is spared. The canary checks the current shade only, so a
    // repaint is still reported (tests/canary/steam-markup.spec.js).
    const SteamPalette = {
        BLUE: [
            'rgb(102, 192, 244)',
        ],
        MIXED: [
            'rgb(185, 160, 116)',   // #b9a074
            'rgb(163, 139, 90)',    // #a38b5a — previous
        ],
        NEGATIVE: [
            'rgb(200, 94, 45)',     // #c85e2d
            'rgb(163, 76, 37)',     // #a34c25 — previous
        ],
    };

    // Every shade that condemns a game, flattened once. "Bad" is Mixed or
    // Negative and nothing else: too-few-reviews grey and any unknown colour
    // stay SPARE by construction.
    const BAD_COLORS = [].concat(SteamPalette.MIXED, SteamPalette.NEGATIVE);

    SteamPalette.isBad = function(color) {
        return BAD_COLORS.indexOf(color) !== -1;
    };

    // The shade a band is painted RIGHT NOW — what a live guard asserts against.
    SteamPalette.current = function(band) {
        const set = SteamPalette[band];
        return Array.isArray(set) ? set[0] : null;
    };

    window.ILAP.SteamPalette = SteamPalette;
})();
