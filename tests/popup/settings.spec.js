const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

// Feature areas are now mutually-exclusive collapsible subcategories, so a test
// can only have ONE expanded at a time. Expand whichever the test drives:
// 'mi' (default) for Manual Ignore controls, 'dq' for Discovery Queue controls.
async function openPopupAndExpandSettings(page, context, expand = 'mi') {
    const extId = await getExtensionId(context);
    await page.goto(popupUrl(extId));
    await page.locator('#settings-accordion > summary').click();
    // Settings render lazily on accordion toggle; give it a tick.
    await page.locator('#dq-section summary').waitFor({ timeout: 5000 });
    // Click the title (not the DQ master switch, which stops propagation).
    await page.locator(`#${expand}-section summary .section-title`).click();
    await expect(page.locator(`#${expand}-section`)).toHaveJSProperty('open', true);
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    // popup.html renders the full UI only in popup surface mode (widget mode
    // shows the signpost stub — covered by surface-stub.spec.js).
    await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Popup — settings accordion', () => {

    test('Queue master toggle: defaults ON, click writes ilap_q_master=false', async ({ page, context }) => {
        await openPopupAndExpandSettings(page, context, 'dq');

        const qMaster = page.locator('#q-master');
        await expect(qMaster).toBeChecked();

        // The checkbox is visually collapsed; click the visible .slider surface.
        await page.locator('#q-master + .slider').click();
        await page.waitForTimeout(300);

        const stored = await getExtensionStorage(context, 'ilap_q_master');
        expect(stored.ilap_q_master).toBe(false);
        await expect(page.locator('#q-sub-settings')).toHaveClass(/dimmed/);
    });

    test('Click-Next-after-ignore toggle persists ilap_q_next', async ({ page, context }) => {
        await openPopupAndExpandSettings(page, context, 'dq');

        const qNext = page.locator('#q-next');
        await expect(qNext).not.toBeChecked();

        await page.locator('#q-next + .slider').click();
        await page.waitForTimeout(300);

        const stored = await getExtensionStorage(context, 'ilap_q_next');
        expect(stored.ilap_q_next).toBe(true);
    });

    test('Ignore mode toggle bad ↔ all persists ilap_q_mode', async ({ page, context }) => {
        await openPopupAndExpandSettings(page, context, 'dq');

        const qMode = page.locator('#q-mode-toggle');
        await expect(qMode).not.toBeChecked(); // default: bad

        // The checkbox is collapsed; the visible toggle is the .wide-track.
        const modeTrack = page.locator('#q-mode-toggle ~ .wide-track');
        await modeTrack.click();
        await page.waitForTimeout(300);
        let stored = await getExtensionStorage(context, 'ilap_q_mode');
        expect(stored.ilap_q_mode).toBe('all');

        await modeTrack.click();
        await page.waitForTimeout(300);
        stored = await getExtensionStorage(context, 'ilap_q_mode');
        expect(stored.ilap_q_mode).toBe('bad');
    });

    test('Default shortcut select: changing value writes ilap_shortcut_key and updates the dynamic hint', async ({ page, context }) => {
        await openPopupAndExpandSettings(page, context);

        const select = page.locator('#default-key');
        await expect(select).toHaveValue('swipeRight');

        await select.selectOption('ctrlKey');
        await page.waitForTimeout(400);

        const stored = await getExtensionStorage(context, 'ilap_shortcut_key');
        expect(stored.ilap_shortcut_key).toBe('ctrlKey');
        await expect(page.locator('#dynamic-hint')).toContainText(/ctrl/i);
    });

    test('Already-Played shortcut: setting to "off" hides the second hint line', async ({ page, context }) => {
        // Start with a non-off value so the second hint line is present.
        await setExtensionStorage(context, { ilap_platform_key: 'shiftKey' });
        await openPopupAndExpandSettings(page, context);

        await expect(page.locator('#dynamic-hint')).toContainText(/already played/i);

        await page.locator('#platform-key').selectOption('off');
        await page.waitForTimeout(400);

        const stored = await getExtensionStorage(context, 'ilap_platform_key');
        expect(stored.ilap_platform_key).toBe('off');
        await expect(page.locator('#dynamic-hint')).not.toContainText(/already played/i);
    });

    test('External ilap_q_master=false reflects live on the open settings panel (EQ "Disable" sync)', async ({ page, context }) => {
        await openPopupAndExpandSettings(page, context, 'dq');

        const qMaster = page.locator('#q-master');
        await expect(qMaster).toBeChecked();
        await expect(page.locator('#q-sub-settings')).not.toHaveClass(/dimmed/);

        // The Explore-Queue "Disable" button writes this flag from the content-script
        // context; the open panel must reflect it without a reopen.
        await setExtensionStorage(context, { ilap_q_master: false });

        await expect(qMaster).not.toBeChecked();
        await expect(page.locator('#q-sub-settings')).toHaveClass(/dimmed/);
    });

    test('External ilap_q_mode change reflects live on the segmented mode toggle', async ({ page, context }) => {
        await openPopupAndExpandSettings(page, context, 'dq');

        const qMode = page.locator('#q-mode-toggle');
        await expect(qMode).not.toBeChecked(); // default: bad

        await setExtensionStorage(context, { ilap_q_mode: 'all' });

        await expect(qMode).toBeChecked();
    });

    test('Surface toggle reflects popup mode and switches back to the widget (stub reloads in)', async ({ page, context }) => {
        await openPopupAndExpandSettings(page, context);

        const surface = page.locator('#surface-toggle');
        await expect(surface).toBeChecked(); // beforeEach seeds popup mode

        // Segmented control: the visible click surface is the .wide-track.
        await page.locator('#surface-toggle ~ .wide-track').click();

        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_surface_mode')).ilap_surface_mode
        ).toBe('widget');
        // The popup window reloads itself into the widget-mode signpost stub.
        await page.locator('#ilap-popup-stub').waitFor({ timeout: 5000 });
    });

    test('Default and Already-Played selectors mutually exclude their chosen values', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'ctrlKey',
            ilap_platform_key: 'shiftKey',
        });
        await openPopupAndExpandSettings(page, context);

        // The custom dropdown keeps the native <select> as the value store and
        // mirrors mutual exclusion onto its <option> disabled state.
        const ctrlOpt = page.locator('#platform-key option[value="ctrlKey"]');
        await expect(ctrlOpt).toBeDisabled();

        const shiftOpt = page.locator('#default-key option[value="shiftKey"]');
        await expect(shiftOpt).toBeDisabled();
    });
});

test.describe('Popup — settings open-state persistence', () => {

    test('Accordion starts closed when no state is stored', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#settings-accordion')).toHaveJSProperty('open', false);
    });

    test('Opening the accordion persists ilap_settings_open=true', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await page.locator('#settings-accordion > summary').click();
        await page.locator('#dq-section summary').waitFor({ timeout: 5000 });

        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_settings_open')).ilap_settings_open
        ).toBe(true);
    });

    test('Closing the accordion persists ilap_settings_open=false', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_settings_open: true });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        // Restored open from storage.
        await expect(page.locator('#settings-accordion')).toHaveJSProperty('open', true);

        await page.locator('#settings-accordion > summary').click();

        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_settings_open')).ilap_settings_open
        ).toBe(false);
    });

    test('Stored open state reopens the accordion (and renders settings) on next open', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_settings_open: true });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#settings-accordion')).toHaveJSProperty('open', true);
        // Settings panel was initialised eagerly (not only on a toggle click):
        // the subcategory summaries are present even while collapsed.
        await expect(page.locator('#dq-section summary')).toBeVisible();
    });
});

test.describe('Popup — settings subcategory persistence', () => {

    async function openSettings(page, context) {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));
        await page.locator('#settings-accordion > summary').click();
        await page.locator('#dq-section summary').waitFor({ timeout: 5000 });
    }

    test('Both subcategories start collapsed when no state is stored', async ({ page, context }) => {
        await openSettings(page, context);

        await expect(page.locator('#dq-section')).toHaveJSProperty('open', false);
        await expect(page.locator('#mi-section')).toHaveJSProperty('open', false);
    });

    test('Expanding Manual Ignore persists ilap_mi_open=true and leaves Discovery Queue collapsed', async ({ page, context }) => {
        await openSettings(page, context);

        await page.locator('#mi-section summary .section-title').click();

        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_mi_open')).ilap_mi_open
        ).toBe(true);
        const dq = await getExtensionStorage(context, 'ilap_dq_open');
        expect(dq.ilap_dq_open).toBeFalsy();
    });

    test('Stored subcategory state restores each area independently (MI open, DQ closed)', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_settings_open: true,
            ilap_mi_open: true,
            ilap_dq_open: false,
        });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#settings-accordion')).toHaveJSProperty('open', true);
        await expect(page.locator('#mi-section')).toHaveJSProperty('open', true);
        await expect(page.locator('#dq-section')).toHaveJSProperty('open', false);
        await expect(page.locator('#default-key')).toBeVisible();
    });

    test('Subcategories are mutually exclusive: opening one collapses the other', async ({ page, context }) => {
        // Start with Manual Ignore expanded.
        await setExtensionStorage(context, { ilap_settings_open: true, ilap_mi_open: true });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));
        await expect(page.locator('#mi-section')).toHaveJSProperty('open', true);

        // Opening Discovery Queue collapses Manual Ignore (and both states persist).
        await page.locator('#dq-section summary .section-title').click();
        await expect(page.locator('#dq-section')).toHaveJSProperty('open', true);
        await expect(page.locator('#mi-section')).toHaveJSProperty('open', false);
        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_dq_open')).ilap_dq_open
        ).toBe(true);
        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_mi_open')).ilap_mi_open
        ).toBe(false);
    });
});
