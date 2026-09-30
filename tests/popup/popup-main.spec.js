const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    // popup.html renders the full UI only in popup surface mode (widget mode
    // shows the signpost stub — covered by surface-stub.spec.js).
    await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Popup — main view', () => {

    test('Master toggle: defaults ON, click writes ilap_master_enabled=false and dims UI wrapper', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        const toggle = page.locator('#master-toggle');
        await expect(toggle).toBeChecked();
        await expect(page.locator('#ui-wrapper')).not.toHaveClass(/disabled/);

        // The <input> is visually collapsed (opacity:0; width:0; height:0); the
        // visible, clickable surface is the sibling .slider inside the label.
        await page.locator('#master-toggle + .slider').click();
        await page.waitForTimeout(300);

        const stored = await getExtensionStorage(context, 'ilap_master_enabled');
        expect(stored.ilap_master_enabled).toBe(false);
        await expect(page.locator('#ui-wrapper')).toHaveClass(/disabled/);
    });

    test('Master toggle off: the header icon greys out, the language picker does not', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));
        await page.locator('#master-toggle + .slider').click();
        await expect(page.locator('#ui-wrapper')).toHaveClass(/disabled/);

        const styles = await page.evaluate(() => {
            const of = (sel) => {
                const cs = getComputedStyle(document.querySelector(sel));
                return { filter: cs.filter, opacity: cs.opacity };
            };
            return {
                icon: of('#ilap-header-icon'),
                settingsLabel: of('#settings-accordion > summary > span'),
                chip: of('.lang-chip'),
            };
        });
        // The icon shares the header with the master switch, which must stay lit.
        expect(styles.icon.filter).toContain('grayscale');
        expect(styles.settingsLabel.filter).toContain('grayscale');
        // The language picker is the one thing in that bar left untouched, so its
        // droplist opens opaque instead of showing the page through itself.
        expect(styles.chip.filter).toBe('none');
        expect(styles.chip.opacity).toBe('1');

        await page.locator('.lang-chip').click();
        const menu = page.locator('.lang-chip .select-menu');
        await expect(menu).toHaveClass(/open/);
        expect(await menu.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    });

    test('the boot guard freezes the PSEUDO-elements too, not just their hosts', async ({ page, context }) => {
        // The panel is built unchecked and collapsed, then handed the stored
        // state — so .no-transition has to cover everything that moves. `*`
        // matches elements only: the switch knob (.slider:before) and the
        // accordion chevron (summary::after) are pseudo-elements, and without
        // their own selector they slid/rotated into place on every open.
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));
        await expect(page.locator('#popup-root')).not.toHaveClass(/no-transition/);

        const frozen = await page.evaluate(() => {
            document.getElementById('popup-root').classList.add('no-transition');
            const dur = (sel, pseudo) =>
                getComputedStyle(document.querySelector(sel), pseudo).transitionDuration;
            return {
                knob: dur('#master-toggle + .slider', '::before'),
                chevron: dur('#settings-accordion > summary', '::after'),
            };
        });
        expect(frozen.knob).toBe('0s');
        expect(frozen.chevron).toBe('0s');
    });

    test('Total Ignored counter and Last Ignored name reflect storage', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_ignored_count: 42,
            ilap_last_ignored_name: 'Some Game',
        });

        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#count-link')).toHaveText('42');
        await expect(page.locator('#last-game')).toHaveText('Some Game');
    });

    test('Defaults render correctly when storage is empty', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#count-link')).toHaveText('0');
        await expect(page.locator('#last-game')).toHaveText('None');
        await expect(page.locator('#history-list')).toContainText(/no recent history/i);
    });

    test('History tooltip shows latest 3 entries from ilap_ignored_history', async ({ page, context }) => {
        const history = [
            { name: 'Game1', source: 'Manual' },
            { name: 'Game2', source: 'Manual' },
            { name: 'Game3', source: 'Manual' },
            { name: 'Game4', source: 'Manual' },
            { name: 'Game5', source: 'Manual' },
        ];
        await setExtensionStorage(context, { ilap_ignored_history: history });

        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        const entries = page.locator('#history-list .history-entry');
        await expect(entries).toHaveCount(3);
        await expect(page.locator('#history-list')).toContainText('Game1');
        await expect(page.locator('#history-list')).toContainText('Game2');
        await expect(page.locator('#history-list')).toContainText('Game3');
        await expect(page.locator('#history-list')).not.toContainText('Game4');
    });

    test('History entry escapes HTML in game names (XSS safety)', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_ignored_history: [{ name: '<img src=x onerror=alert(1)>', source: 'Manual' }],
        });

        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        const entry = page.locator('#history-list .history-entry').first();
        await expect(entry).toContainText('<img');
        // The string is rendered as text, not as a real <img> element.
        expect(await entry.locator('img').count()).toBe(0);
    });

    test('Storage change in another context re-renders the popup live', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#count-link')).toHaveText('0');

        // Mutate storage from outside the popup; popup_main.js subscribes to onChanged.
        await setExtensionStorage(context, { ilap_ignored_count: 7, ilap_last_ignored_name: 'Live Game' });
        await page.waitForTimeout(400);

        await expect(page.locator('#count-link')).toHaveText('7');
        await expect(page.locator('#last-game')).toHaveText('Live Game');
    });

    test('storage reads follow what a write feeds: nothing for foreign keys, never the whole store', async ({ page, context }) => {
        // The popup once answered every write with get(null): the whole store, the
        // ignore log and the curator cache included, 1-3 times a second during a
        // drain. Each write now reads only the keys its panel renders.
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));
        await expect(page.locator('#popup-root')).not.toHaveClass(/no-transition/);

        // Record every read from here on, by the keys it asks for.
        await page.evaluate(() => {
            window.__reads = [];
            const local = chrome.storage.local;
            const get = local.get.bind(local);
            local.get = (keys, cb) => {
                window.__reads.push(keys === null ? null : [].concat(keys));
                return get(keys, cb);
            };
        });
        const reads = () => page.evaluate(() => window.__reads.splice(0));

        // Keys no panel renders: the gate's stamps, the widget's own state, MI pulses.
        await setExtensionStorage(context, {
            ilap_ignore_gate: Date.now(),
            ilap_ignore_gate_penalty: { until: 0 },
            ilap_ignore_foreground_at: Date.now(),
            ilap_widget_expanded_ts: Date.now(),
            ilap_unignored: { appids: ['1'], ts: Date.now() },
        });
        await page.waitForTimeout(500);
        expect(await reads()).toEqual([]);

        // A drain's progress: the queue snapshot, not the settings or the log.
        await setExtensionStorage(context, { ilap_curator_cursor_j1: 3 });
        await expect.poll(async () => (await page.evaluate(() => window.__reads.length))).toBeGreaterThan(0);
        await page.waitForTimeout(300);
        const drainReads = (await reads()).flat();
        expect(drainReads).toContain('ilap_curator_queue');
        expect(drainReads).not.toContain('ilap_shortcut_key');

        // A setting: the full render, by name.
        await setExtensionStorage(context, { ilap_mask_enabled: false });
        await expect.poll(async () => (await page.evaluate(() => window.__reads.length))).toBeGreaterThan(0);
        await page.waitForTimeout(300);
        const fullReads = await reads();
        expect(fullReads).not.toContain(null);
        expect(fullReads.flat()).toContain('ilap_mask_enabled');
        // The curator cache is never part of it. (The log is: a full render
        // redraws the undo applet, which reads the log by its own keys.)
        expect(fullReads.flat().filter(k => /^ilap_curator_cache/.test(k))).toEqual([]);
    });

    test('a drain-only write repaints the total without rebuilding the popup', async ({ page, context }) => {
        // A bulk drain writes its progress keys 1–3×/s. The total is now one of
        // them (a drained curator ignore bumps the count and nothing else), so it
        // has to move WITHOUT dragging in the full innerHTML rebuild the heavy
        // path does — that is the whole point of the drain-key filter.
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        // Wait out the BOOT render before planting anything: #count-link ships
        // with a literal 0 in the markup, so asserting on it proves nothing here,
        // and initPopup's storage callback (which drops .no-transition 100 ms
        // after it paints) would otherwise wipe the sentinel below itself.
        await expect(page.locator('#popup-root')).not.toHaveClass(/no-transition/);

        // A sentinel only the heavy path destroys: updateBasicUI rewrites the
        // whole of #dynamic-hint.
        await page.evaluate(() => {
            const mark = document.createElement('span');
            mark.id = 'heavy-sentinel';
            document.getElementById('dynamic-hint').appendChild(mark);
        });

        // Exactly what one drained curator ignore leaves behind: the gate slot it
        // burned, the job cursor it advanced, and the bumped total.
        await setExtensionStorage(context, {
            ilap_ignore_gate: Date.now(),
            ilap_curator_cursor_j1: 3,
            ilap_ignored_count: 5,
        });
        await page.waitForTimeout(400);

        await expect(page.locator('#count-link')).toHaveText('5');
        await expect(page.locator('#heavy-sentinel')).toHaveCount(1);
    });
});
