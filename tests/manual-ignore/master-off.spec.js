const { test, expect } = require('../_fixtures.js');
const {
    SEL,
    DRAIN_TIMEOUT,
    rightClickSwipe,
    pickFirstRow,
    searchRow,
    gotoWithStubs,
    miJob,
    seedTagPage,
    scrollTagPage,
} = require('./_helpers');
const { clearExtensionStorage, setExtensionStorage } = require('../_extension.js');
const { searchUrl } = require('../_search.js');

// The stacked capsule blocks of a /tags/ page — same two the tag-page spec
// asserts render badges at all (each is a different container strategy).
const BLOCKS = ['div[data-key="hover div"]', '[class*="sale_item_browser"]'];

// The master toggle vs the marks Manual Ignore leaves ON THE PAGE. A disabled
// extension must not go on painting IGNORED plates over Steam's capsules — and
// it must not throw anything away either: the per-tab session map (and whatever
// sits in the queue) survives the flip, so re-enabling repaints exactly what
// was there.
//
// Search results are the surface, like the rest of the MI suite: every row is
// itself the /app/ link, and the term is randomized per navigation.

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — master toggle vs the badges', () => {

    test('Master OFF strips the badge off the page (and keeps it off); ON paints it back', async ({ page, context }) => {
        const calls = await gotoWithStubs(page, context, searchUrl());

        const { link, appid } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);

        await expect(searchRow(page, appid).locator(SEL.overlay)).toBeVisible({ timeout: DRAIN_TIMEOUT });
        // Let the deferred POST land first, so the flip below is a clean
        // "badge vs master" test and not a race with the drain.
        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(1);

        await setExtensionStorage(context, { ilap_master_enabled: false });
        await expect(page.locator(SEL.overlay)).toHaveCount(0);

        // …and it must STAY off: the storefront mutates continuously, and the
        // observer that re-badges fresh capsules has to be gated too.
        await page.evaluate(() => {
            const root = document.getElementById('page_root') || document.body;
            root.appendChild(document.createElement('div'));
        });
        await page.waitForTimeout(800);   // the observer's own debounce is 200 ms
        await expect(page.locator(SEL.overlay)).toHaveCount(0);

        // Nothing was thrown away — the session map still owns the appid, so
        // re-enabling repaints the very same badge without a reload.
        await setExtensionStorage(context, { ilap_master_enabled: true });
        await expect(searchRow(page, appid).locator(SEL.overlay)).toBeVisible({ timeout: DRAIN_TIMEOUT });
    });

    test('Master OFF: a swipe paints nothing and queues nothing', async ({ page, context }) => {
        // Set BEFORE the navigation so the content script's first config read
        // already sees the extension disabled.
        await setExtensionStorage(context, { ilap_master_enabled: false });
        const calls = await gotoWithStubs(page, context, searchUrl());

        const { link } = await pickFirstRow(page);
        await rightClickSwipe(page, link, 60);

        await page.waitForTimeout(1500);
        await expect(page.locator(SEL.overlay)).toHaveCount(0);
        expect(calls.length).toBe(0);
        // Asserted on the QUEUE, not just on the absent POST: a wrongly accepted
        // swipe would sit in the queue long after this wait.
        expect(await miJob(context)).toBeNull();
    });

    // The same question on the surface that stacks the most badge shapes at once:
    // a /tags/ sale page renders several DISTINCT capsule blocks (hover strip →
    // Direct Image, sale grid → grid, each its own ContainerStrategyProvider path),
    // and the SAME game routinely appears in more than one of them. Every badge
    // the extension painted has to go — not the first one found, not the ones in
    // the block that happens to be in view.
    test('Master OFF clears every badge on a /tags/ page — all blocks, all duplicate capsules', async ({ page, context }) => {
        test.setTimeout(180000);   // seedTagPage navigates twice and scrolls both times

        // Blur on, so the veils painted over the art are part of what must go
        // (unrender takes the class and the backdrop with the badge).
        await setExtensionStorage(context, { ilap_mask_enabled: true });
        await seedTagPage(page);

        const snap = () => page.evaluate((blocks) => {
            const per = {};
            for (const b of document.querySelectorAll('.ilap-ignored-overlay')) {
                const id = b.dataset.ilapAppid;
                per[id] = (per[id] || 0) + 1;
            }
            const dup = Object.entries(per).find(([, n]) => n > 1);
            return {
                total: Object.values(per).reduce((a, b) => a + b, 0),
                blocks: blocks.filter(sel => document.querySelector(`${sel} .ilap-ignored-overlay`)).length,
                dupAppid: dup ? dup[0] : null,
                dupCount: dup ? dup[1] : 0,
                veils: document.querySelectorAll('.ilap-ignored-blur, .ilap-blur-backdrop').length,
            };
        }, BLOCKS);

        await expect.poll(async () => (await snap()).total, { timeout: 20000 }).toBeGreaterThan(0);

        // The duplicate case is the point of this test, so it is not left to
        // Steam's shuffling: when the page happens to render each seeded game
        // once, clone a badged capsule (stripped of every ILAP artifact, so the
        // duplicate detector treats it as a fresh capsule) and let the observer
        // badge the copy. Either way, one appid ends up with two badges.
        let before = await snap();
        if (!before.dupAppid) {
            const cloned = await page.evaluate(() => {
                const badge = document.querySelector('.ilap-ignored-overlay');
                const host = badge && badge.parentElement;
                if (!host || !host.parentElement) return null;
                const copy = host.cloneNode(true);
                copy.querySelectorAll('.ilap-ignored-overlay, .ilap-blur-backdrop').forEach(e => e.remove());
                copy.querySelectorAll('.ilap-ignored-blur').forEach(e => {
                    e.classList.remove('ilap-ignored-blur');
                    delete e.dataset.ilapBlur;
                });
                delete copy.dataset.ilapState;
                delete copy.dataset.ilapIgnoreId;
                copy.querySelectorAll('[data-ilap-state]').forEach(e => delete e.dataset.ilapState);
                host.parentElement.appendChild(copy);
                return badge.dataset.ilapAppid;
            });
            expect(cloned, 'no badged capsule to duplicate').not.toBeNull();
            await expect.poll(async () => (await snap()).dupCount, { timeout: 10000 }).toBeGreaterThan(1);
            before = await snap();
        }
        expect(before.dupCount, 'one game should carry a badge on more than one capsule').toBeGreaterThan(1);

        // OFF — every badge on the page, in every block, including the duplicates
        // and the blur/veils that ride them.
        await setExtensionStorage(context, { ilap_master_enabled: false });
        await expect.poll(async () => (await snap()).total, { timeout: 10000 }).toBe(0);
        expect((await snap()).veils).toBe(0);

        // …and it stays clean while the page keeps mounting capsules under it.
        await scrollTagPage(page);
        expect((await snap()).total).toBe(0);

        // ON — the whole picture comes back, duplicates and all: nothing was
        // thrown away, the session map is still the badge model.
        await setExtensionStorage(context, { ilap_master_enabled: true });
        await expect.poll(async () => (await snap()).dupCount, { timeout: 15000 }).toBeGreaterThan(1);
        const after = await snap();
        expect(after.blocks).toBeGreaterThanOrEqual(before.blocks);
    });
});
