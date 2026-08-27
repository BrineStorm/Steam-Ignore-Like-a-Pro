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
});
