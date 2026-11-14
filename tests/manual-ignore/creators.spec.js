const { test, expect } = require('../_fixtures.js');
const {
    DRAIN_TIMEOUT,
    rightClickSwipe,
    routeLoginProbe,
    gotoWithStubs,
} = require('./_helpers');
const {
    clearExtensionStorage, setExtensionStorage, getExtensionStorage,
} = require('../_extension.js');

// Steam's creator ignore on a game's page (src/manual-ignore/creators-ui.js):
// the pill on a creator's link, the grey of an ignored one, the gesture. The
// creator POST (curators/ajaxignore) is sent by a store tab's drainer only, so
// a network route sees it, and it is answered here: nothing reaches Steam.
// Portal 2's developer and publisher are both Valve (clan 4).

const GAME = 'https://store.steampowered.com/app/620/Portal_2/';
const VALVE = '4';
// A game whose developer and publisher (Hede) have no page of their own:
// their links are store searches, and GetItems gives them no clan id.
const NO_PAGE_GAME = 'https://store.steampowered.com/app/4256830/';

// Record every creator POST and answer it as Steam does: { clanid, ignore }.
async function interceptCreatorApi(context) {
    const calls = [];
    await context.route('**/curators/ajaxignore', async (route) => {
        const params = new URLSearchParams(route.request().postData() || '');
        calls.push({ clanid: params.get('clanid'), ignore: params.get('ignore') });
        await route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify({ success: { success: 1 }, clanid: Number(params.get('clanid')) }) });
    });
    return calls;
}

// Hover the link, then the pill, until our tooltip under it is faded in.
async function hoverLockedPill(page) {
    await expect(async () => {
        await devLink(page).evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await devLink(page).hover();
        await expect(pillOf(page)).toBeVisible({ timeout: 1500 });
        await pillSettled(page);
        await pillOf(page).hover({ timeout: 2000 });
        await expect(tipOf(page)).toHaveCSS('opacity', '1', { timeout: 1500 });
    }).toPass({ timeout: 20000 });
}

// A locked pill: greyed, a padlock, no action, its reason described by our tooltip.
async function expectLocked(page, reason) {
    await expect(pillOf(page)).toHaveText('Ignore creator');
    await expect(pillOf(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(pillOf(page).locator('.ilap-cpill-lock')).toHaveCount(1);
    await expect(pillOf(page)).toHaveAccessibleDescription(reason);
    await expect(tipOf(page)).toHaveText(reason);
}

// The developer row's link, the one the glance block shows first.
const devLink = (page) => page.locator('#developers_list a').first();
const pillOf = (page) => page.locator('#developers_list .ilap-cpill').first();
const tipOf = (page) => page.locator('.ilap-cpill-tip');
// The pill slides out over its transition. An action started during it spends
// Playwright's first retries on "not stable", and the fourth retry scrolls the
// pill to the window's top edge, under Steam's sticky store menu.
const pillSettled = (page) => pillOf(page).evaluate((el) =>
    Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {}))));

// Hover the link and click its pill. The row goes to the middle of the window
// first: scrolled to the top edge, it sits under Steam's sticky store menu,
// which then takes the click. Retried: Steam lays the creator rows out again
// after load (long names are collapsed), which can take a pill away under the
// pointer; the next mutation pass puts a new one in.
async function clickPill(page, text) {
    await expect(async () => {
        await devLink(page).evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await devLink(page).hover();
        await expect(pillOf(page)).toHaveText(text, { timeout: 1500 });
        await pillSettled(page);
        await pillOf(page).click({ timeout: 2000 });
    }).toPass({ timeout: 20000 });
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    await routeLoginProbe(context, true);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — creators', () => {

    test('the pill ignores the creator, greys its links, and takes it back', async ({ page, context }) => {
        const calls = await interceptCreatorApi(context);
        await gotoWithStubs(page, context, GAME);

        await clickPill(page, 'Ignore creator');

        // Grey at once, from the waiting entry; then the POST.
        await expect(devLink(page)).toHaveAttribute('data-ilap-creator', 'ignored');
        await expect.poll(() => calls, { timeout: DRAIN_TIMEOUT }).toEqual([{ clanid: VALVE, ignore: '1' }]);
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_creators')).ilap_creators,
            { timeout: DRAIN_TIMEOUT }).toMatchObject({ ignored: { [VALVE]: 'Valve' } });
        // The history is written after the mirror, in the same landing.
        await expect.poll(async () => ((await getExtensionStorage(context, 'ilap_ignored_history'))
            .ilap_ignored_history || [])[0], { timeout: DRAIN_TIMEOUT })
            .toEqual({ name: 'Valve', source: 'Creator', curatorId: VALVE });
        // Every link of the creator on the page, the publisher row's too.
        await expect(page.locator('.dev_row a[data-ilap-creator="ignored"]')).not.toHaveCount(0);

        await clickPill(page, 'Un-ignore creator');
        await expect(devLink(page)).not.toHaveAttribute('data-ilap-creator', 'ignored');
        await expect.poll(() => calls.length, { timeout: DRAIN_TIMEOUT }).toBe(2);
        expect(calls[1]).toEqual({ clanid: VALVE, ignore: '0' });
    });

    test('with the game\'s creators unread, the pill still works through the creator\'s page', async ({ page, context }) => {
        const calls = await interceptCreatorApi(context);
        await context.route('**/IStoreBrowseService/GetItems/**', (route) => route.abort());
        await gotoWithStubs(page, context, GAME);

        await clickPill(page, 'Ignore creator');
        await expect.poll(() => calls, { timeout: DRAIN_TIMEOUT }).toEqual([{ clanid: VALVE, ignore: '1' }]);
        await expect(devLink(page)).toHaveAttribute('data-ilap-creator', 'ignored');
    });

    test('keyboard focus on the link brings the pill out and Tab reaches it', async ({ page, context }) => {
        await gotoWithStubs(page, context, GAME);
        await devLink(page).focus();
        await expect(pillOf(page)).toBeVisible();
        await page.keyboard.press('Tab');
        await expect(pillOf(page)).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(pillOf(page)).toBeHidden();
    });

    test('a followed creator gets a locked pill with its reason, and its gesture is refused with a word', async ({ page, context }) => {
        const calls = await interceptCreatorApi(context);
        await setExtensionStorage(context, { ilap_creators: { ignored: {}, followed: [VALVE] } });
        await gotoWithStubs(page, context, GAME);

        await hoverLockedPill(page);
        const reason = 'You follow this creator. Unfollow it on Steam to ignore it';
        await expectLocked(page, reason);
        // A real click on it does nothing (force: Playwright takes aria-disabled for disabled).
        await pillOf(page).click({ force: true });
        await rightClickSwipe(page, devLink(page), 60);
        await expect(page.locator('.ilap-toast')).toContainText('You follow this creator');
        const { ilap_curator_queue: queue } = await getExtensionStorage(context, 'ilap_curator_queue');
        expect((queue || []).filter(j => j.type === 'creator')).toEqual([]);
        expect(calls).toEqual([]);
    });

    test('a creator with no page of its own gets a locked pill whose tooltip says why, and nothing is queued', async ({ page, context }) => {
        const calls = await interceptCreatorApi(context);
        // GetItems as Steam answers for this game: names with no clan id.
        await context.route('**/IStoreBrowseService/GetItems/**', (route) => route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ response: { store_items: [{ appid: 4256830,
                basic_info: { developers: [{ name: 'Hede' }], publishers: [{ name: 'Hede' }] } }] } }),
        }));
        await gotoWithStubs(page, context, NO_PAGE_GAME);
        await expect(devLink(page)).toHaveAttribute('href', /\/search\/\?developer=Hede/);

        await expect(tipOf(page)).toHaveCount(0);
        await hoverLockedPill(page);
        const reason = "This creator has no Steam page, so Steam can't ignore it";
        await expectLocked(page, reason);
        // The tooltip sits under the pill, really seen (Steam's row clips
        // what hangs out of it), and leaves no scrollbar.
        const [pill, tip] = await Promise.all([pillOf(page), tipOf(page)].map(l => l.evaluate(el => el.getBoundingClientRect().toJSON())));
        expect(tip.top).toBeGreaterThanOrEqual(pill.bottom);
        expect(await tipOf(page).evaluate((el) => {
            const r = el.getBoundingClientRect();
            return el.parentElement === document.documentElement && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        })).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        // A real click on it does nothing (force: Playwright takes aria-disabled for disabled).
        await pillOf(page).click({ force: true });
        // From the keyboard: the pill takes the focus after the link, and its reason shows.
        await page.mouse.move(0, 0);
        await devLink(page).focus();
        await page.keyboard.press('Tab');
        await expect(pillOf(page)).toBeFocused();
        await expect(tipOf(page)).toHaveCSS('opacity', '1');
        await page.waitForTimeout(500);
        const { ilap_curator_queue: queue } = await getExtensionStorage(context, 'ilap_curator_queue');
        expect((queue || []).filter(j => j.type === 'creator')).toEqual([]);
        expect(calls).toEqual([]);
    });

    test('a swipe on a creator link ignores it like the pill', async ({ page, context }) => {
        const calls = await interceptCreatorApi(context);
        await gotoWithStubs(page, context, GAME);
        await rightClickSwipe(page, devLink(page), 60);
        await expect(page.locator('.ilap-toast')).toContainText('Steam will stop recommending games by Valve');
        await expect.poll(() => calls, { timeout: DRAIN_TIMEOUT }).toEqual([{ clanid: VALVE, ignore: '1' }]);
    });

    test('with the master switch off there is no pill and no grey', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_master_enabled: false,
            ilap_creators: { ignored: { [VALVE]: 'Valve' }, followed: [] },
        });
        await gotoWithStubs(page, context, GAME);
        await expect(devLink(page)).not.toHaveAttribute('data-ilap-creator', 'ignored');
        await devLink(page).hover();
        await expect(pillOf(page)).toBeHidden();
    });
});
