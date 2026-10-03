// SPDX-License-Identifier: GPL-3.0-or-later
//
// Steam markup canary. NOT a product test — nothing here loads the extension,
// logs in, or writes anything. It opens the four public store surfaces the
// content scripts read and asserts the anchors those scripts cannot work
// without are still there. When Steam reshuffles its storefront, this goes red
// on a schedule instead of a user noticing the badges stopped appearing.
//
// Why it is its own project: the unit layer in CI runs modules through `vm` and
// never opens a page, so it is structurally blind to markup drift; the suites
// that WOULD catch it need a logged-in session and a headed browser, so they can
// only run locally. This is the slice that survives on a bare runner —
// anonymous, headless, read-only.
//
// Deliberately NOT asserted: every selector in a fallback chain. The badge-target
// and name strategies in src/manual-ignore/utils.js and src/utils.js are long
// OR-lists on purpose, and several of their branches are already dead on today's
// storefront (.tab_item, .home_smallcap_title, .capsule_name and .game_capsule
// match nothing anywhere). Requiring those would be red forever and teach us to
// ignore this file. What is asserted is the capability: on each surface, at
// least one path through the chain still resolves.
//
// The auth-only surfaces — the Discovery Queue modal, the /explore/ queue
// chrome, the curator admin — are out of reach from here. They are covered by
// the local run schedule instead.

const { test, expect } = require('@playwright/test');
const { randomAppPage } = require('../_app-pool.js');
const { searchUrl } = require('../_search.js');
const { tagUrl } = require('../_tags.js');
// READ OUT OF THE PRODUCT, not retyped here. The first version of this guard
// kept its own copy of the shades and that copy was the Explore Queue's; when
// Steam repainted the Discovery Queue modal the canary stayed green through a
// feature that had silently stopped ignoring anything. A guard with its own copy
// of the thing it guards guards nothing.
const { PALETTE } = require('../_palette.js');
// The curator id and the product's own recommendations URL — same principle as
// the palette above: read out of src/, not retyped here.
const { CURATOR_ID, curatorPath, recommendationsPath } = require('../_curator.js');
// The sale-reward check, run as the product runs it (src/sale-reward.js builds
// the request and reads the answer); only the network is the canary's.
const { loadSaleReward } = require('../_sale-reward.js');

// The review-summary colours src/explore-queue/utils.js classifies by: a game is
// only IGNORE-worthy when a row colour matches MIXED or NEGATIVE, and anything
// unrecognised is treated as SPARE. That is the dangerous failure mode this
// check exists for — restyle the palette and classification does not throw, it
// silently stops ignoring anything, with nothing in the logs.
// ONLY the current shade of each band. The product deliberately also accepts the
// shades Steam painted before (see src/steam-palette.js) so a rollback cannot
// disable ignoring for users — but the canary must not: an older shade coming
// back is exactly the kind of move we want to hear about, quietly survived or
// not. Anything unlisted, current-but-different or resurrected alike, is red.
const REVIEW_COLORS = new Map([
    [PALETTE.current('BLUE'), 'positive (BLUE)'],
    [PALETTE.current('MIXED'), 'mixed (MIXED)'],
    [PALETTE.current('NEGATIVE'), 'negative (NEGATIVE)'],
    // Steam paints "too few reviews" #929396. Nothing classifies on it — it is
    // here so the assertion below does not read it as an unknown shade.
    ['rgb(146, 147, 150)', 'too few reviews (#929396)'],
]);

// English store, and past the age gate: the hunt below opens whatever the search
// hands back, which can be a mature title. Without birthtime that page is an
// interstitial and every assertion misses for the wrong reason.
test.beforeEach(async ({ context }) => {
    await context.addCookies([
        { name: 'Steam_Language', value: 'english', domain: 'store.steampowered.com', path: '/' },
        { name: 'birthtime', value: '283993201', domain: 'store.steampowered.com', path: '/' },
    ]);
});

// Read every review row the way ReviewAnalyzer.getRowSummaries does: the status
// span plus the bracketed count, both required before a row counts.
function readReviewRows(page) {
    return page.evaluate(() =>
        [...document.querySelectorAll('#userReviews .user_reviews_summary_row .summary.column')].map((col) => {
            const status = col.querySelector('.game_review_summary');
            const count = col.querySelector('.responsive_hidden');
            return {
                text: status ? status.textContent.trim() : null,
                color: status ? getComputedStyle(status).color : null,
                count: count ? count.textContent.trim() : null,
            };
        }));
}

test.describe('Steam markup canary', () => {
    test('search results still expose ignorable rows', async ({ page }) => {
        await page.goto(searchUrl(), { waitUntil: 'domcontentloaded' });

        const rows = page.locator('a.search_result_row');
        expect(await rows.count(), 'no a.search_result_row on /search/ — the manual-ignore row surface is gone')
            .toBeGreaterThan(9);

        const first = rows.first();
        expect(await first.getAttribute('href'), 'a search row no longer links to /app/<id>')
            .toMatch(/\/app\/\d+/);
        expect(await first.locator('img').count(), 'a search row carries no img — nothing to anchor a badge to')
            .toBeGreaterThan(0);
    });

    test('app page still exposes the game name', async ({ page }) => {
        await page.goto(randomAppPage(), { waitUntil: 'domcontentloaded' });

        const title = page.locator('#appHubAppName, .apphub_AppName').first();
        await expect(title, 'neither #appHubAppName nor .apphub_AppName on an app page — PageTitleStrategy is blind')
            .toBeVisible();
        expect(((await title.textContent()) || '').trim().length, 'the app-page title element is empty')
            .toBeGreaterThan(0);
    });

    test('app page still exposes the review rows the classifier reads', async ({ page }) => {
        await page.goto(randomAppPage(), { waitUntil: 'domcontentloaded' });

        await expect(page.locator('#userReviews'), 'userReviews block is gone from the app page')
            .toBeAttached();

        const rows = await readReviewRows(page);
        expect(rows.length, 'userReviews .user_reviews_summary_row .summary.column matched nothing')
            .toBeGreaterThan(0);

        const usable = rows.filter((r) => r.text && r.count && r.count.startsWith('(') && r.count.endsWith(')'));
        expect(usable.length,
            `no review row has both .game_review_summary and a bracketed .responsive_hidden count: ${JSON.stringify(rows)}`)
            .toBeGreaterThan(0);
    });

    test('review-summary colours still match the classifier palette', async ({ page }) => {
        // Hunt a Mixed / Negative title from the search rows own summary classes,
        // so the two colours that actually trigger an ignore get checked and not
        // just the blue every evergreen game shows. The search filter params are
        // ignored anonymously (review_score= changes nothing), hence the scan.
        await page.goto(searchUrl(), { waitUntil: 'domcontentloaded' });
        const targets = await page.evaluate(() => {
            const byKind = {};
            for (const row of document.querySelectorAll('a.search_result_row')) {
                const summary = row.querySelector('.search_review_summary');
                if (!summary) continue;
                const kind = [...summary.classList].find((c) => c !== 'search_review_summary');
                const appid = (row.href.match(/\/app\/(\d+)/) || [])[1];
                if (kind && appid && !byKind[kind]) byKind[kind] = appid;
            }
            return byKind;
        });

        // Always check one evergreen page too, so the test still asserts something
        // on a search page that happens to be all-positive.
        const pages = [randomAppPage()];
        for (const kind of ['mixed', 'negative']) {
            if (targets[kind]) pages.push(`/app/${targets[kind]}/`);
        }

        let seen = 0;
        for (const url of pages) {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            for (const row of await readReviewRows(page)) {
                if (!row.color) continue;
                seen++;
                // A shade the product still accepts, but not the current one, is a
                // rollback or a partial rollout: users keep working, we get told.
                const legacy = PALETTE.isBad(row.color)
                    ? ' — this is a PREVIOUS shade the product still accepts, so ignoring keeps working: Steam has rolled back or is rolling out in parts'
                    : ' — the classifier treats anything unrecognised as SPARE, so ignoring silently stops';
                expect(REVIEW_COLORS.has(row.color),
                    `unexpected review-summary colour ${row.color} for "${row.text}" on ${url}${legacy}. ` +
                    `Current palette: [${[...REVIEW_COLORS.entries()].map(([c, n]) => `${n} ${c}`).join(', ')}]`)
                    .toBe(true);
            }
        }
        expect(seen, 'no review summary was readable on any sampled app page').toBeGreaterThan(0);
    });

    test('tag page still exposes the queue widget and capsule blocks', async ({ page }) => {
        await page.goto(tagUrl(), { waitUntil: 'domcontentloaded' });

        await expect(page.locator('.SaleSectionCtn.discoveryqueue'),
            'the Explore-your-Discovery-Queue widget is gone from the tag page — the DQ entry point')
            .toBeAttached({ timeout: 15000 });

        // Capsule rows hydrate lazily; nudge the page before counting them.
        for (let i = 0; i < 4; i++) {
            await page.mouse.wheel(0, 1200);
            await page.waitForTimeout(600);
        }

        expect(await page.locator('[class*="SaleSectionCtn"]').count(),
            'no [class*="SaleSectionCtn"] block — the legacy container root for badge placement')
            .toBeGreaterThan(0);
        expect(await page.locator('[class*="CapsuleImageCtn"]').count(),
            'no [class*="CapsuleImageCtn"] — the direct-image badge target on sale surfaces')
            .toBeGreaterThan(0);
        expect(await page.locator('a[href*="/app/"]').count(), 'no app links on the tag page')
            .toBeGreaterThan(0);
    });

    // The curator surfaces, which ARE public — unlike the Discovery Queue modal
    // and the /explore/ chrome, which need a session and stay with the local
    // run schedule. This is the quietest failure in the extension: the enqueue
    // path reads rows out of a JSON field with a string parser, and a markup
    // change there does not throw — it parses zero rows, the job is dropped and
    // the user gets a generic "couldn't build a list" toast with nothing naming
    // the cause. A curator id is discovered live rather than pinned, so the test
    // does not rot when one curator goes away.
    test('curator recommendations still carry the rows the enqueue path parses', async ({ page }) => {
        // Land on the curator page first, so the ajax call below is same-origin
        // and carries the Referer a real enumeration carries.
        await page.goto(curatorPath(), { waitUntil: 'domcontentloaded' });

        const data = await page.evaluate(async (url) => {
            const res = await fetch(url, {
                credentials: 'include',
                headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
            });
            if (!res.ok) return { httpError: res.status };
            return res.json();
        }, recommendationsPath());

        expect(data.httpError, `the curator recommendations endpoint answered HTTP ${data.httpError}`)
            .toBeUndefined();
        expect(data.success, 'curator recommendations no longer answer success:1').toBe(1);
        expect(typeof data.total_count,
            'total_count is gone from the response — enumerate paginates on it').toBe('number');
        expect(typeof data.results_html,
            'results_html is gone from the response — the row source the parser splits').toBe('string');

        // The three anchors parseResults depends on, asserted separately so a red
        // run names which one moved. A curator with no recommendations at all
        // would fail these for an innocent reason, so require rows first.
        expect(data.results_html.length,
            `curator ${CURATOR_ID} returned an empty results_html`).toBeGreaterThan(0);
        expect(data.results_html,
            'no class="recommendation" wrapper — parseResults splits the rows on exactly this string')
            .toContain('class="recommendation"');
        expect(data.results_html,
            'no data-ds-appid in a recommendation row — the appid the parser reads')
            .toMatch(/data-ds-appid="\d+"/);
        expect(data.results_html,
            'no color_* review class — the type the parser classifies rows by')
            .toMatch(/color_(not_recommended|recommended|informational)/);
    });

    test('curator page still exposes the button injection point', async ({ page }) => {
        await page.goto(curatorPath(), { waitUntil: 'domcontentloaded' });
        // src/curator/main.js injects its control into .curator_report, before the
        // first <a> in it (the Options gear).
        await expect(page.locator('.curator_report').first(),
            '.curator_report is gone from the curator page — the "Add to ignore queue" control has nowhere to mount')
            .toBeAttached({ timeout: 15000 });
    });

    test('home page still exposes the hero capsule and structural roots', async ({ page }) => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        expect(await page.locator('.store_main_capsule').count(),
            '.store_main_capsule is gone — the hero badge surface on the storefront')
            .toBeGreaterThan(0);
        expect(await page.locator('[data-ds-appid]').count(),
            'no [data-ds-appid] on the storefront — the structural container root the resolver falls back to')
            .toBeGreaterThan(0);
    });

    // Not markup but the same kind of dependency: the queue automators gate on
    // the sale reward, and its public half (GetCurrentDefinition) needs no
    // token, so it can be asked from here. The PRODUCT judges the shape, not
    // this test: src/sale-reward.js runs on the live answer, with only the
    // account's progress (the half behind a login) canned at 0 earned. A shape it
    // can read gives 'pending' (a reward running) or 'allowed' (none running);
    // anything else gives 'unknown', which keeps both queue helpers from
    // advancing on their own — fail-closed, so this is the alarm for it. A copy
    // of the parsing rules here would drift from the product's (it already did
    // once: numbers sent as strings). The answer must also carry the CORS header
    // for the store's origin: the content script's request is cross-origin, and
    // without it the browser hides the answer, which reads 'unknown' just the same.
    test('sale reward API still answers the store in a shape the reward check reads', async ({ request }) => {
        const STORE = 'https://store.steampowered.com';
        const seen = [];
        const { SaleReward } = loadSaleReward({
            token: 'canary',   // no account behind it: the progress request below is canned
            fetchWithTimeout: async (url) => {
                if (url.includes('/GetClaimedSaleRewards/')) {
                    return { ok: true, json: async () => ({ response: { num_items_earned: 0 } }) };
                }
                const res = await request.get(url, { headers: { Origin: STORE } });
                const body = await res.json().catch(() => null);
                seen.push({ url, status: res.status(), acao: res.headers()['access-control-allow-origin'], body });
                return { ok: res.ok(), json: async () => body };
            },
        });
        const verdict = await SaleReward.check();

        const asked = seen.find(r => r.url.includes('/GetCurrentDefinition/'));
        expect(asked, 'the reward check no longer asks GetCurrentDefinition — update this guard').toBeTruthy();
        expect(asked.status).toBe(200);
        expect(asked.acao, 'no CORS header for the store origin: every check would read unknown').toBe(STORE);
        expect(['pending', 'allowed'],
            `the reward check cannot read today's answer: ${JSON.stringify(asked.body).slice(0, 400)}`)
            .toContain(verdict);
    });
});
