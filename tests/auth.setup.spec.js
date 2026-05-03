const { test, expect } = require('@playwright/test');
const fs = require('fs');

// File where we store session cookies
const AUTH_FILE = 'playwright/.auth/user.json';

test('Setup: Login to Steam', async ({ page }) => {
    // OVERRIDE TIMEOUT: Set timeout to 5 minutes just for this test
    // because manual login takes time.
    test.setTimeout(5 * 60 * 1000);

    // 1. Go to Steam Login page
    await page.goto('https://store.steampowered.com/login/');

    console.log('\n=================================================');
    console.log('    PLEASE LOG IN MANUALLY IN THE BROWSER WINDOW');
    console.log('   Waiting for you to reach the main store page...');
    console.log('=================================================\n');

    // 2. Wait until we see the user avatar (proof of login)
    // We give you 5 minutes to solve Captcha and Guard code
    await expect(page.locator('#account_pulldown')).toBeVisible({ timeout: 300000 });

    // 3. Save storage state (cookies, local storage)
    // Ensure directory exists
    const dir = 'playwright/.auth';
    if (!fs.existsSync(dir)){
        fs.mkdirSync(dir, { recursive: true });
    }
    
    await page.context().storageState({ path: AUTH_FILE });
    
    console.log('✅ Login state saved to ' + AUTH_FILE);
});