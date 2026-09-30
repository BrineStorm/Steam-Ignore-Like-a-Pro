const { test, expect } = require('../_fixtures.js');
const { setExtensionStorage, clearExtensionStorage } = require('../_extension.js');
const { tagUrl } = require('../_tags.js'); // random tag page per navigation

const SEL = {
    queueSection: '.SaleSectionCtn.discoveryqueue',
    queueWidget: '.SaleSectionCtn.discoveryqueue div[role="button"]',
    modal: '.FullModalOverlay div[role="dialog"]',
    panel: '#ilap-queue-controls',
    button: '#queue-auto-ignore-btn',
};

// Copy of the helper from ui.spec.js — kept inline so this regression spec is
// self-contained (the rest of the DQ specs assume master=ON). The DQ modal opens
// from the "Explore Your Discovery Queue" widget below the fold on a tag page.
// The section is lazy-rendered, so scroll until it attaches before waiting.
async function openQueueModal(page) {
    await page.goto(tagUrl(), { waitUntil: 'domcontentloaded' });
    const section = page.locator(SEL.queueSection).first();
    for (let i = 0; i < 10 && !(await section.count()); i++) {
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(500);
    }
    await section.waitFor({ state: 'attached', timeout: 20000 });
    await section.scrollIntoViewIfNeeded();

    const widget = page.locator(SEL.queueWidget).first();
    await widget.waitFor({ state: 'visible', timeout: 20000 });
    await widget.click();

    const modal = page.locator(SEL.modal).first();
    await modal.waitFor({ state: 'visible', timeout: 15000 });
    return modal;
}

// Roll both masters back to ON after each run so other DQ specs are unaffected.
// Clearing IS that roll-back: absent counts as enabled for either key, so a
// set() of `true` ahead of it would only be overwritten a line later.
test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Discovery Queue — master toggle gates the panel', () => {

    // `ilap_q_master` is the Classic Discovery Queue's own switch. This panel
    // answers to the global master only: a Start nobody presses does nothing,
    // so there is nothing for the Classic switch to hide here.
    test('ilap_q_master=false → panel still mounts inside the modal', async ({ page, context }) => {
        // Set the flag BEFORE navigation so the content script's init reads
        // false on the very first storage probe.
        await clearExtensionStorage(context);
        await setExtensionStorage(context, { ilap_q_master: false });

        await openQueueModal(page);

        await expect(page.locator(SEL.panel)).toBeVisible({ timeout: 10_000 });
        await expect(page.locator(SEL.button)).toBeVisible();
    });

    // The GLOBAL master (the panel's own on/off), not the queue toggle. It used
    // to be missing from this module entirely: a disabled extension still mounted
    // the panel and offered a Start the rate gate could only refuse — silently,
    // one slide in.
    test('ilap_master_enabled=false → panel does not mount inside the modal', async ({ page, context }) => {
        await clearExtensionStorage(context);
        await setExtensionStorage(context, { ilap_master_enabled: false });

        await openQueueModal(page);
        await page.waitForTimeout(1500);

        await expect(page.locator(SEL.panel)).toHaveCount(0);
        await expect(page.locator(SEL.button)).toHaveCount(0);
    });

    test('Flipping the global master off retracts the panel; back on re-mounts it at its DEFAULTS', async ({ page, context }) => {
        await clearExtensionStorage(context);
        await setExtensionStorage(context, { ilap_master_enabled: true });

        await openQueueModal(page);
        await expect(page.locator(SEL.panel)).toBeVisible({ timeout: 10_000 });

        // Tick Keep High Score, so the re-mount below has something to forget.
        // The setting is panel-lifetime state by design — it is stored nowhere.
        //
        // What this asserts is the VISIBLE half: the box the user is shown after a
        // flip. On its own it proves little — `ui.mount` builds a fresh checkbox
        // every time, so this box is unticked whatever the automator thinks. The
        // other half, that the automator's `skipPositive` was cleared with it, is
        // reachable from no page (the config is stored nowhere) and is asserted in
        // controller.unit.spec.js instead. Both halves or neither: an unticked box
        // over a config that still skips is exactly the lie this pair rules out.
        const checkbox = page.locator(`${SEL.panel} .ilap-checkbox`);
        await checkbox.check();
        await expect(checkbox).toBeChecked();

        await setExtensionStorage(context, { ilap_master_enabled: false });
        await expect(page.locator(SEL.panel)).toHaveCount(0, { timeout: 5000 });

        // Re-enabling with the modal still open puts the panel back the way a
        // freshly opened one looks: the Start button (not a stale "Stop (N)") and
        // an unticked Keep High Score.
        await setExtensionStorage(context, { ilap_master_enabled: true });
        const btn = page.locator(SEL.button);
        await expect(btn).toBeVisible({ timeout: 5000 });
        await expect(btn).not.toHaveClass(/running/);
        await expect(btn).toContainText(/start auto ignore/i);
        await expect(page.locator(`${SEL.panel} .ilap-checkbox`)).not.toBeChecked();
    });
});
