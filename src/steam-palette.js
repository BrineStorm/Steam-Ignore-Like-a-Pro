// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};

    // Steam's review-score palette, exposed as window.ILAP.SteamPalette and read
    // by BOTH classifiers: the Explore Queue's ReviewAnalyzer (app page, the
    // .game_review_summary rows) and the Discovery Queue's SlideScanner (the
    // modal card). It used to be two tables that drifted apart, and the drift
    // shipped: DQ kept the shades it was first probed at while Steam repainted
    // the modal, so Keep High Score silently stopped ignoring anything. Steam
    // itself now paints one palette on the app page, the DQ modal and its newer
    // React surfaces alike, so one table is also the honest description.
    //
    // A pure constant crossing worlds, like src/escape.js — not storage plumbing
    // and not a POST, which is why this one definition does not cut against the
    // deliberate per-world duplication elsewhere.
    //
    // EACH BAND IS A SET, most recent first. Extra entries are shades Steam
    // painted BEFORE the current one: they cost nothing (classification is
    // fail-safe — a colour that matches nothing is SPARED, so a stale entry can
    // only restore recognition, never invent it) and they mean a rollback, a
    // partial rollout or a stale cached stylesheet does not silently disable
    // ignoring for the user. The canary deliberately does NOT accept the older
    // entries: the product survives a repaint quietly, the guard must still
    // report it (tests/canary/steam-markup.spec.js).
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
