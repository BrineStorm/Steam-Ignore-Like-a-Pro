// Widget collapsed-launcher behaviour. Default state is collapsed: only the
// chevron tab shows; clicking it slides the launcher out. After a minute with
// the panel closed and no widget interaction the launcher stashes itself again.
// State lives in ilap_widget_expanded_ts (chrome.storage.local): 0/absent =
// collapsed, >0 = expanded with the value being the last-activity timestamp —
// so new tabs mount in the same state and open tabs follow via onChanged.
//
// Login-agnostic: nothing here opens the panel except the blocks-collapse test
// (the launcher is login-locked), and no ignore API is reachable.

const { test, expect, AUTH_FILE } = require('../_fixtures.js');
const { setExtensionStorage, getExtensionStorage } = require('../_extension.js');
const fs = require('fs');

const { searchUrl } = require('../_search.js'); // random search term per navigation
const KEY = 'ilap_widget_expanded_ts';
const INTRO_KEY = 'ilap_intro_glow';
const IDLE_MS = 60000;

test.describe('on-page widget — collapse to chevron', () => {

    test('fresh storage: mounts collapsed — chevron shown, launcher stashed', async ({ page }) => {
        await page.goto(searchUrl());

        await expect(page.locator('.ilap-chevron')).toHaveClass(/shown/);
        await expect(page.locator('.ilap-launcher')).toHaveClass(/stashed/);
        // The "expand" hint is our own tooltip box (not a native browser title),
        // revealed ~1 s after hovering the chevron. Text goes through t() —
        // English on the default locale.
        const tip = page.locator('.ilap-chevron-tip');
        await expect(tip).toContainText('Expand the icon');
        await page.locator('.ilap-chevron').hover();
        await expect(tip).toHaveClass(/shown/, { timeout: 3000 });
    });

    test('new-install glow: gold bursts on the chevron until the first click retires it for good', async ({ context, page }) => {
        test.setTimeout(150000); // rides out a full burst→rest→next-burst cycle (~80 s)

        // migrate.js arms INTRO_KEY on a fresh install (the --test build swaps the
        // migration out, so seed the key the way the real install path writes it).
        await setExtensionStorage(context, { [INTRO_KEY]: true });
        await page.goto(searchUrl());

        // The gold burst runs 10 s (well past the welcome-back highlight's 3 s
        // gold phase), then rests on the steady blue rim until the next cycle.
        const chevron = page.locator('.ilap-chevron');
        await expect(chevron).toHaveClass(/restored/);
        await expect(chevron).toHaveClass(/gold/);
        await page.waitForTimeout(3500);
        await expect(chevron).toHaveClass(/gold/);
        await expect(chevron).not.toHaveClass(/gold/, { timeout: 12000 });
        await expect(chevron).toHaveClass(/restored/); // the rim stays between bursts

        // …and the cycle repeats: the next burst arrives on the minute mark and
        // ends on its own too (the interval + nested burst timer both work).
        await expect(chevron).toHaveClass(/gold/, { timeout: 65000 });
        await expect(chevron).not.toHaveClass(/gold/, { timeout: 12000 });
        await expect(chevron).toHaveClass(/restored/);

        // First click: launcher slides out, glow retired and persisted off.
        await chevron.click();
        await expect(page.locator('.ilap-launcher')).not.toHaveClass(/stashed/);
        await expect(chevron).not.toHaveClass(/restored|gold/);
        const data = await getExtensionStorage(context, [INTRO_KEY]);
        expect(data[INTRO_KEY]).toBe(false);

        // Retired for good: a later collapsed mount shows a plain chevron.
        await setExtensionStorage(context, { [KEY]: 0 }); // stash again (as idle would)
        await page.goto(searchUrl());
        await expect(page.locator('.ilap-chevron')).toHaveClass(/shown/);
        await expect(page.locator('.ilap-chevron')).not.toHaveClass(/restored|gold/);
    });

    test('chevron click slides the launcher out and persists the state', async ({ context, page }) => {
        await page.goto(searchUrl());

        await page.locator('.ilap-chevron').click();
        await expect(page.locator('.ilap-launcher')).not.toHaveClass(/stashed/);
        await expect(page.locator('.ilap-chevron')).not.toHaveClass(/shown/);

        const data = await getExtensionStorage(context, [KEY]);
        expect(data[KEY]).toBeGreaterThan(0);
    });

    test('state is shared: a second tab mounts expanded, and both collapse together', async ({ context, page }) => {
        await page.goto(searchUrl());
        await page.locator('.ilap-chevron').click();
        await expect(page.locator('.ilap-launcher')).not.toHaveClass(/stashed/);

        // New tab inherits the expanded state at mount.
        const page2 = await context.newPage();
        await page2.goto(searchUrl());
        await expect(page2.locator('.ilap-launcher')).not.toHaveClass(/stashed/);
        await expect(page2.locator('.ilap-chevron')).not.toHaveClass(/shown/);

        // A collapse written to storage (as an idle tab would) reaches both live.
        await setExtensionStorage(context, { [KEY]: 0 });
        await expect(page.locator('.ilap-launcher')).toHaveClass(/stashed/);
        await expect(page2.locator('.ilap-launcher')).toHaveClass(/stashed/);
        await expect(page2.locator('.ilap-chevron')).toHaveClass(/shown/);

        await page2.close();
    });

    test('idle timeout stashes the launcher and writes 0', async ({ context, page }) => {
        // Seed an almost-expired activity timestamp so the minute elapses ~8 s
        // after seeding (page load eats a few seconds before the widget mounts).
        await setExtensionStorage(context, { [KEY]: Date.now() - (IDLE_MS - 8000) });
        await page.goto(searchUrl());

        await expect(page.locator('.ilap-launcher')).not.toHaveClass(/stashed/);
        await expect(page.locator('.ilap-launcher')).toHaveClass(/stashed/, { timeout: 15000 });
        await expect(page.locator('.ilap-chevron')).toHaveClass(/shown/);

        const data = await getExtensionStorage(context, [KEY]);
        expect(data[KEY]).toBe(0);
    });

    test('on a short screen the open panel caps to the viewport and scrolls', async ({ page }) => {
        test.skip(!fs.existsSync(AUTH_FILE), 'no saved Steam session'); // panel is login-gated

        // The toolbar popup scrolls via the browser; the shadow panel must cap
        // itself (max-height + overflow-y) or its lower part is unreachable on
        // short screens.
        await page.setViewportSize({ width: 1024, height: 500 });
        await page.goto(searchUrl());
        await page.locator('.ilap-chevron').click();
        await page.locator('.ilap-launcher').click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);

        // Grow the content: open the SETTINGS accordion inside the panel.
        await page.locator('.ilap-panel #settings-accordion summary').first().click();

        const root = page.locator('.ilap-panel #popup-root');
        const box = await root.boundingBox();
        expect(box.y + box.height).toBeLessThanOrEqual(500); // fits the viewport
        // …and the overflowing content is reachable by scrolling inside the panel.
        const scrollable = await root.evaluate((el) => el.scrollHeight > el.clientHeight);
        expect(scrollable).toBe(true);
    });

    test('an open panel counts as activity — idle timer bumps instead of collapsing', async ({ context, page }) => {
        test.skip(!fs.existsSync(AUTH_FILE), 'no saved Steam session'); // panel is login-gated

        await page.goto(searchUrl());
        await page.locator('.ilap-chevron').click();
        await page.locator('.ilap-launcher').click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);

        // Age the shared timestamp to the brink; the tab's timer must find the
        // open panel and re-bump rather than stash the widget mid-use.
        const seeded = Date.now() - (IDLE_MS - 1000);
        await setExtensionStorage(context, { [KEY]: seeded });
        await page.waitForTimeout(3000);

        await expect(page.locator('.ilap-launcher')).not.toHaveClass(/stashed/);
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);
        const data = await getExtensionStorage(context, [KEY]);
        expect(data[KEY]).toBeGreaterThan(seeded);
    });
});
