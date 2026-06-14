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

const base = require('@playwright/test');
const { chromium } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT = path.join(__dirname, '..', 'dist', 'chromium-test');
// Live Steam session cookies. Kept OUTSIDE the repo (the project tree may be
// cloud-synced, where .gitignore offers no protection) — under the user's home.
const AUTH_FILE = path.join(os.homedir(), '.playwright-states', 'steam.json');

const test = base.test.extend({
    context: async ({}, use) => {
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilap-pw-'));
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            // Desktop-width viewport so Steam renders its full layout, but short
            // enough that the whole window (incl. browser chrome) fits a 1080p
            // screen — the EQ toast is anchored bottom:20px, so an over-tall
            // window pushed its buttons off the physical screen.
            viewport: { width: 1440, height: 810 },
            baseURL: 'https://store.steampowered.com',
            args: [
                '--window-position=0,0',
                `--disable-extensions-except=${EXT}`,
                `--load-extension=${EXT}`,
            ],
        });

        // Persistent contexts don't honor the storageState option, so inject the
        // saved Steam session cookies directly.
        if (fs.existsSync(AUTH_FILE)) {
            const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
            if (state.cookies && state.cookies.length) {
                await context.addCookies(state.cookies);
            }
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
