// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Shared curator-page helpers — the ignore-filter vocabulary plus the curator-id
    // path parser — used by the curator-page control (src/curator/main.js, content
    // script) and the popup/widget queue applet (ui/popup_queue.js). Deliberately
    // self-contained: the popup window does NOT load src/utils.js, so this module
    // must not depend on the window.ILAP facade. Loaded in both the content_scripts
    // list and popup.html.

    // /curator/<id>-<slug>/ → numeric id string, or null on any other store page.
    function curatorIdFromPath(pathname) {
        const m = (pathname || '').match(/^\/curator\/(\d+)/);
        return m ? m[1] : null;
    }

    // Ordered list drives the curator-page dropdown; the value→key map is derived
    // from it so the two can never drift apart.
    const FILTERS = [
        { value: 'not_recommended', key: 'filter_not_recommended' },
        { value: 'informational', key: 'filter_informational' },
        { value: 'all_but_recommended', key: 'filter_all_but_recommended' }
    ];

    // Per-category accent — Steam's own review-type label colours.
    const COLORS = {
        not_recommended: '#ec976c',
        informational: '#f1de74'
    };
    // "All except Recommended" = both categories → orange→yellow gradient text.
    const GRADIENT = 'linear-gradient(90deg, #ec976c, #f1de74)';

    function labelKey(value) {
        const f = FILTERS.find(x => x.value === value);
        return f ? f.key : FILTERS[0].key;
    }

    // Inline CSS that colours a filter label. opts.bold prepends font-weight:700
    // (the popup applet styles a plain <div>; the curator toast wraps in <b>).
    // opts.fallback sets the colour for any unknown value.
    function colorStyle(value, opts) {
        opts = opts || {};
        const bold = opts.bold ? 'font-weight:700; ' : '';
        if (value === 'all_but_recommended') {
            return `${bold}background:${GRADIENT}; -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color:transparent;`;
        }
        return `${bold}color:${COLORS[value] || opts.fallback || '#45A1FA'};`;
    }

    window.ILAP_Filters = { FILTERS, labelKey, colorStyle, curatorIdFromPath };

})();
