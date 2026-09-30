// The first open of the widget panel must never show the bare popup markup.
// initPopup reads storage asynchronously (the UI keys, then the ignore log for
// the undo button, then the settings panel if its accordion was left open), so
// a panel revealed before those land flashes the static markup for a frame: a
// broken header icon, the master toggle off, Total 0 / Last None, no gesture
// hints, an empty settings accordion that then grows.
//
// A MutationObserver on the panel's class snapshots the panel in the same
// turn `.open` appears — before the next paint — so the test sees exactly what
// the first painted frame would show.

const { test, expect, AUTH_FILE } = require('../_fixtures.js');
const { setExtensionStorage } = require('../_extension.js');
const fs = require('fs');

const { searchUrl } = require('../_search.js'); // random search term per navigation

test.describe.configure({ retries: 2 }); // hover/corner-driven, like the rest of the widget suite

test.describe('on-page widget — first open', () => {

    test('the panel is revealed already hydrated, never as the bare markup', async ({ context, page }) => {
        test.skip(!fs.existsSync(AUTH_FILE), 'no saved Steam session — run: npm run test:auth'); // panel is login-gated

        await setExtensionStorage(context, {
            ilap_ignored_count: 42,
            ilap_last_ignored_name: 'Hydrated Game',
            ilap_settings_open: true, // the settings accordion restores open: its fill is part of the first frame
        });
        await page.goto(searchUrl());

        await page.locator('.ilap-chevron').click();
        const launcher = page.locator('.ilap-launcher');
        await expect(launcher).not.toHaveClass(/stashed/);
        await expect(launcher).not.toHaveClass(/locked/);

        await page.evaluate(() => {
            const root = document.getElementById('ilap-widget-host').shadowRoot;
            const panel = root.querySelector('.ilap-panel');
            new MutationObserver((recs, obs) => {
                if (!panel.classList.contains('open')) return;
                obs.disconnect();
                const $ = (id) => root.getElementById(id);
                window.__ilapFirstOpen = {
                    iconSrc: $('ilap-header-icon').getAttribute('src') || '',
                    master: $('master-toggle').checked,
                    count: $('count-link').textContent.trim(),
                    last: $('last-game').textContent.trim(),
                    hints: $('dynamic-hint').children.length,
                    settingsOpen: $('settings-accordion').open,
                    settingsRows: $('settings-placeholder').children.length,
                    undoDisabled: $('undo-btn').disabled,
                };
            }).observe(panel, { attributes: true, attributeFilter: ['class'] });
        });

        await launcher.click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);

        const snap = await page.evaluate(() => window.__ilapFirstOpen);
        expect(snap.iconSrc).toContain('assets/icons/icon48.png');
        expect(snap.master).toBe(true);              // default on
        expect(snap.count).toBe('42');
        expect(snap.last).toBe('Hydrated Game');
        expect(snap.hints).toBeGreaterThan(0);       // Ignore / Already played lines
        expect(snap.settingsOpen).toBe(true);
        expect(snap.settingsRows).toBeGreaterThan(0); // no empty-then-grow accordion
        expect(snap.undoDisabled).toBe(true);        // empty ignore log; the markup ships it enabled
    });
});
