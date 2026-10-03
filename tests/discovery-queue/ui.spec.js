const { test, expect } = require('../_fixtures.js');
const { setExtensionStorage, getExtensionStorage } = require('../_extension.js');
const { interceptIgnoreApi } = require('../curator/_helpers.js');
const { routeSaleReward } = require('../_steam-routes.js');
const { SEL, openQueueModal } = require('./_modal.js');   // shared with palette + keep-high-score specs

test.describe('Discovery Queue UI', () => {

    test('Panel injects inside the queue modal with button + checkbox', async ({ page }) => {
        const modal = await openQueueModal(page);

        const panel = modal.locator(SEL.panel);
        await expect(panel).toBeVisible({ timeout: 10000 });

        await expect(panel.locator(SEL.button)).toBeVisible();
        await expect(panel.locator('.ilap-checkbox')).toBeAttached();
        await expect(panel.locator('.ilap-checkbox-label')).toContainText(/keep high score/i);
    });

    test('Button initial state: idle (no running class, "Start Auto Ignore")', async ({ page }) => {
        await openQueueModal(page);

        const btn = page.locator(SEL.button);
        await expect(btn).toBeVisible({ timeout: 10000 });
        await expect(btn).not.toHaveClass(/running/);
        await expect(btn).toContainText(/start auto ignore/i);
    });

    test('Keep High Score checkbox is interactive and toggles state', async ({ page }) => {
        await openQueueModal(page);

        const checkbox = page.locator(SEL.checkbox);
        await expect(checkbox).toBeAttached({ timeout: 10000 });
        await expect(checkbox).not.toBeChecked();

        // Click via label so we cover both label text and the input itself
        await page.locator('#ilap-queue-controls .ilap-checkbox-label').click();
        await expect(checkbox).toBeChecked();

        await page.locator('#ilap-queue-controls .ilap-checkbox-label').click();
        await expect(checkbox).not.toBeChecked();
    });

    // DQ automator ignores by a LIVE click on Steam's in-page Ignore button —
    // our code sends no POST, but Steam's page JS fires one in response to the
    // click, so DQ is an ignore-POST source too and paces through the rate gate
    // like the drainer and EQ. This DOES ignore real games on the test account —
    // accepted: globalSetup/globalTeardown remove strictly the diff afterwards
    // (see tests/_cleanup.js). The target is deliberately PAST one served queue:
    // a queue holds exactly 12 games (probed live — twelve slides, then a
    // "Done / Continue" interstitial), so a run of 14 cannot finish unless the
    // automator clicks "Continue" and keeps going on the fresh queue. That makes
    // the infinite-feed path guaranteed coverage rather than luck-of-the-pool,
    // and it is the end-to-end guard on the stale-card regression that used to
    // wedge the loop here (unit-covered in automator.unit.spec.js).
    test('Start runs the loop, ignores 14 games across a queue boundary (Continue), Stop → idle', async ({ page, context }) => {
        test.setTimeout(190_000);   // must clear the 150s counter poll below plus the modal open and the Stop assertions
        // The automation notice is accepted up front (its own spec:
        // explore-queue/start-prompt.spec.js). Start also asks the sale reward,
        // live: the test account has earned it, so the run goes ahead.
        await setExtensionStorage(context, { ilap_automation_ack: true });
        await openQueueModal(page);

        const btn = page.locator(SEL.button);
        await expect(btn).toBeVisible({ timeout: 10000 });
        await expect(btn).not.toHaveClass(/running/);

        // The active slide (and its Ignore button) renders a beat after the modal;
        // wait for the current game's app link so the very first iteration has a
        // slide to act on.
        await page.locator(`${SEL.modal} a[href*="/app/"]`).first()
            .waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});

        await btn.click();

        // Loop engaged.
        await expect(btn).toHaveClass(/running/, { timeout: 5000 });
        await expect(btn).toContainText(/stop/i);

        // The running button label carries the processed (ignored) counter. Wait
        // until it reaches the target.
        const TARGET = 14;   // > the 12 a single served queue holds — forces one Continue
        await expect.poll(async () => {
            const txt = (await btn.textContent()) || '';
            const m = txt.match(/(\d+)/);
            return m ? Number(m[1]) : 0;
        // Generous on purpose. A run on an untouched tag pool spends ~1.5 s per
        // ignore (loop pause + a paced gate slot + the button-signal confirm +
        // the slide advance) and lands all twelve in well under half a minute;
        // the budget covers the slow shape instead — a pool the automator has
        // already been through, where most iterations are Continue interstitials
        // and confirms fall back to the userdata poll.
        }, { timeout: 150_000, intervals: [1500] }).toBeGreaterThanOrEqual(TARGET);

        // Stop → back to idle.
        await btn.click();
        await expect(btn).not.toHaveClass(/running/, { timeout: 10000 });
        await expect(btn).toContainText(/start auto ignore/i);

        // Stopping frees this tab's registry slot (the UI observer's isRunning=false
        // transition → _releaseSlot), so no live owner should remain in ilap_dq_active.
        await expect.poll(async () => {
            const map = (await getExtensionStorage(context, 'ilap_dq_active')).ilap_dq_active || {};
            const now = Date.now();
            return Object.values(map).filter(exp => exp > now).length;
        }, { timeout: 6000 }).toBe(0);
    });

    // Cross-tab cap: two OTHER live registry slots fill the cap (2), so this tab's
    // Start is refused — it flashes the "already running" message and never starts
    // the loop (no ignore fires). Simulating the other tabs via a seeded
    // ilap_dq_active keeps it a pure UI-path check with zero real ignores.
    test('Start is refused when the concurrent-DQ cap is already filled by other tabs', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context); // guarantee no real ignore even if it slipped
        await setExtensionStorage(context, { ilap_automation_ack: true });   // the cap is asked after the notice
        await openQueueModal(page);

        const btn = page.locator(SEL.button);
        await expect(btn).toBeVisible({ timeout: 10000 });

        const future = Date.now() + 60000;
        await setExtensionStorage(context, { ilap_dq_active: { other1: future, other2: future } });

        await btn.click();

        // Refused look, never entered the running state, and nothing was ignored.
        await expect(btn).toHaveClass(/refused/, { timeout: 5000 });
        await expect(btn).not.toHaveClass(/running/);
        await expect(btn).toContainText(/\d/); // localized "Max {n} …" carries the numeral
        expect(calls).toHaveLength(0);

        // The message auto-reverts to the idle Start button.
        await expect(btn).not.toHaveClass(/refused/, { timeout: 6000 });
        await expect(btn).toContainText(/start auto ignore/i);
    });

    test('Panel unmounts when the queue modal closes', async ({ page }) => {
        await openQueueModal(page);

        const panel = page.locator(SEL.panel);
        await expect(panel).toBeVisible({ timeout: 10000 });

        // Prefer Steam's own close button; fall back to Escape.
        const close = page.locator(SEL.closeBtn).first();
        if (await close.isVisible().catch(() => false)) {
            await close.click({ force: true });
        } else {
            await page.keyboard.press('Escape');
        }

        await expect(panel).toBeHidden({ timeout: 10000 });
    });

    // Start while the sale's queue reward is unearned: refused before the notice
    // and before the cap, the button outlined in gold with the reason above it on hover.
    // A second click asks Steam again rather than trusting the cached 'pending' (a
    // queue just finished by hand must count at once), and is refused again. The
    // reward is route-faked to 0 of 3, so this holds whatever the account has earned.
    test('Start is refused while the sale reward is unearned, locked with the reason on hover', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        await routeSaleReward(context, { earned: 0 });
        let rewardRequests = 0;
        page.on('request', (r) => { if (r.url().includes('ISaleItemRewardsService')) rewardRequests++; });
        await openQueueModal(page);

        const btn = page.locator(SEL.button);
        await expect(btn).toBeVisible({ timeout: 10000 });
        await btn.click();

        await expect(btn).toHaveClass(/locked/, { timeout: 10000 });
        await btn.hover();
        // Visible, not merely present: Steam's modal is a top-layer <dialog>, and
        // only what is drawn inside it shows above it.
        const tip = page.locator('.ilap-dq-tip');
        await expect(tip).toBeVisible();
        await expect(tip).toContainText(/one queue completely by hand/i);
        // Above the button, not over the card below it.
        const tipBox = await tip.boundingBox();
        expect(tipBox.y + tipBox.height).toBeLessThanOrEqual((await btn.boundingBox()).y);
        // The tip takes no pointer events, which hit-testing skips: lift that for
        // the probe only.
        expect(await tip.evaluate((el) => {
            el.style.pointerEvents = 'auto';
            const r = el.getBoundingClientRect();
            const onTop = el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
            el.style.pointerEvents = '';
            return onTop;
        })).toBe(true);
        await expect(page.locator('.ilap-notice')).toHaveCount(0);
        await expect(btn).not.toHaveClass(/running/);

        const asked = rewardRequests;
        expect(asked).toBeGreaterThan(0);
        await btn.click();
        await expect.poll(() => rewardRequests).toBeGreaterThan(asked);
        await expect(btn).not.toHaveClass(/checking/);
        await expect(btn).toHaveClass(/locked/);
        expect(calls).toHaveLength(0);
    });

    // The one-time automation notice drawn over Steam's modal: answering it must
    // not read as a click outside the modal (which would close the queue under
    // the run), and Start must start the run behind it. Both spellings of the
    // ignore endpoint are route-faked — Steam's own page posts to the one with no
    // trailing slash — so nothing reaches the account; the run is stopped at once.
    test('First Start asks once over the modal: Cancel starts nothing, Start keeps the modal and runs', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        await context.route('**/recommended/ignorerecommendation', (route) => route.fulfill({
            status: 200, contentType: 'application/json', body: JSON.stringify({ success: 1 }),
        }));
        await openQueueModal(page);

        const btn = page.locator(SEL.button);
        await expect(btn).toBeVisible({ timeout: 10000 });
        const notice = page.locator('.ilap-notice');

        await btn.click();
        await expect(notice).toBeVisible({ timeout: 10000 });
        // Focus on the safe answer, not on the first focusable element (the
        // agreement link): an Enter right after the click must not open a tab.
        await expect(page.locator('.ilap-notice-cancel')).toBeFocused();
        // Centred in the viewport, with our icon in it: it must not read as Steam's.
        const box = await notice.boundingBox();
        // The client box, not the window: a page scrollbar is outside what is centred.
        const vp = await page.evaluate(() => ({
            width: document.documentElement.clientWidth, height: document.documentElement.clientHeight,
        }));
        expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(3);
        expect(Math.abs(box.y + box.height / 2 - vp.height / 2)).toBeLessThan(3);
        await expect(notice.locator('img[src*="icon48.png"]')).toBeVisible();
        await page.locator('.ilap-notice-cancel').click();
        await expect(notice).toHaveCount(0);
        await expect(page.locator(SEL.modal)).toBeVisible();
        await expect(btn).not.toHaveClass(/running/);
        expect((await getExtensionStorage(context, 'ilap_automation_ack')).ilap_automation_ack).toBeUndefined();

        await btn.click();
        await expect(notice).toBeVisible({ timeout: 10000 });
        await page.locator('.ilap-notice-go').click();
        await expect(notice).toHaveCount(0);
        await expect(page.locator(SEL.modal)).toBeVisible();
        await expect(btn).toHaveClass(/running/, { timeout: 5000 });
        expect((await getExtensionStorage(context, 'ilap_automation_ack')).ilap_automation_ack).toBe(true);

        await btn.click();   // Stop
        await expect(btn).not.toHaveClass(/running/, { timeout: 10000 });
        expect(calls.filter(c => !c.remove)).toHaveLength(calls.length);   // nothing but fakes
    });
});
