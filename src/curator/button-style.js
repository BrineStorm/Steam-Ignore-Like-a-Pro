// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The stylesheet of the curator button and its menu: it goes on the page with
    // the button and comes off with it.

    window.ILAP = window.ILAP || {};
    window.ILAP.Curator = window.ILAP.Curator || {};

    const BTN_ID = 'ilap-curator-enqueue';
    const STYLE_ID = 'ilap-curator-style';

    // Convex azure button — gradient + inset top highlight (promo slide-05 mock).
    const BTN_BG = 'linear-gradient(180deg, #3aa0ec, #1f7fd6)';
    const BTN_BG_HOVER = 'linear-gradient(180deg, #4bacf2, #2b8ce0)';

    function inject() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            /* Top-align with the curator tabs (Featured/Lists/About). Those tabs
               start at the nav bar's top edge, but .curator_report adds a 6px
               padding-top, so a vertical-align:middle control sits ~6px lower and
               its 32px height then stretches the whole nav bar row. vertical-align:
               top + margin-top:-6px cancels that padding so the button's top edge
               lines up with the tabs and it no longer drags the row taller. */
            .ilap-curator-ctl { position: relative; display: inline-flex; align-items: center; margin-right: 8px; vertical-align: top; margin-top: -6px; }
            /* ILAP logo inside the button, marking this as an extension control. */
            .ilap-cur-logo { width: 22px; height: 22px; border-radius: 6px; display: block; }
            #${BTN_ID} {
                display: inline-flex; align-items: center; gap: 9px;
                /* Convex look: our own gradient + inset top highlight + drop shadow.
                   !important overrides Steam's default button skin. */
                background-color: transparent !important;
                background-image: ${BTN_BG} !important;
                box-shadow: 0 10px 26px rgba(20,90,170,.5), inset 0 1px 0 rgba(255,255,255,.28) !important;
                filter: none !important;
                color: #fff !important; border: none; cursor: pointer;
                font: 700 14px "Motiva Sans", Arial, sans-serif; padding: 0 13px; height: 36px;
                border-radius: 9px; white-space: nowrap;
                /* fitWidth sets a border-box width, and a label that grows ahead
                   of its width animation stays inside the button. */
                box-sizing: border-box; overflow: hidden;
            }
            #${BTN_ID}:hover { background-image: ${BTN_BG_HOVER} !important; }
            #${BTN_ID}:disabled { opacity: .7; cursor: default; }
            /* What this curator has in the queue, before "Added": a square in the
               filter's colour, as on the job's strip in the queue applet. */
            .ilap-cur-sq { width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0; position: relative; }
            .ilap-cur-sq[hidden] { display: none; }
            /* The bar after the logo, in every state: logo | text. */
            .ilap-cur-div { width: 1px; height: 18px; flex-shrink: 0; background: rgba(255,255,255,.35); }
            .ilap-cur-sq::after { content: ''; position: absolute; inset: -4px; }
            /* The square's tip, drawn like the applet's (popup.css .queue-filter-tip).
               On <body> and fixed, like the menu, so no Steam ancestor clips it. */
            .ilap-cur-tip {
                visibility: hidden; opacity: 0;
                position: fixed; z-index: 2147483001;
                width: max-content; max-width: 220px; padding: 5px 8px;
                background: #101a26; color: #c7d5e0; border: 1px solid #45A1FA; border-radius: 6px;
                box-shadow: 0 4px 15px rgba(0,0,0,0.8);
                font: 600 11px/1.35 "Motiva Sans", Arial, sans-serif;
                pointer-events: none; transition: opacity .2s, visibility .2s; transition-delay: 0s;
            }
            .ilap-cur-tip.show { visibility: visible; opacity: 1; transition-delay: .4s; }
            /* Menu lives on <body> (position:fixed) so no Steam ancestor stacking
               context / overflow can clip it or push it under the .page_desc below. */
            .ilap-curator-menu {
                display: none; position: fixed; z-index: 2147483000;
                /* border-box so min-width (synced to the button) is the FULL box:
                   under content-box the 1px borders would land outside it and the
                   open menu would sit 2px wider than the button it must match. */
                box-sizing: border-box;
                background: linear-gradient(180deg, #1b2a3c, #131e2a);
                border: 1px solid rgba(102,192,244,.3); border-radius: 12px;
                padding: 0;
                box-shadow: 0 24px 62px rgba(2,8,20,.62), 0 0 0 1px rgba(0,0,0,.4) inset;
                white-space: nowrap;
            }
            .ilap-curator-menu.open { display: block; }
            .ilap-curator-opt {
                display: flex; align-items: center; gap: 11px;
                height: 36px; padding: 0 15px; cursor: pointer; color: #c7d5e0;
                font: 500 13.5px "Motiva Sans", Arial, sans-serif;
                border-bottom: 1px solid rgba(255,255,255,.05);
            }
            .ilap-curator-opt:last-child { border-bottom: 0; }
            .ilap-curator-opt:hover { background: rgba(102,192,244,.12); color: #fff; }
            /* Keyboard focus on a row or a cross (Section 508). */
            .ilap-curator-opt:focus { outline: none; }
            .ilap-curator-opt:focus-visible, .ilap-opt-del:focus-visible { outline: 2px solid #66c0f4; outline-offset: -2px; }
            .ilap-curator-opt:focus-visible { background: rgba(102,192,244,.12); color: #fff; }
            .ilap-curator-opt.active {
                background: linear-gradient(90deg, rgba(66,135,245,.30), rgba(66,135,245,.08));
                color: #fff; font-weight: 700;
            }
            /* Each filter's square, the one the button and the queue applet show. */
            .ilap-opt-dot { width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0; }
            /* A filter already in the queue (.active) and one the queued jobs
               cover (.locked) take no pick. A queued one wears the "In queue" pill
               and the cross that removes its job; a locked one is only dimmed. */
            .ilap-curator-opt.active, .ilap-curator-opt.locked { cursor: default; }
            .ilap-curator-opt.locked { color: #6b7a88; }
            .ilap-curator-opt.locked:hover { background: none; color: #6b7a88; }
            .ilap-curator-opt.locked .ilap-opt-dot { opacity: .45; }
            /* Stamped in one place on every queued row, left of the cross, over
               the end of a long name, out of the flow. A third of it hangs over the
               row below (under the menu's edge on the last row). */
            .ilap-curator-opt.active { position: relative; }
            .ilap-opt-pill {
                position: absolute; right: 36px; bottom: -5px; z-index: 2;
                padding: 2px 5px; border-radius: 3px; white-space: nowrap; pointer-events: none;
                background: linear-gradient(90deg, #06bfff, #2d73ff); color: #fff;
                box-shadow: 0 1px 4px rgba(0,0,0,.45);
                font: 700 8px/1 "Motiva Sans", Arial, sans-serif;
                text-transform: uppercase; letter-spacing: .4px;
            }
            .ilap-opt-del {
                display: inline-flex; align-items: center; justify-content: center;
                width: 20px; height: 20px; margin: 0 -5px 0 auto; border-radius: 4px;
                color: #8f98a0; font: 700 12px/1 Arial, sans-serif; cursor: pointer;
            }
            .ilap-opt-del:hover { color: #ff6a4d; background: rgba(211,47,47,.18); }
            /* Soft re-stage warning: the user recently UNDID this curator's
               ignores — staging again is allowed (never blocked), just flagged. */
            .ilap-curator-warn {
                display: flex; align-items: center; gap: 8px;
                padding: 8px 15px; color: #ffd21a;
                font: 500 11.5px "Motiva Sans", Arial, sans-serif;
                border-bottom: 1px solid rgba(255,255,255,.05);
                white-space: normal; max-width: 300px; line-height: 1.35;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function remove() {
        const style = document.getElementById(STYLE_ID);
        if (style) style.remove();
    }

    window.ILAP.Curator.ButtonStyle = { BTN_ID, inject, remove };
})();
