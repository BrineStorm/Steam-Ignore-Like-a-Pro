const { test, expect } = require('../_fixtures.js');
const { AUTH_FILE, SEL, openExploreQueue, interceptIgnoreApi } = require('./_helpers');
const { setExtensionStorage } = require('../_extension.js');

test.use({ storageState: AUTH_FILE });

// The GLOBAL master toggle vs a live Explore-Queue page. Turning the extension
// off is a full teardown of what this page is showing — the Queue-Helper toast,
// the coloured outline and its micro-badge all go, and no scheduled Next click
// survives it. Deliberately equivalent to LEAVING the queue page: turning the
// master back on does not revive automation here, it waits for the next entry to
// a ?queue= page. (The QUEUE toggle is that feature's own switch and still
// resumes in place — see disable.spec.js.)
//
// Every ignore is route-faked, so a run that lands on a Mixed/Negative game
// never touches the real account.

test.describe('Explore Queue — global master toggle', () => {

    test.afterEach(async ({ context }) => {
        await setExtensionStorage(context, { ilap_master_enabled: true });
    });

    test('Master OFF tears the page down; ON does not resume here, only a fresh entry does', async ({ page, context }) => {
        test.setTimeout(180000);
        await interceptIgnoreApi(context);
        // The automation notice is accepted up front (its own spec:
        // start-prompt.spec.js); step 4 below clicks Run.
        await setExtensionStorage(context, { ilap_automation_ack: true });

        await openExploreQueue(page);
        const toast = page.locator(SEL.toast);
        await expect(toast).toBeVisible({ timeout: 15000 });

        // 1. Off: the start prompt goes. Nothing has been drawn on the card yet
        //    (no Run), so the teardown has nothing of its own to undo and must
        //    leave Steam's inline styles on the ignore control exactly as found —
        //    `position` above all, since #ignoreBtn is the containing block its
        //    children are laid out against. Captured rather than hardcoded: the
        //    assertion is "unchanged", whatever Steam happens to set.
        const inlineStyles = () => page.evaluate(() => {
            const c = document.getElementById('ignoreBtn');
            return c ? { position: c.style.position, boxShadow: c.style.boxShadow } : null;
        });
        const beforeOff = await inlineStyles();

        await setExtensionStorage(context, { ilap_master_enabled: false });
        await expect(toast).toHaveCount(0);   // the teardown has run
        expect(await inlineStyles()).toEqual(beforeOff);

        // 2. Back on: nothing comes back on the page the user walked away from.
        await setExtensionStorage(context, { ilap_master_enabled: true });
        await page.waitForTimeout(2000);
        await expect(toast).toHaveCount(0);

        // 3. A fresh entry to a queue page is a normal start again.
        await openExploreQueue(page);
        await expect(toast).toBeVisible({ timeout: 15000 });

        // 4. Run once so the automator paints its verdict on the card (SPARED,
        //    IGNORED or NO REVIEWS — which one does not matter here), then flip
        //    the master off: the badge, its tooltip and the outline all go.
        await page.locator(SEL.runBtn).click();
        await page.locator('.ilap-micro-badge').first().waitFor({ state: 'attached', timeout: 30000 });

        await setExtensionStorage(context, { ilap_master_enabled: false });

        await expect(page.locator('.ilap-micro-badge')).toHaveCount(0);
        await expect(page.locator('.ilap-tooltip')).toHaveCount(0);
        // The outline is an inline box-shadow on the ignore control's container
        // (Context.getIgnoreContainer), which Steam renders with no shadow of its own.
        await expect.poll(async () => page.evaluate(() => {
            const c = document.getElementById('ignoreBtn');
            return c ? c.style.boxShadow : 'no #ignoreBtn';
        })).toBe('');
    });

    test('Master OFF before the visit: no toast at all', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_master_enabled: false });

        await openExploreQueue(page);
        await page.waitForTimeout(2500);

        await expect(page.locator(SEL.toast)).toHaveCount(0);
    });
});
