// SPDX-License-Identifier: GPL-3.0-or-later
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

// Target the test-flavor Chromium extension (built via `node build.js --test`).
// This flavor includes a placeholder MV3 service worker so tests can resolve
// the extension ID via context.serviceWorkers(). Production dist/chromium/
// is untouched.
const CHROMIUM_EXTENSION_PATH = path.join(__dirname, 'dist', 'chromium-test');

module.exports = defineConfig({
  testDir: './tests',

  // Snapshot ignored apps before the run; un-ignore exactly the diff after.
  // Keeps the test account clean of games the suite ignores. See tests/_cleanup.js.
  globalSetup: require.resolve('./tests/global-setup.js'),
  globalTeardown: require.resolve('./tests/global-teardown.js'),

  // Timeout for each test (30 seconds)
  timeout: 30 * 1000,
  
  expect: {
    timeout: 5000
  },

  // Run tests sequentially to avoid conflicting login states.
  // One worker = one headed browser window at a time. Extensions are heavy in
  // headed mode; more workers race for CPU and the service-worker handshake
  // (context.waitForEvent('serviceworker')) starts timing out.
  fullyParallel: false,
  workers: 1,

  // Simple console reporter
  reporter: 'list',

  use: {
    // Extensions only work in headed mode (visible browser)
    headless: false,
    
    // Take a screenshot if test fails
    screenshot: 'only-on-failure',
    
    // Base URL for Steam
    baseURL: 'https://store.steampowered.com',
    
    // Collect trace when retrying the failed test
    trace: 'on-first-retry',
  },

  projects: [
    {
      // Manual Steam login. Only run via `npm run test:auth` (--project=setup).
      // Kept out of the default run so `npm test` never blocks waiting for login.
      name: 'setup',
      testMatch: /auth\.setup\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
            args: [
                `--disable-extensions-except=${CHROMIUM_EXTENSION_PATH}`,
                `--load-extension=${CHROMIUM_EXTENSION_PATH}`
            ],
        }
      },
    },
    {
      name: 'chromium',
      testIgnore: /auth\.setup\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        // Chrome-specific args to load the unpacked extension
        launchOptions: {
            args: [
                `--disable-extensions-except=${CHROMIUM_EXTENSION_PATH}`,
                `--load-extension=${CHROMIUM_EXTENSION_PATH}`
            ],
        }
      },
    },
  ],
});