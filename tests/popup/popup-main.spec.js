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

    test("Total Ignored headlines the extension's counter; Steam's list size rides our own tip, in bold", async ({ page, context }) => {
        // Read when the counter stood at 40; two ignores have landed since, so
        // the tip's Steam total runs two ahead of the last read.
        await setExtensionStorage(context, {
            ilap_ignored_count: 42,
            ilap_ignored_total: { total: 1000, tallyAt: 40, ts: Date.now() },
            ilap_last_ignored_name: 'Some Game',
        });

        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        const total = page.locator('#count-link');
        await expect(total).toHaveText('42');
        expect(await total.getAttribute('title')).toBeNull(); // ours, not the browser's
        const tip = page.locator('#count-tip');
        await expect(tip).toHaveText(/^On your Steam ignore list: 1002Last read: .+$/);
        await expect(tip.locator('b')).toHaveText('1002');
        await expect(page.locator('#last-game')).toHaveText('Some Game');
    });

    test("before Steam's list is read, the headline is still the counter and the tip says so in words", async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ignored_count: 42 });

        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#count-link')).toHaveText('42');
        await expect(page.locator('#count-tip')).toHaveText("Your Steam ignore list hasn't been read yet — open any Steam Store page.");
        await expect(page.locator('#count-tip b')).toHaveCount(0);
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

    test('The list goes on from the game in the Recent box: four different games, bullet left, source right', async ({ page, context }) => {
        const history = ['Game1', 'Game2', 'Game3', 'Game4', 'Game5'].map(name => ({ name, source: 'Default Ignore' }));
        await setExtensionStorage(context, { ilap_ignored_history: history, ilap_last_ignored_name: 'Game1' });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#last-game')).toHaveText('Game1');
        await expect(page.locator('#history-list .hist-name')).toHaveText(['Game2', 'Game3', 'Game4']);
        const entry = page.locator('#history-list .history-entry').first();
        await expect(entry.locator(':scope > *')).toHaveClass([/hist-bullet/, /hist-name/, /hist-src/]);

        // Only the box's game: no list to drop down.
        await setExtensionStorage(context, { ilap_ignored_history: history.slice(0, 1) });
        await expect(page.locator('.history-trigger')).toHaveClass(/no-more/);
        await expect(page.locator('#history-list')).toBeHidden();
        await expect(page.locator('.last-chevron')).toBeHidden();
    });

    test('Finished jobs show in the history with their kind in front and their own glyph', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_ignored_history: [
                { name: 'vr', source: 'Built-in List', presetKey: 'vr' },
                { name: 'No AI Games', source: 'Curator', filter: 'not_recommended', curatorId: '101' },
                { name: 'undo', source: 'Undo', scope: { n: 40 } },
                { name: 'Portal 2', source: 'Played Elsewhere', appid: '620' },
            ],
            ilap_last_ignored_name: 'vr',
        });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#last-game')).toHaveText(/^Ignore: /);
        await expect(page.locator('#last-src .hist-glyph svg')).toHaveCount(1);
        await expect(page.locator('#history-list .hist-name')).toHaveText(['Curator: No AI Games', 'Un-ignore: last 40', 'Portal 2']);
        const entries = page.locator('#history-list .history-entry');
        await expect(entries.nth(0)).toHaveAttribute('data-curator-id', '101');
        await expect(entries.nth(0).locator('.hist-square')).toHaveCount(1);
        await expect(entries.nth(1)).not.toHaveAttribute('data-curator-id', /.*/);

        await page.locator('.history-trigger').hover();
        const opened = context.waitForEvent('page');
        await entries.nth(0).click();
        const tab = await opened;
        expect(tab.url()).toMatch(/^https:\/\/store\.steampowered\.com\/curator\/101\/?/);
        await tab.close();
    });

    test('One curator run with two filters shows twice, told apart by the filter square, the box opening it too', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_ignored_history: [
                { name: 'No AI Games', source: 'Curator', filter: 'not_recommended', curatorId: '101' },
                { name: 'No AI Games', source: 'Curator', filter: 'informational', curatorId: '101' },
                { name: 'vr', source: 'Built-in List', presetKey: 'vr' },
            ],
            ilap_last_ignored_name: 'No AI Games',
        });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));

        await expect(page.locator('#last-game')).toHaveText('Curator: No AI Games');
        await expect(page.locator('#history-list .hist-name')).toHaveText(['Curator: No AI Games', 'Ignore: Every VR game']);
        // The kind is grey in both. The square beside each has its filter's colour.
        const colour = (loc, prop) => loc.evaluate((el, p) => getComputedStyle(el)[p], prop);
        expect(await colour(page.locator('#last-game .hist-kind'), 'color')).toBe('rgb(143, 152, 160)');
        expect(await colour(page.locator('#history-list .hist-kind').first(), 'color')).toBe('rgb(143, 152, 160)');
        expect(await colour(page.locator('#last-src .hist-square'), 'backgroundColor')).toBe('rgb(236, 151, 108)');
        expect(await colour(page.locator('#history-list .hist-square').first(), 'backgroundColor')).toBe('rgb(241, 222, 116)');

        const opened = context.waitForEvent('page');
        await page.locator('#last-ignored-row').click();
        const tab = await opened;
        expect(tab.url()).toMatch(/^https:\/\/store\.steampowered\.com\/curator\/101\/?/);
        await tab.close();
    });

    test('A history entry with an appid opens its store page; one without does nothing', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_ignored_history: [
                { name: 'Portal 2', source: 'Queue', appid: '620' },
                { name: 'Old entry', source: 'Queue' },
            ],
        });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));
        await page.locator('.history-trigger').hover();

        const entries = page.locator('#history-list .history-entry');
        await expect(entries.nth(0)).toHaveAttribute('data-appid', '620');
        await expect(entries.nth(1)).not.toHaveAttribute('data-appid', /.*/);

        const opened = context.waitForEvent('page');
        await entries.nth(0).click();
        const tab = await opened;
        expect(tab.url()).toMatch(/^https:\/\/store\.steampowered\.com\/app\/620\/?/);
        await tab.close();

        // The new tab took the pointer off the list: back to the popup, hover again.
        await page.bringToFront();
        await page.mouse.move(0, 0);
        await page.locator('.history-trigger').hover();
        const before = context.pages().length;
        await entries.nth(1).click();
        await page.waitForTimeout(300);
        expect(context.pages().length).toBe(before);
    });

    test('A finished job\'s kind reads in grey and the whole entry fits two lines', async ({ page, context }) => {
        const long = 'Games that use generative AI for art, voice acting, writing or code, and the studios behind them';
        await setExtensionStorage(context, {
            ilap_lang: 'fr',
            ilap_ignored_history: [
                { name: 'Portal 2', source: 'Queue', appid: '620' },
                { name: long, source: 'Curator', filter: 'all_but_recommended', curatorId: '102' },
                { name: 'vr', source: 'Built-in List', presetKey: 'vr' },
            ],
            ilap_last_ignored_name: 'Portal 2',
        });
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));
        const names = page.locator('#history-list .hist-name');
        await expect(names.first().locator('.hist-kind')).toHaveText('Groupe de curation :');
        await expect(names.nth(1).locator('.hist-kind')).toHaveText('Ignorer :');
        for (const kind of await page.locator('#history-list .hist-kind').all()) {
            expect(await kind.evaluate(el => getComputedStyle(el).color)).toBe('rgb(143, 152, 160)');
        }
        await page.locator('.history-trigger').hover();
        const lines = await names.first().evaluate(el => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
        expect(lines).toBe(2);
    });

    test('The bars\' titles light up on hover, the gear turns and grows, the stack\'s bars drop in', async ({ page, context }) => {
        const extId = await getExtensionId(context);
        await page.goto(popupUrl(extId));
        const title = page.locator('#settings-accordion > summary .summary-title > span');
        const colour = () => title.evaluate(el => getComputedStyle(el).color);
        expect(await colour()).toBe('rgb(221, 226, 231)');
        await page.locator('#settings-accordion > summary').hover();
        await expect.poll(colour).toBe('rgb(255, 255, 255)');
        await expect.poll(() => page.locator('.gear-ico').evaluate(el => getComputedStyle(el).transform))
            .toMatch(/^matrix\((0\.88|0\.884)/);

        await page.locator('#queue-accordion > summary .summary-title').hover();
        const dropping = await page.locator('.queue-ico rect').evaluateAll(els => els.map(el => el.getAnimations().length));
        expect(dropping).toEqual([1, 1, 1]);
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
        await setExtensionStorage(context, {
            ilap_ignored_count: 7,
            ilap_ignored_total: { total: 300, tallyAt: 7, ts: Date.now() },
            ilap_last_ignored_name: 'Live Game',
        });
        await page.waitForTimeout(400);

        await expect(page.locator('#count-link')).toHaveText('7');
        await expect(page.locator('#count-tip b')).toHaveText('300');
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
        // with a literal dash in the markup, so asserting on it proves nothing here,
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
        // burned, the job cursor it advanced, the bumped count, and Steam's list
        // size from the pass's userdata read.
        await setExtensionStorage(context, {
            ilap_ignore_gate: Date.now(),
            ilap_curator_cursor_j1: 3,
            ilap_ignored_count: 5,
            ilap_ignored_total: { total: 50, tallyAt: 4, ts: Date.now() },
        });
        await page.waitForTimeout(400);

        await expect(page.locator('#count-link')).toHaveText('5');
        await expect(page.locator('#count-tip b')).toHaveText('51');
        await expect(page.locator('#heavy-sentinel')).toHaveCount(1);
    });
});
