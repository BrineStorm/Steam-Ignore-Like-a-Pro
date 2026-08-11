const { test, expect } = require('../_fixtures.js');
const {
    SEL,
    DRAIN_TIMEOUT,
    rightClickSwipe,
    pickFirstRow,
    pickSwipeable,
    searchRow,
    gotoWithStubs,
} = require('./_helpers');
const { clearExtensionStorage, getExtensionStorage } = require('../_extension.js');
const { searchUrl } = require('../_search.js');

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

// --- failure-path diagnostics -------------------------------------------
//
// The spotlight case used to fail in BURSTS on full runs (green for hours in
// between, green in isolation), always as ZERO posts over the whole budget —
// the swipe produced no intent at all rather than a late one. This dump is what
// settled it, and the answer was NOT the appdetails GET behind `resolveGameName`
// it was written to catch: the red run recorded no such request at all.
//
// What it recorded instead was the anchor sitting at x=972 where every live
// measurement had it at x=134 — the special-offers carousel resting on a
// different page. Probing that state on the live storefront closed the case:
// the carousel holds four pages at once and gives every non-focused one
// `pointer-events: none`, so its anchors keep a full box (Playwright's
// `:visible` passes them) while owning no point of it — the press falls through
// to div.carousel_items and the gesture builds no intent. Which page is focused
// rotates on its own, which is precisely the burst pattern. The fix is in
// _helpers.js `pressPoint` / `pickSwipeable`; the dump stays because a future
// zero-POST failure now means something new.
//
// CONSOLE ONLY, deliberately — nothing is written to disk. `test-results/` is
// gitignored, but this dump carries account-shaped data (appids, the tab's
// session map) and the working tree is cloud-synced, where .gitignore protects
// nothing. Runs only after an assertion has already failed, so a green run pays
// for none of it.
function watchAppdetails(page) {
    const seen = [];
    const startedAt = new Map();
    page.on('request', (r) => {
        if (!r.url().includes('/api/appdetails')) return;
        startedAt.set(r, Date.now());
        seen.push({ url: r.url().slice(-60), state: 'pending' });
    });
    const settle = (r, state) => {
        if (!startedAt.has(r)) return;
        const rec = seen.find(s => s.url === r.url().slice(-60) && s.state === 'pending');
        if (rec) { rec.state = state; rec.ms = Date.now() - startedAt.get(r); }
    };
    page.on('requestfinished', (r) => settle(r, 'finished'));
    page.on('requestfailed', (r) => settle(r, 'failed'));
    return seen;
}

async function dumpSwipeFailure(page, context, { appid, calls, appdetails, anchor }) {
    const out = { appid, ignorePosts: calls };
    try {
        out.appdetails = appdetails;
        out.badgesForAppid = await page.locator(`${SEL.overlay}[data-ilap-appid="${appid}"]`).count();
        out.badgesTotal = await page.locator(SEL.overlay).count();
        out.sessionMap = await page.evaluate(() => sessionStorage.getItem('ilap_session_map_v2'));
        const store = await getExtensionStorage(context,
            ['ilap_curator_queue', 'ilap_curator_cursor_job_mi', 'ilap_ignore_gate', 'ilap_master_enabled']);
        out.storage = store;
        if (anchor) {
            out.anchorNow = await page.evaluate((sel) => {
                const el = document.querySelector(sel.replace(':visible', ''));
                if (!el) return 'GONE';
                const r = el.getBoundingClientRect();
                return {
                    href: (el.getAttribute('href') || '').match(/\/app\/(\d+)/)?.[1],
                    box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
                };
            }, anchor);
        }
    } catch (e) {
        out.dumpError = String(e).slice(0, 200);
    }
    console.log('=== SWIPE FAILURE DIAGNOSTICS ===\n' + JSON.stringify(out, null, 1));
}

// Homepage capsule surfaces. Steam's storefront markup shifts with sales and
// redesigns; these are the long-lived widgets. Each `anchor` selects the /app/
// link DIRECTLY (on the homepage the capsule usually IS the anchor), and each
// exercises a distinct ContainerStrategyProvider branch:
//   - Wrapper      → a.store_main_capsule        (Featured carousel, hero badge)
//   - Direct Image → .home_area_spotlight (.spotlight_img parent, hero badge)
//   - Fallback     → a.tab_row_item              (New & Trending tabs, grid badge)
//   - Fallback     → a.sale_capsule              (sale/discount capsules, grid badge)
const SURFACES = [
    {
        name: 'featured carousel capsule — Wrapper strategy (hero)',
        anchor: 'a.store_main_capsule[href*="/app/"]:visible',
        expectVariant: SEL.heroBadge,
    },
    {
        name: 'spotlight capsule — Direct Image strategy (hero)',
        anchor: '.home_area_spotlight a[href*="/app/"]:visible',
        expectVariant: SEL.heroBadge,
        // The special-offers strip mounts four pages at once and only the
        // focused one takes pointer events, so whether the one spotlight with an
        // /app/ link is pressable depends on where the carousel happens to rest —
        // which is what made this case red in bursts. Its own arrow cycles the
        // pages (measured: next → focus → prev → plain → next), so the test can
        // bring the surface to itself instead of hoping.
        advance: '.carousel_container:has(.home_area_spotlight) .arrow.right',
        skipNote: 'No spotlight with an /app/ link on /; spotlights sometimes point at sales/news only.',
    },
    {
        name: 'New & Trending tab row — Fallback strategy (grid)',
        anchor: 'a.tab_row_item[href*="/app/"]:visible',
        expectVariant: SEL.gridBadge,
    },
    {
        name: 'sale capsule — Fallback strategy (grid)',
        anchor: 'a.sale_capsule[href*="/app/"]:visible',
        expectVariant: SEL.gridBadge,
    },
];

test.describe('Manual Ignore — container strategies across Steam surfaces', () => {

    test('Swipe lands a badge on: search results — Fallback strategy (grid)', async ({ page, context }) => {
        const appdetails = watchAppdetails(page);
        const calls = await gotoWithStubs(page, context, searchUrl());

        // Search rows ARE the /app/ link; the extension resolves them via the
        // Fallback strategy → 'grid' badge appended onto the row.
        const { link, appid } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);

        try {
            await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);
        } catch (e) {
            await dumpSwipeFailure(page, context, { appid, calls, appdetails });
            throw e;
        }
        expect(calls[0].appid).toBe(appid);
        expect(calls[0].reason).toBe(0);

        await expect(searchRow(page, appid).locator(SEL.gridBadge)).toBeVisible({ timeout: DRAIN_TIMEOUT });
    });

    for (const surface of SURFACES) {
        test(`Swipe lands a badge on: ${surface.name}`, async ({ page, context }) => {
            const appdetails = watchAppdetails(page);
            const calls = await gotoWithStubs(page, context, '/');

            // Storefront hydrates widgets asynchronously — give the anchor time
            // to materialize, otherwise skip with a clear message rather than a
            // generic timeout.
            try {
                await page.locator(surface.anchor).first().waitFor({ state: 'visible', timeout: 15000 });
            } catch {
                test.skip(true, surface.skipNote || `${surface.anchor} did not render on /; Steam surface changed.`);
                return;
            }

            // Not `.first()`: a match can be rendered and `:visible` and still be
            // unpressable — a non-focused carousel page carries
            // `pointer-events: none`, so its anchors keep a box but own no point of
            // it (see pressPoint in _helpers.js). Any capsule of this surface proves
            // the strategy, so take the first one a press would actually reach.
            let picked = await pickSwipeable(page, surface.anchor);
            // Not pressable where the carousel rests? Advance it with its own
            // control, as a user would. Three clicks cover the rest of the cycle.
            for (let advance = 0; !picked && surface.advance && advance < 3; advance++) {
                const arrow = page.locator(surface.advance).first();
                if (await arrow.count() === 0) break;
                await arrow.click({ force: true });   // the arrows rest at opacity 0
                await page.waitForTimeout(900);       // the page swap animates
                picked = await pickSwipeable(page, surface.anchor);
            }
            if (!picked) {
                // A user could not press it either — the surface is unreachable
                // this pass, not broken. Skipping says so; swiping at it would
                // report a product bug that isn't there.
                test.skip(true, `${surface.anchor} rendered, but no match is hit-testable `
                    + 'even after cycling the carousel.');
                return;
            }
            const { link, appid } = picked;
            await rightClickSwipe(page, link, 60);

            try {
                await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);
            } catch (e) {
                await dumpSwipeFailure(page, context,
                    { appid, calls, appdetails, anchor: surface.anchor });
                throw e;
            }
            expect(calls[0].appid).toBe(appid);
            expect(calls[0].reason).toBe(0);

            // The badge must carry the variant class of the strategy this
            // surface resolves through AND be tied to the swiped appid.
            const badge = page.locator(`${surface.expectVariant}[data-ilap-appid="${appid}"]`).first();
            await expect(badge).toBeVisible({ timeout: DRAIN_TIMEOUT });
        });
    }

    // Tag browse doesn't share a stable wrapper selector with the surfaces
    // above — it needs its own probe. The contract is the same though: swipe →
    // ContainerStrategyProvider must resolve, badge must end up tied to the
    // swiped appid via data-ilap-appid.

    test('Swipe lands a badge on: tag browse (/tag/browse/?tags=19)', async ({ page, context }) => {
        // Action tag — populated reliably.
        const appdetails = watchAppdetails(page);
        const calls = await gotoWithStubs(page, context, '/tag/browse/?tags=19');

        // Tag browse hydrates capsules asynchronously. Pick the first /app/ link
        // and wait for its image container to attach before swiping.
        const link = page.locator('a[href*="/app/"]').first();
        try {
            await link.waitFor({ state: 'attached', timeout: 15000 });
        } catch {
            test.skip(true, 'Tag browse rendered no /app/ links; Steam surface changed.');
            return;
        }
        const href = await link.getAttribute('href');
        const m = href && href.match(/\/app\/(\d+)/);
        if (!m) {
            test.skip(true, `Unexpected href on tag browse: ${href}`);
            return;
        }
        const appid = m[1];

        await rightClickSwipe(page, link, 60);

        try {
            await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);
        } catch (e) {
            await dumpSwipeFailure(page, context, { appid, calls, appdetails });
            throw e;
        }
        expect(calls[0].appid).toBe(appid);

        // The variant doesn't matter for this surface — what matters is that
        // ContainerStrategyProvider resolved (not fallback-fired into oblivion)
        // and the badge is correctly tagged with this appid.
        const badge = page.locator(`.ilap-ignored-overlay[data-ilap-appid="${appid}"]`).first();
        await expect(badge).toBeVisible({ timeout: DRAIN_TIMEOUT });
    });
});
