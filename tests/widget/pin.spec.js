// Pin badge on the launcher's corner. Hidden until the pointer is over the
// launcher zone; pressing it persists ilap_widget_pinned and keeps the launcher
// out — the 60 s idle auto-stash re-bumps instead of collapsing — until the
// user unpresses it. Login-agnostic: the pin is a visibility preference, not a
// Steam action, so it works while the launcher is login-locked.

const { test, expect } = require('../_fixtures.js');
const { setExtensionStorage, getExtensionStorage } = require('../_extension.js');

const PAGE = '/search/?term=portal&ndl=1';
const KEY = 'ilap_widget_expanded_ts';
const PIN_KEY = 'ilap_widget_pinned';
const IDLE_MS = 60000;

test.describe('on-page widget — pin badge', () => {

    test('hidden by default; launcher hold reveals after a delay; pin hover reveals instantly', async ({ page }) => {
        await page.goto(PAGE);
        await page.locator('.ilap-chevron').click();

        const pin = page.locator('.ilap-pin');
        await expect(pin).toHaveCSS('opacity', '0');

        // A casual pass over the launcher must NOT flash the pin — the reveal is
        // gated behind a deliberate ~5 s hover hold.
        await page.locator('.ilap-launcher').hover();
        await page.waitForTimeout(500);
        await expect(pin).toHaveCSS('opacity', '0');
        // Holding the launcher hover eventually reveals it (delayed transition).
        await expect(pin).toHaveCSS('opacity', '1', { timeout: 8000 });

        // A direct hover on the pin reveals it instantly (no hold needed).
        await pin.hover();
        await expect(pin).toHaveCSS('opacity', '1');
        // The pin tooltip goes through t() — English on default locale.
        await expect(pin).toHaveAttribute('title', 'Pin the icon on screen');
    });

    test('pressed pin blocks the idle stash; unpress re-enables it', async ({ context, page }) => {
        await page.goto(PAGE);
        await page.locator('.ilap-chevron').click();

        await page.locator('.ilap-pin').click();
        await expect(page.locator('.ilap-pin')).toHaveClass(/pinned/);
        await expect.poll(async () =>
            (await getExtensionStorage(context, [PIN_KEY]))[PIN_KEY]
        ).toBe(true);

        // Age the shared timestamp well past the idle window — while pinned the
        // idle stash is suppressed (the timer isn't even armed), so the launcher
        // must stay out despite the stale timestamp.
        await setExtensionStorage(context, { [KEY]: Date.now() - IDLE_MS * 2 });
        await page.waitForTimeout(3000);
        await expect(page.locator('.ilap-launcher')).not.toHaveClass(/stashed/);

        // Unpress → the same aged timestamp now stashes the launcher.
        await page.locator('.ilap-pin').click();
        await expect(page.locator('.ilap-pin')).not.toHaveClass(/pinned/);
        await setExtensionStorage(context, { [KEY]: Date.now() - (IDLE_MS - 1000) });
        await expect(page.locator('.ilap-launcher')).toHaveClass(/stashed/, { timeout: 8000 });
        expect((await getExtensionStorage(context, [PIN_KEY]))[PIN_KEY]).toBe(false);
    });

    test('pinned launcher resists a cross-tab collapse (re-asserts expanded)', async ({ context, page }) => {
        // An idle sibling tab writing 0 must NOT stash a pinned launcher: the
        // onChanged handler re-asserts expanded (a different branch from the
        // same-tab idle re-bump covered above).
        await page.goto(PAGE);
        await page.locator('.ilap-chevron').click();
        await page.locator('.ilap-pin').click();
        await expect(page.locator('.ilap-pin')).toHaveClass(/pinned/);

        // As an idle sibling would: collapse the shared state to 0.
        await setExtensionStorage(context, { [KEY]: 0 });
        await page.waitForTimeout(500);

        // Stayed out, and the tab re-wrote a fresh expanded timestamp.
        await expect(page.locator('.ilap-launcher')).not.toHaveClass(/stashed/);
        expect((await getExtensionStorage(context, [KEY]))[KEY]).toBeGreaterThan(0);
    });

    test('pinned mounts expanded even with a stale timestamp; external unpin syncs live', async ({ context, page }) => {
        // Stale timestamp normally reads as collapsed at mount — pinned overrides.
        await setExtensionStorage(context, { [KEY]: Date.now() - IDLE_MS * 5, [PIN_KEY]: true });
        await page.goto(PAGE);
        await expect(page.locator('.ilap-launcher')).not.toHaveClass(/stashed/);
        await expect(page.locator('.ilap-pin')).toHaveClass(/pinned/);

        // An unpin written by another surface reaches the live tab.
        await setExtensionStorage(context, { [PIN_KEY]: false });
        await expect(page.locator('.ilap-pin')).not.toHaveClass(/pinned/);
    });
});
