// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // A curator id → the appids it recommends, by recommendation type. The JSON
    // endpoint honours a large `count`, so 2000 games take ~4 reads.
    // Language-independent: rows are read by `data-ds-appid` and the
    // `.color_*` class, never by the visible label.

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

    // The appids a job ignores under `filter`, classified here: the server's
    // `curations=` values are unknown.
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

    // Pages through the recommendations until total_count. { total, apps, fetchedAt }.
    // A review posted between two page reads can shift a row out of this pass;
    // the next enumeration picks it up, which is cheaper than snapshot passes.
    async function enumerate(curatorId, opts) {
        opts = opts || {};
        // A 500-row page is big: a longer deadline than the default.
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
        // A read that FAILED before the list was covered, as opposed to one that
        // finished. Without it a page-two timeout looks exactly like a complete
        // curator, and the truncated list would be cached for the TTL and drained
        // as if it were the whole thing. Set only where the evidence is
        // unambiguous — a failed request or our own page ceiling — never for a
        // short page, which is the server saying it has no more rows.
        let partial = false;

        for (let page = 0; page < maxPages; page++) {
            let data;
            try {
                const res = await doFetch(buildUrl(curatorId, start, count));
                if (!res || !res.ok) { partial = true; break; }
                data = await res.json();
            } catch (e) {
                partial = true;
                break;
            }
            if (!data || data.success !== 1) { partial = true; break; }
            total = data.total_count || total;

            const rows = parseResults(data.results_html || '');
            if (rows.length === 0) break;   // nothing more to read
            parsed.push(...rows);

            start += count;
            if (start >= total) break;
            // Last allowed page and the list still is not covered: we stopped,
            // Steam did not. Checked before the pause, which would otherwise be
            // spent on a loop that is about to exit anyway.
            if (page === maxPages - 1) { partial = true; break; }
            await sleep(jitter(opts.rand));
        }

        // Not one row parsed while the server says this curator HAS rows: that is
        // the markup moving under parseResults, not an empty curator. It matters
        // because of what happens next — an empty result drops the job and shows
        // the error toast, and a run that is not `partial` is CACHED, so a parse
        // break would serve its own emptiness for the retention week and every
        // re-add in it would fail the same way with no network touched. Marking
        // it keeps the failure per-attempt, which is what a fix (ours or Valve's
        // own revert) needs to be visible. The canary reports the cause.
        if (parsed.length === 0 && total > 0) partial = true;
        return { total, apps: categorize(parsed), fetchedAt: Date.now(), partial };
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
