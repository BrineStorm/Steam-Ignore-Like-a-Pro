// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The ignore-filter vocabulary and the curator-id parser, for the curator
    // button and the queue applet. Self-contained: popup.html loads it too.

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

    // Per-category accent — Steam's own review-type label colours. Null-prototype
    // because the lookup key is a job's stored `filter`, and colorStyle's result
    // goes into a style ATTRIBUTE unescaped: a record carrying 'constructor' would
    // otherwise resolve to Object and stringify a function into it.
    const COLORS = Object.assign(Object.create(null), {
        not_recommended: '#ec976c',
        informational: '#f1de74'
    });
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
