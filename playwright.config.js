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
      // 75 s, over the 30 s default, because the heaviest Manual-Ignore specs
      // spend their budget in three sequential live waits, not one: a storefront
      // widget hydrating (15 s), the deferred swipe reaching its POST
      // (DRAIN_TIMEOUT), then the badge rendering (DRAIN_TIMEOUT again). At the
      // default those add up past the per-test limit, so DRAIN_TIMEOUT was never
      // reachable in full — the test died on the global lid first, and raising
      // the one without the other would have changed nothing. Costs a green run
      // nothing (every wait exits on its condition); it only lets a slow machine
      // or a slow connection finish instead of reporting a product bug.
      timeout: 75 * 1000,
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
    {
      // Firefox runs the browser-driven suites that operate on store pages. The
      // extension is loaded per-context by tests/_firefox.js (RDP
      // installTemporaryAddon) — there are no launch args to pass here.
      // Excluded:
      //  - auth setup (login is captured once, under Chromium);
      //  - the Node unit specs (vm-based, browser-independent — they already
      //    run in the chromium project: *.unit.spec.js, all of cross-cutting/,
      //    and explore-queue/decision-matrix.spec.js);
      //  - anything that navigates to the moz-extension popup page: Firefox
      //    blocks top-level navigation to privileged extension pages, so the
      //    whole popup/ suite and manual-ignore/popup-history are Chromium-only.
      //    The same popup UI is exercised on-page by the widget suite.
      //  - everything else runs: Firefox drains the curator queue with the same
      //    content-script drainer these suites exercise.
      name: 'firefox',
      // Headed Firefox launches heavier than Chromium and each context also
      // installs the add-on over RDP and warms a bridge tab, so setup plus a
      // slow store page can brush past the default 30 s. Give it more room.
      // 90 s, not 60: on a full run three of the four flaky tests died on this
      // limit rather than on an assertion — including one in a beforeEach, where
      // the per-test context launch alone ate the budget.
      // 110 s, not 90, for the same reason one step further out: the fixture now
      // raises the tab under test back to the front (tests/_fixtures.js), so its
      // store page actually renders instead of idling as a background tab.
      // Measured across a full run that cost a median of +1.4 s per test — cheap,
      // except at the tail, where three tests went from green to dying on the
      // limit itself ("Target page… has been closed", not an assertion).
      timeout: 110 * 1000,
      // Synthetic mouse-gesture timing and the per-context add-on install get
      // flaky under a long headed run's CPU contention — tests solid in
      // isolation intermittently miss, and the Manual-Ignore swipe/Ctrl+Click
      // suite is especially gesture-heavy (Firefox also emits contextmenu at
      // mousedown, mid-gesture). The boot-render and DQ-panel flakiness that
      // used to justify these is gone (it was the content-script bootstrap race,
      // see src/manual-ignore/main.js), but BOTH retries still earn their keep:
      // on a full run the widget pin-hover test needed retry #2 to land.
      retries: 2,
      testIgnore: [
        /auth\.setup\.spec\.js/,
        /\.unit\.spec\.js$/,
        /cross-cutting[\\/]/,
        /decision-matrix\.spec\.js/,
        /popup[\\/]/,
        /popup-history\.spec\.js/,
      ],
      use: {
        ...devices['Desktop Firefox'],
      },
    },
  ],
});