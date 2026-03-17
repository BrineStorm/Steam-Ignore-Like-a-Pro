const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

// Target the built Chromium extension folder
const CHROMIUM_EXTENSION_PATH = path.join(__dirname, 'dist', 'chromium');

module.exports = defineConfig({
  testDir: './tests',
  
  // Timeout for each test (30 seconds)
  timeout: 30 * 1000,
  
  expect: {
    timeout: 5000
  },

  // Run tests sequentially to avoid conflicting login states
  fullyParallel: false,

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
      name: 'chromium',
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