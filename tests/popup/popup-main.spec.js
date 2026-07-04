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
});
