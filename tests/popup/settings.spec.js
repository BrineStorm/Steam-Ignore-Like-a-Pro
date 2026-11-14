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
    await page.locator('#tab-settings').click();
    // Settings render lazily as the tab opens; give it a tick.
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

test.describe('Popup — settings tab', () => {

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

    test('Blur ignored covers: ON with nothing stored, and OFF is what gets written', async ({ page, context }) => {
        // The default flipped with the feature: an absent key now means ON, in the
        // panel and in the content script alike. Only an explicit false turns it
        // off, so the value written by the first click is the one that matters.
        await openPopupAndExpandSettings(page, context, 'mi');

        const mask = page.locator('#mask-toggle');
        await expect(mask).toBeChecked();

        await page.locator('#mask-toggle + .slider').click();
        await page.waitForTimeout(300);

        const stored = await getExtensionStorage(context, 'ilap_mask_enabled');
        expect(stored.ilap_mask_enabled).toBe(false);
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

    test('Master OFF: the surface picker stays reachable and switches back to the widget', async ({ page, context }) => {
        // The one settings row that survives a disabled extension. Everything else
        // in the panel is inert, but the surface must always be switchable — a
        // user who turned the extension off in toolbar mode still has to be able
        // to move the UI back onto the page (and vice versa).
        await setExtensionStorage(context, { ilap_master_enabled: false });
        // Not openPopupAndExpandSettings: every feature subcategory IS inert while
        // the extension is off, so the helper's expand step cannot run. Only the
        // tab line stays live — that is what makes the picker reachable at all.
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));
        await page.locator('#tab-settings').click();
        // The real input is visually hidden — the .wide-track is the control.
        await page.locator('#surface-toggle ~ .wide-track').waitFor({ timeout: 5000 });

        await expect(page.locator('#ui-wrapper')).toHaveClass(/disabled/);
        await page.locator('#surface-toggle ~ .wide-track').click();

        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_surface_mode')).ilap_surface_mode
        ).toBe('widget');
    });

    test('Master OFF: greyed controls are inert, keyboard included, and come back live', async ({ page, context }) => {
        // The greying is CSS; pointer-events alone left every control reachable by
        // Tab + Space. `inert` is what actually takes them away.
        await setExtensionStorage(context, { ilap_master_enabled: false });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));
        await page.locator('#tab-settings').click();
        await page.locator('#dq-section').waitFor({ timeout: 5000 });

        await expect(page.locator('#total-row')).toHaveJSProperty('inert', true);
        await expect(page.locator('#dq-section')).toHaveJSProperty('inert', true);
        await expect(page.locator('#mi-section')).toHaveJSProperty('inert', true);
        // The survivors: the surface row, the tab line and its panel.
        await expect(page.locator('#surface-row')).toHaveJSProperty('inert', false);
        await expect(page.locator('#tabline')).toHaveJSProperty('inert', false);
        await expect(page.locator('#tab-panel')).toHaveJSProperty('inert', false);

        // An inert control cannot take focus, so the keyboard cannot flip it.
        await page.locator('#q-master').evaluate(el => el.focus());
        await expect(page.locator('#q-master')).not.toBeFocused();

        // Re-enabled live: everything is reachable again without a reload.
        await setExtensionStorage(context, { ilap_master_enabled: true });
        await expect(page.locator('#dq-section')).toHaveJSProperty('inert', false);
        await expect(page.locator('#total-row')).toHaveJSProperty('inert', false);
        await page.locator('#q-master').evaluate(el => el.focus());
        await expect(page.locator('#q-master')).toBeFocused();
    });

    test('Master OFF: the language tab still switches the language', async ({ page, context }) => {
        // The panel has to stay readable in the user's own language whatever the
        // toggle says, so the language tab outlives a disabled extension.
        await setExtensionStorage(context, { ilap_master_enabled: false });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#ui-wrapper')).toHaveClass(/disabled/);
        await expect(page.locator('#lang-code')).toHaveText('EN');
        await page.locator('#tab-lang').click();
        await expect(page.locator('#lang-pane')).toHaveJSProperty('inert', false);

        await page.locator('.lang-opt[data-lang="ru"]').click();

        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_lang')).ilap_lang
        ).toBe('ru');
        await expect(page.locator('#lang-code')).toHaveText('RU');
    });

    test('The surface switch opens the settings under its "Interface:" caption', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));
        await page.locator('#tab-settings').click();
        const caption = page.locator('#surface-row .surface-label');
        await expect(caption).toHaveText('Interface:');
        const cap = await caption.boundingBox();
        const sw = await page.locator('#surface-row .wide-switch').boundingBox();
        expect(cap.y + cap.height).toBeLessThanOrEqual(sw.y + 0.5);
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

    test('Un-ignore select: defaults to the gesture and writes ilap_unignore_key', async ({ page, context }) => {
        await openPopupAndExpandSettings(page, context);

        const select = page.locator('#unignore-key');
        await expect(select).toHaveValue('zigzag');

        // A modifier-click is a valid un-ignore binding now, not just a gesture.
        await select.selectOption('ctrlKey');
        await page.waitForTimeout(400);
        expect((await getExtensionStorage(context, 'ilap_unignore_key')).ilap_unignore_key)
            .toBe('ctrlKey');

        await select.selectOption('off');
        await page.waitForTimeout(400);
        expect((await getExtensionStorage(context, 'ilap_unignore_key')).ilap_unignore_key)
            .toBe('off');
    });

    test('The three selects offer the SAME bindings, the circle included', async ({ page, context }) => {
        // Any action can take any binding — ignoring by circle while un-ignoring
        // by swipe is a supported setup, not a special case — so the three option
        // lists must not drift apart. 'off' is the only asymmetry (Default Ignore
        // can't be switched off, and the un-ignore's 'off' means the badge).
        await openPopupAndExpandSettings(page, context);

        // As SETS: each select leads with its own default (the un-ignore opens on
        // the circle, the ignore selects on their swipes), so the order differs
        // on purpose and only the offer has to match.
        const values = async (sel) => (await page.locator(`#${sel} option`).evaluateAll(
            (opts) => opts.map((o) => o.value))).filter((v) => v !== 'off').sort();

        const dflt = await values('default-key');
        expect(dflt).toContain('zigzag');
        expect(await values('platform-key')).toEqual(dflt);
        expect(await values('unignore-key')).toEqual(dflt);
    });

    test('The un-ignore row has no hover hint at all', async ({ page, context }) => {
        // It used to spell out the zigzag the circle label leaves out, as a
        // native title. The row is a label and a select now, with nothing that
        // pops up over them — the zigzag still fires the binding (the detector
        // reads the X axis alone), it is simply not advertised here.
        await openPopupAndExpandSettings(page, context);

        const label = page.locator('[data-i18n="solo_unignore"]');
        await expect(label).not.toHaveAttribute('title', /./);
        await expect(label).not.toHaveAttribute('data-i18n-title', /./);
    });

    test("Un-ignore 'off' says what it leaves behind: off, except the badge click", async ({ page, context }) => {
        // The value stays 'off' (storage compat) but it never switches the
        // un-ignore off — a click on the badge is wired unconditionally — so the
        // option must say both halves, unlike the ignore selects' bare Off.
        await openPopupAndExpandSettings(page, context);

        await expect(page.locator('#unignore-key option[value="off"]')).toHaveText(/off.*badge/i);
        await expect(page.locator('#platform-key option[value="off"]')).toHaveText(/^off$/i);

        await page.locator('#unignore-key').selectOption('off');
        await page.waitForTimeout(400);
        await expect(page.locator('#unignore-key-display')).toHaveText(/off.*badge/i);
    });

    test('A stored value the select has no option for falls back to the default', async ({ page, context }) => {
        // Self-healing, through the same clamp the content script uses
        // (Settings.normalizeUnignore): a blank control is the one outcome worse
        // than a wrong one.
        await setExtensionStorage(context, { ilap_unignore_key: 'nonsense' });
        await openPopupAndExpandSettings(page, context);

        await expect(page.locator('#unignore-key')).toHaveValue('zigzag');
    });

    test('All three selects mutually exclude their chosen values', async ({ page, context }) => {
        // The collision guard is what keeps the three apart now that they share a
        // vocabulary: the resolvers are first-match-wins, so a value bound twice
        // would leave the later binding silently dead.
        await setExtensionStorage(context, {
            ilap_shortcut_key: 'ctrlKey',
            ilap_platform_key: 'shiftKey',
            ilap_unignore_key: 'altKey',
        });
        await openPopupAndExpandSettings(page, context);

        await expect(page.locator('#unignore-key option[value="ctrlKey"]')).toBeDisabled();
        await expect(page.locator('#unignore-key option[value="shiftKey"]')).toBeDisabled();
        await expect(page.locator('#default-key option[value="altKey"]')).toBeDisabled();
        await expect(page.locator('#platform-key option[value="altKey"]')).toBeDisabled();

        // Nothing has taken the circle, so it stays free in all three…
        await expect(page.locator('#unignore-key option[value="zigzag"]')).not.toBeDisabled();
        await expect(page.locator('#default-key option[value="zigzag"]')).not.toBeDisabled();
        // …and 'off' is a sentinel several selects may sit on at once.
        await expect(page.locator('#platform-key option[value="off"]')).not.toBeDisabled();
        await expect(page.locator('#unignore-key option[value="off"]')).not.toBeDisabled();
    });
});

test.describe('Popup — settings tab open-state persistence', () => {

    test('The settings tab starts closed when no state is stored', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#tab-settings')).toHaveAttribute('aria-selected', 'false');
        await expect(page.locator('#settings-placeholder')).toBeHidden();
    });

    test('Opening the settings tab persists ilap_popup_tab=settings, closing it persists none', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await page.locator('#tab-settings').click();
        await page.locator('#dq-section summary').waitFor({ timeout: 5000 });
        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_popup_tab')).ilap_popup_tab
        ).toBe('settings');

        await page.locator('#tab-settings').click();
        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_popup_tab')).ilap_popup_tab
        ).toBe('');
    });

    test('Stored open state reopens the settings tab (and renders settings) on next open', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_popup_tab: 'settings' });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#tab-settings')).toHaveAttribute('aria-selected', 'true');
        // Settings panel was initialised eagerly (not only on a tab click):
        // the subcategory summaries are present even while collapsed.
        await expect(page.locator('#dq-section summary')).toBeVisible();
    });
});

test.describe('Popup — settings subcategory persistence', () => {

    async function openSettings(page, context) {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));
        await page.locator('#tab-settings').click();
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
            ilap_popup_tab: 'settings',
            ilap_mi_open: true,
            ilap_dq_open: false,
        });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#tab-settings')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#mi-section')).toHaveJSProperty('open', true);
        await expect(page.locator('#dq-section')).toHaveJSProperty('open', false);
        await expect(page.locator('#default-key')).toBeVisible();
    });

    test('Subcategories are mutually exclusive: opening one collapses the other', async ({ page, context }) => {
        // Start with Manual Ignore expanded.
        await setExtensionStorage(context, { ilap_popup_tab: 'settings', ilap_mi_open: true });
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

    test('Swapping subcategories moves both at once: the closing one shrinks with its rows shown, the panel never dips', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_popup_tab: 'settings', ilap_dq_open: true });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));
        await expect(page.locator('#dq-section')).toHaveJSProperty('open', true);
        await expect(page.locator('#popup-root')).not.toHaveClass(/no-transition/);
        await page.waitForTimeout(400);
        // Every drawn frame for 0.6 s: the Discovery Queue box, the panel, and
        // whether the closing box still draws its rows.
        await page.evaluate(() => {
            window.__swap = [];
            const t0 = performance.now();
            const f = () => {
                const dq = document.getElementById('dq-section');
                window.__swap.push({
                    dq: dq.getBoundingClientRect().height,
                    panel: document.getElementById('popup-root').getBoundingClientRect().height,
                    rows: getComputedStyle(dq, '::details-content').contentVisibility,
                });
                if (performance.now() - t0 < 600) requestAnimationFrame(f);
            };
            requestAnimationFrame(f);
        });
        await page.locator('#mi-section summary .section-title').click();
        await page.waitForTimeout(700);
        const hs = await page.evaluate(() => window.__swap);
        const start = hs[0], end = hs[hs.length - 1];
        expect(start.dq - end.dq).toBeGreaterThan(20);
        const shrinking = hs.filter(h => h.dq < start.dq - 1 && h.dq > end.dq + 1);
        expect(shrinking.length).toBeGreaterThanOrEqual(4);
        expect(shrinking.every(h => h.rows === 'visible')).toBe(true);
        expect(Math.min(...hs.map(h => h.panel))).toBeGreaterThanOrEqual(Math.min(start.panel, end.panel) - 1);
    });
});
