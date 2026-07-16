// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Phase-2 curator enumeration: turns a curator id into the list of appids it
    // recommends, grouped by recommendation type. Steam paginates a curator's
    // recommendations through a clean JSON endpoint that honours a large `count`,
    // so a 2000-game list resolves in ~4 reads (count=500) rather than ~200.
    //
    // The HTML parsing is LANGUAGE-INDEPENDENT: each row carries a stable
    // `data-ds-appid` and a `.color_not_recommended / .color_informational /
    // .color_recommended` class — we never look at the visible "Not Recommended"
    // text. Parsing/URL/filtering are pure (Node-unit-testable); `enumerate`
    // takes injected fetch/sleep/rand so the network loop is testable too.

    window.ILAP = window.ILAP || {};
    window.ILAP.Curator = window.ILAP.Curator || {};

    const BASE = 'https://store.steampowered.com';
    const DEFAULT_COUNT = 500;       // honoured by Steam at least up to 500 rows/call
    const MAX_PAGES = 12;            // safety ceiling (12 × 500 = 6000 games)
    const JITTER_MIN = 400;          // ms between page reads — polite, human-paced
    const JITTER_MAX = 800;

    const TYPES = ['not_recommended', 'recommended', 'informational'];

    // Build the ajax recommendations URL. The page's own infinite-scroll fires
    // count=10 per scroll; we call it ourselves with a big count instead.
    function buildUrl(curatorId, start, count) {
        return `${BASE}/curator/${curatorId}/ajaxgetfilteredrecommendations/`
            + `?query&start=${start}&count=${count}`
            + `&dynamic_data=&tagids=&sort=recent&app_types=&curations=&reset=false`;
    }

    // Parse a results_html string into [{ appid, type }]. Each recommendation row
    // is wrapped in an element whose class is exactly `recommendation` (the inner
    // `recommendation_link` / `recommendation_midcol` carry suffixes, so an exact
    // `class="recommendation"` split isolates one row per block). Within a block:
    // the first data-ds-appid is the game; the color_* class is its review type.
    function parseResults(html) {
        if (!html) return [];
        const out = [];
        const blocks = String(html).split('class="recommendation"');
        // blocks[0] is the preamble before the first row → no appid → skipped.
        for (let i = 1; i < blocks.length; i++) {
            const block = blocks[i];
            const appidMatch = block.match(/data-ds-appid="(\d+)"/);
            if (!appidMatch) continue;
            const typeMatch = block.match(/color_(not_recommended|recommended|informational)/);
            out.push({ appid: appidMatch[1], type: typeMatch ? typeMatch[1] : 'unknown' });
        }
        return out;
    }

    // Fold a flat [{appid,type}] list into { not_recommended, informational,
    // recommended } appid arrays, de-duplicating across pages. Unknown types are
    // dropped — we never queue a game we couldn't classify.
    function categorize(parsed) {
        const apps = { not_recommended: [], informational: [], recommended: [] };
        const seen = new Set();
        for (const row of parsed || []) {
            if (seen.has(row.appid)) continue;
            seen.add(row.appid);
            if (apps[row.type]) apps[row.type].push(row.appid);
        }
        return apps;
    }

    // Resolve the appids a job should ignore for a given filter. We classify
    // client-side off the parsed color class (the server `curations=` param
    // vocabulary is unknown and probes returned 0).
    function filterAppids(apps, filter) {
        apps = apps || {};
        const nr = apps.not_recommended || [];
        const inf = apps.informational || [];
        if (filter === 'informational') return inf.slice();
        if (filter === 'all_but_recommended') return nr.concat(inf);
        return nr.slice(); // 'not_recommended' (default)
    }

    function jitter(rand) {
        return JITTER_MIN + Math.floor((rand || Math.random)() * (JITTER_MAX - JITTER_MIN));
    }

    // Walk the curator's recommendations in big pages until we've covered
    // total_count. Returns { total, apps, fetchedAt }. `opts.fetch/sleep/rand`
    // are injectable for tests; defaults hit the live endpoint same-origin.
    //
    // ACCEPTED (triage of the audit PLAUSIBLE finding): a
    // list that changes BETWEEN page reads shifts rows across page boundaries.
    // Duplicates are harmless (categorize() de-dupes on appid); a row shifted
    // into an already-read range is MISSED for this enumeration. With count=500
    // pages, sort=recent and sub-second gaps the window is a curator posting a
    // review during those exact seconds — at worst one game is picked up by the
    // next stage/re-enumeration (cache TTL 7 d, or any filter re-pick). Snapshot
    // consistency isn't worth extra passes here.
    async function enumerate(curatorId, opts) {
        opts = opts || {};
        // 15 s deadline per page (a 500-row page is a big payload on a slow
        // link) — a hung read must throw like a network error, not stall the
        // enumeration forever.
        const doFetch = opts.fetch || ((url) => window.ILAP.fetchWithTimeout(url, {
            credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' }
        }, 15000));
        const sleep = opts.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
        const count = opts.count || DEFAULT_COUNT;
        const maxPages = opts.maxPages || MAX_PAGES;

        const parsed = [];
        let total = 0;
        let start = 0;

        for (let page = 0; page < maxPages; page++) {
            let data;
            try {
                const res = await doFetch(buildUrl(curatorId, start, count));
                if (!res || !res.ok) break;
                data = await res.json();
            } catch (e) {
                break;
            }
            if (!data || data.success !== 1) break;
            total = data.total_count || total;

            const rows = parseResults(data.results_html || '');
            if (rows.length === 0) break;   // nothing more to read
            parsed.push(...rows);

            start += count;
            if (start >= total) break;
            await sleep(jitter(opts.rand));
        }

        return { total, apps: categorize(parsed), fetchedAt: Date.now() };
    }

    window.ILAP.Curator.Enumerator = {
        buildUrl,
        parseResults,
        categorize,
        filterAppids,
        enumerate,
        TYPES
    };
})();
