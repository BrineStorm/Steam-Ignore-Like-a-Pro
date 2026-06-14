const { test, expect } = require('../_fixtures.js');
const { setExtensionStorage, clearExtensionStorage } = require('../_extension.js');

const SEL = {
    queueWidget: '.SaleSectionCtn.discoveryqueue div[role="button"]',
    modal: '.FullModalOverlay div[role="dialog"]',
    panel: '#ilap-queue-controls',
    button: '#queue-auto-ignore-btn',
};

// Copy of the helper from ui.spec.js — kept inline so this regression spec is
// self-contained (the rest of the DQ specs assume master=ON). The DQ modal opens
// from the "Explore Your Discovery Queue" widget below the fold on a tag page.
async function openQueueModal(page) {
    await page.goto('/tags/en/Collectathon');
    const widget = page.locator(SEL.queueWidget).first();
    await widget.waitFor({ state: 'attached', timeout: 15000 });
    await widget.scrollIntoViewIfNeeded();
    await widget.click();

    const modal = page.locator(SEL.modal).first();
    await modal.waitFor({ state: 'visible', timeout: 15000 });
    return modal;
}

// Roll master back to ON after each run so other DQ specs are unaffected.
test.afterEach(async ({ context }) => {
    await setExtensionStorage(context, { ilap_q_master: true });
    await clearExtensionStorage(context);
});

test.describe('Discovery Queue — master toggle gates the panel', () => {

    test('ilap_q_master=false → panel does not mount inside the modal', async ({ page, context }) => {
        // Set the flag BEFORE navigation so the content script's init reads
        // false on the very first storage probe.
        await clearExtensionStorage(context);
        await setExtensionStorage(context, { ilap_q_master: false });

        await openQueueModal(page);

        // Give the MutationObserver a beat — if the panel were going to
        // mount, it would have by now.
        await page.waitForTimeout(1500);

        await expect(page.locator(SEL.panel)).toHaveCount(0);
        await expect(page.locator(SEL.button)).toHaveCount(0);
    });

    test('Flipping ilap_q_master to false while modal is open retracts the panel', async ({ page, context }) => {
        // Start with master ON so the panel mounts as usual.
        await clearExtensionStorage(context);
        await setExtensionStorage(context, { ilap_q_master: true });

        await openQueueModal(page);
        await expect(page.locator(SEL.panel)).toBeVisible({ timeout: 10_000 });

        // Now disable. The onChanged listener should unmount the panel and
        // stop any in-flight loop.
        await setExtensionStorage(context, { ilap_q_master: false });
        await expect(page.locator(SEL.panel)).toHaveCount(0, { timeout: 5000 });
    });
});
