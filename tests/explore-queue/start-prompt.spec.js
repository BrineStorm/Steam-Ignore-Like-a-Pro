const { test, expect } = require('../_fixtures.js');
const { AUTH_FILE, SEL, openExploreQueue, readSession, interceptIgnoreApi } = require('./_helpers');
const { setExtensionStorage, getExtensionStorage } = require('../_extension.js');
const { routeSaleReward } = require('../_steam-routes.js');

test.use({ storageState: AUTH_FILE });

test.describe('Explore Queue — start prompt', () => {

    test('Toast appears on first visit with Run / Disable buttons', async ({ page }) => {
        await openExploreQueue(page);

        const toast = page.locator(SEL.toast);
        await expect(toast).toBeVisible({ timeout: 15000 });
        await expect(toast).toContainText(/queue helper/i);

        await expect(page.locator(SEL.runBtn)).toBeVisible();
        await expect(page.locator(SEL.disableBtn)).toBeVisible();
    });

    test('Mode badge defaults to Bad Reviews', async ({ page }) => {
        await openExploreQueue(page);

        const badge = page.locator(SEL.modeBadge);
        await expect(badge).toBeVisible({ timeout: 15000 });
        await expect(badge).toContainText(/bad reviews/i);
    });

    test('Close (✕) hides toast without setting any intent', async ({ page }) => {
        await openExploreQueue(page);

        await expect(page.locator(SEL.toast)).toBeVisible({ timeout: 15000 });
        await page.locator(SEL.closeX).click();
        await expect(page.locator(SEL.toast)).toHaveCount(0);

        const session = await page.evaluate(() => ({
            active: sessionStorage.getItem('ilap_queue_active'),
        }));
        expect(session.active).toBeNull();
    });

    // The one-time automation notice (src/automation-notice.js): the first Run
    // asks, a Cancel starts nothing and asks again next time, Start runs and is
    // remembered. Every ignore is route-faked.
    test('First Run asks once: Cancel starts nothing, Start runs and is remembered', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        await openExploreQueue(page);
        await expect(page.locator(SEL.runBtn)).toBeVisible({ timeout: 15000 });

        await page.locator(SEL.runBtn).click();
        const notice = page.locator(SEL.notice);
        await expect(notice).toBeVisible({ timeout: 5000 });
        await expect(notice).toContainText(/4\.C/);
        await expect(notice.locator('a[href*="subscriber_agreement"]')).toHaveCount(1);
        // Centred in the viewport, with our icon in it: it must not read as Steam's.
        const box = await notice.boundingBox();
        // The client box, not the window: a page scrollbar is outside what is centred.
        const vp = await page.evaluate(() => ({
            width: document.documentElement.clientWidth, height: document.documentElement.clientHeight,
        }));
        expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(3);
        expect(Math.abs(box.y + box.height / 2 - vp.height / 2)).toBeLessThan(3);
        await expect(notice.locator('img[src*="icon48.png"]')).toBeVisible();

        await page.locator(SEL.noticeCancel).click();
        await expect(notice).toHaveCount(0);
        await expect(page.locator(SEL.runBtn)).toBeVisible();   // the prompt stays
        expect((await readSession(page)).ACTIVE).toBeNull();
        expect((await getExtensionStorage(context, 'ilap_automation_ack')).ilap_automation_ack).toBeUndefined();
        expect(calls).toHaveLength(0);

        await page.locator(SEL.runBtn).click();
        await expect(notice).toBeVisible({ timeout: 5000 });
        await page.locator(SEL.noticeGo).click();
        await expect(notice).toHaveCount(0);
        await expect.poll(async () => (await readSession(page)).ACTIVE).toBe('true');
        expect((await getExtensionStorage(context, 'ilap_automation_ack')).ilap_automation_ack).toBe(true);
    });

    // Auto-advance while the sale's queue reward is unearned: the game is still
    // ignored, but the page stays put, and Steam's Next button is outlined
    // (orange to gold) with the reason below it on hover. The reward is route-faked to 0 of 3, so this
    // holds whatever the account has earned and whether or not a sale is on; the
    // ignore is route-faked too.
    test('Auto-advance with the sale reward unearned: ignores, stays, Next says why', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        await routeSaleReward(context, { earned: 0 });
        // 'all' so this game is ignored whatever its reviews.
        await setExtensionStorage(context, {
            ilap_q_master: true, ilap_q_next: true, ilap_q_mode: 'all', ilap_automation_ack: true,
        });

        const appid = await openExploreQueue(page);
        await expect(page.locator(SEL.runBtn)).toBeVisible({ timeout: 15000 });
        await page.locator(SEL.runBtn).click();

        await expect.poll(() => calls.length, { timeout: 15000 }).toBe(1);
        const next = page.locator(SEL.nextBtn);
        // Along the flag's contour: a filter, not a box-shadow.
        await expect.poll(() => next.evaluate((el) => el.style.filter), { timeout: 10000 })
            .toContain('ilap-lock-outline');
        expect(await page.locator('#ilap-lock-outline feMorphology').count()).toBe(1);
        // Steam's own tooltip is off while ours speaks for the button.
        expect(await next.getAttribute('data-tooltip-text')).toBeNull();
        const tip = page.locator('.ilap-advance-tip');
        await expect(tip).toBeHidden();
        await next.hover();
        await expect(tip).toBeVisible();
        await expect(tip).toContainText(/one queue completely by hand/i);
        // Below the button.
        const nextBox = await next.boundingBox();
        expect((await tip.boundingBox()).y).toBeGreaterThanOrEqual(nextBox.y + nextBox.height);
        // Past the 2 s advance an earned reward would have scheduled.
        await page.waitForTimeout(3500);
        expect(page.url()).toContain(`/app/${appid}`);
    });

    // Steam's Next carries its own tooltip (div.store_tooltip, drawn on hover from
    // data-tooltip-text), which would sit over ours. The lock takes the attribute
    // off; this checks that is enough even when Next was hovered BEFORE the lock,
    // i.e. after Steam's tooltip code has already read the text once.
    test("Steam's own Next tooltip stays off under the lock, even after a hover before it", async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        await routeSaleReward(context, { earned: 0 });
        await setExtensionStorage(context, {
            ilap_q_master: true, ilap_q_next: true, ilap_q_mode: 'all', ilap_automation_ack: true,
        });

        await openExploreQueue(page);
        await expect(page.locator(SEL.runBtn)).toBeVisible({ timeout: 15000 });
        const next = page.locator(SEL.nextBtn);
        const steamText = await next.getAttribute('data-tooltip-text');
        expect(steamText, 'Steam no longer puts a tooltip on Next: drop this test').toBeTruthy();
        const steamTip = page.locator('.store_tooltip', { hasText: steamText.slice(0, 30) });

        await next.hover();
        await expect(steamTip, "the probe does not see Steam's tooltip at all").toBeVisible({ timeout: 5000 });
        await page.mouse.move(0, 0);
        await expect(steamTip).toBeHidden({ timeout: 5000 });

        await page.locator(SEL.runBtn).click();
        await expect.poll(() => calls.length, { timeout: 15000 }).toBe(1);
        await expect.poll(() => next.evaluate((el) => el.style.filter), { timeout: 10000 })
            .toContain('ilap-lock-outline');

        await next.hover();
        await expect(page.locator('.ilap-advance-tip')).toBeVisible();
        await page.waitForTimeout(1500);   // Steam's tooltip shows within a few hundred ms
        await expect(steamTip).toBeHidden();
    });
});
