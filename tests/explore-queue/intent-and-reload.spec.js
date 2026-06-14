const { test, expect } = require('../_fixtures.js');
const { SEL, openExploreQueue, readSession } = require('./_helpers');
const { setExtensionStorage } = require('../_extension.js');

// The discovery queue serves whatever game is next — callers can't pick an
// appid, so these tests assert against the appid actually returned by
// openExploreQueue (not hardcoded 730/570).

test.describe('Explore Queue — intent persistence and navigation', () => {

    test.beforeEach(async ({ context }) => {
        // autoNext OFF so Run never auto-advances the page — keeps the
        // intent/reload assertions deterministic (spared → visuals+stop;
        // ignore → API+stop; neither navigates).
        await setExtensionStorage(context, { ilap_q_master: true, ilap_q_next: false });
    });

    test('Run sets ACTIVE intent and ACTIVE_APPID (served appid) in sessionStorage', async ({ page }) => {
        const appid = await openExploreQueue(page);
        expect(appid).toBeTruthy();

        await page.locator(SEL.runBtn).click();
        await page.waitForTimeout(300);

        const session = await readSession(page);
        expect(session.ACTIVE).toBe('true');
        expect(session.ACTIVE_APPID).toBe(appid);
    });

    test('Reload of same queue page in ACTIVE state does NOT show start prompt (regression: EQ reload bug)', async ({ page }) => {
        const appid = await openExploreQueue(page);
        expect(appid).toBeTruthy();

        await page.locator(SEL.runBtn).click();
        await page.waitForTimeout(300);

        // Without the fix, reload would clear the intent and re-show the prompt.
        await page.reload();
        await page.waitForTimeout(2000);

        // Same appid → legitimate reload → no start prompt (#ilap-run-btn).
        await expect(page.locator(SEL.runBtn)).toHaveCount(0);

        const session = await readSession(page);
        expect(session.ACTIVE).toBe('true');
        expect(session.ACTIVE_APPID).toBe(appid);
    });

    test('Sideways navigation to a different appid without nav token re-shows the start prompt', async ({ page }) => {
        const appidX = await openExploreQueue(page, 0);
        expect(appidX).toBeTruthy();

        await page.locator(SEL.runBtn).click();
        await page.waitForTimeout(300);

        // Land on a DIFFERENT game's queue page via an explicit queue position.
        // A fresh load with no nav token = a sideways navigation, which must
        // reset the automation and re-prompt.
        let appidY = appidX;
        for (let pos = 1; pos <= 6 && appidY === appidX; pos++) {
            appidY = await openExploreQueue(page, pos);
        }
        expect(appidY).toBeTruthy();
        expect(appidY).not.toBe(appidX);

        await expect(page.locator(SEL.runBtn)).toBeVisible({ timeout: 15000 });

        const session = await readSession(page);
        expect(session.ACTIVE).toBeNull();
        expect(session.ACTIVE_APPID).toBeNull();
    });

    test('Manual click on Steam Next button while ACTIVE issues a nav token', async ({ page }) => {
        await openExploreQueue(page);

        const nextBtn = page.locator(SEL.nextBtn);
        if ((await nextBtn.count()) === 0) {
            test.skip(true, 'Steam did not render #nextInDiscoveryQueue on this page.');
            return;
        }

        await page.locator(SEL.runBtn).click();
        await page.waitForTimeout(300);

        // Synchronously dispatch click + read token in the same JS turn so we
        // observe the listener's effect before any navigation kicks in.
        const token = await page.evaluate(() => {
            const btn = document.querySelector('#nextInDiscoveryQueue .btn_next_in_queue_trigger');
            if (!btn) return null;
            const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
            btn.dispatchEvent(ev);
            return sessionStorage.getItem('ilap_queue_nav_token');
        });

        expect(token).not.toBeNull();
    });
});
