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

    // The same accent as a fill, for a filter's square (the queue applet's strip,
    // the curator button and its menu, Recent). The combined filter is split
    // corner to corner into its two colours, Not Recommended top left.
    function fillStyle(value) {
        if (value === 'all_but_recommended') {
            return `background:linear-gradient(135deg, ${COLORS.not_recommended} 50%, ${COLORS.informational} 50%);`;
        }
        return `background:${COLORS[value] || '#45A1FA'};`;
    }

    // What a curator's queued jobs already cover. A curator has at most two jobs
    // in the queue, one per review type, or one job of both ('all_but_recommended').
    // They share the curator's drain lease (curator/lease.js), so they run one
    // after the other.
    const NR = 'not_recommended', INF = 'informational', BOTH = 'all_but_recommended';
    const partsOf = (filter) => (filter === BOTH ? [NR, INF] : [filter]);

    // This curator's curator jobs. A job with no type is a curator's (records
    // from before job types), as in Store.jobType.
    function curatorJobs(queue, curatorId) {
        return (queue || []).filter(j => j.curatorId === curatorId && (j.type || 'curator') === 'curator');
    }

    // The review types this curator's curator jobs cover: a Set of NR / INF.
    function coveredTypes(queue, curatorId) {
        const types = new Set();
        for (const j of curatorJobs(queue, curatorId)) {
            for (const p of partsOf(j.filter)) if (p === NR || p === INF) types.add(p);
        }
        return types;
    }

    // The filter that stands for `types`: both → 'all_but_recommended', one → it,
    // none → null.
    function coverFilter(types) {
        if (types.has(NR) && types.has(INF)) return BOTH;
        return types.has(NR) ? NR : types.has(INF) ? INF : null;
    }

    // The job a pick of `filter` adds: `filter` itself with nothing queued, the
    // one type still missing when the other is queued (so with Not Recommended
    // queued, "All except Recommended" adds what "Informational only" adds), or
    // null when the pick is covered already.
    function filterToAdd(types, filter) {
        const missing = partsOf(filter).filter(p => !types.has(p));
        if (!missing.length) return null;
        return types.size ? missing[0] : filter;
    }

    window.ILAP_Filters = {
        FILTERS, labelKey, colorStyle, fillStyle, curatorIdFromPath,
        curatorJobs, coveredTypes, coverFilter, filterToAdd
    };

})();
