// Custom Playwright fixtures for extension testing.
//
// Chromium only loads an MV3 extension in a PERSISTENT context. The default
// { page, context } fixtures use a non-persistent context, so the extension's
// content scripts never inject and context.serviceWorkers() stays empty (every
// helper in _extension.js then hangs on waitForEvent('serviceworker')).
//
// This module launches a persistent context with the test-flavor extension and
// re-exports `test` / `expect`. Specs should require this instead of
// '@playwright/test'. Persistent contexts ignore the storageState option, so we
// apply the saved Steam login manually via addCookies.
//
// The launcher branches on the project's browser: Chromium loads the unpacked
// extension via --load-extension; Firefox has no such flag, so _firefox.js
// installs it as a temporary add-on over the Remote Debugging Protocol.

const base = require('@playwright/test');
const { chromium } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { launchFirefoxExtensionContext } = require('./_firefox.js');
const { getBridgePage } = require('./_extension.js');

const EXT = path.join(__dirname, '..', 'dist', 'chromium-test');
// Live Steam session cookies. Kept OUTSIDE the repo (the project tree may be
// cloud-synced, where .gitignore offers no protection) — under the user's home.
const AUTH_FILE = path.join(os.homedir(), '.playwright-states', 'steam.json');

// Desktop-width viewport so Steam renders its full layout, but short enough
// that the whole window (incl. browser chrome) fits a 1080p screen — the EQ
// toast is anchored bottom:20px, so an over-tall window pushed its buttons off
// the physical screen.
const COMMON_OPTIONS = {
    headless: false,
    viewport: { width: 1440, height: 810 },
    baseURL: 'https://store.steampowered.com',
};

const test = base.test.extend({
    context: async ({ browserName }, use) => {
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilap-pw-'));
        let context;
        if (browserName === 'firefox') {
            context = await launchFirefoxExtensionContext(userDataDir, COMMON_OPTIONS);
        } else {
            context = await chromium.launchPersistentContext(userDataDir, {
                ...COMMON_OPTIONS,
                args: [
                    '--window-position=0,0',
                    `--disable-extensions-except=${EXT}`,
                    `--load-extension=${EXT}`,
                ],
            });
        }

        // Persistent contexts don't honor the storageState option, so inject the
        // saved Steam session cookies directly.
        if (fs.existsSync(AUTH_FILE)) {
            const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
            if (state.cookies && state.cookies.length) {
                await context.addCookies(state.cookies);
            }
        }

        // Firefox reaches storage through a content-script bridge tab. Warm it
        // now so the first setExtensionStorage in a test isn't slowed by the
        // tab load — some specs seed a storage timestamp and then race a short
        // idle timer, a window the lazy bridge-open latency would blow past.
        if (browserName === 'firefox') {
            await getBridgePage(context);
            // …and then hand the window back to the tab the test drives. Opening
            // the bridge tab raises it, so without this the whole Firefox run is
            // watched from the wrong tab: the store page under test sits behind
            // a static legal page for its entire life. Cosmetic for the asserts
            // (Playwright dispatches into a background tab just as well), but it
            // also puts the test page's visibilityState where Chromium's already
            // is — visible.
            await context.pages()[0].bringToFront();
        }

        await use(context);

        await context.close();
        fs.rmSync(userDataDir, { recursive: true, force: true });
    },

    page: async ({ context }, use) => {
        const page = context.pages()[0] || await context.newPage();
        await use(page);
    },
});

module.exports = { test, expect: base.expect, AUTH_FILE };
