// Widget login gate. The on-page surface must not offer queue/settings
// management to a logged-out user: the launcher renders locked (greyed +
// "sign in" tooltip) and the panel does not open. A page opened BEFORE the
// user signed in (in another tab) still reads logged-out in its own DOM, so a
// click while locked re-probes the live cookies and unlocks in place.
//
// Playwright CSS selectors pierce the open shadow root, so .ilap-launcher /
// .ilap-panel resolve straight through #ilap-widget-host. No ignore API is
// ever reachable here (the panel carries no ignore action), so no route
// interception is needed.
//
// WHEN THIS SUITE GOES RED, SUSPECT THE SAVED SESSION FIRST — refresh it with
// `npm run test:auth`. The "logged in" test guards only on the auth FILE
// existing, which a half-dead session passes: the cookies in steam.json are
// still there (and Steam may still paint a logged-in site header), but they no
// longer authenticate, so `probeLogin`'s GET of /account/ redirects to /login
// and the widget correctly keeps the launcher locked. Symptom: it still reads
// .ilap-launcher.locked — i.e. the assertion looks like a lock-logic regression
// while the lock is in fact doing its job. The "stale pre-login" test is immune:
// it stubs the probe instead (see routeLoginProbe).

const { test, expect, AUTH_FILE } = require('../_fixtures.js');
const fs = require('fs');

const { searchUrl } = require('../_search.js'); // random search term per navigation
const { routeLoginProbe } = require('../_steam-routes.js');

// The widget mounts collapsed to the chevron tab on fresh storage — slide the
// launcher out first (see collapse.spec.js for the collapse behaviour itself).
async function expandWidget(page) {
    await page.locator('.ilap-chevron').click();
    await expect(page.locator('.ilap-launcher')).not.toHaveClass(/stashed/);
}

test.describe('on-page widget — login lock', () => {

    test('logged out: launcher locked (grey + tooltip), click does not open the panel', async ({ context, page }) => {
        await context.clearCookies();
        await page.goto(searchUrl());
        await expandWidget(page);

        const launcher = page.locator('.ilap-launcher');
        await expect(launcher).toHaveClass(/locked/);
        // Our own tooltip (not a native browser title), shown immediately on hover.
        await expect(launcher).not.toHaveAttribute('title');
        await launcher.hover();
        const tip = page.locator('.ilap-login-tip.shown');
        await expect(tip).toContainText(/Steam/);

        await launcher.click();
        // The click fires a live probe against logged-out cookies — it must
        // resolve to "still logged out": give it time, then assert nothing opened.
        await page.waitForTimeout(2000);
        await expect(page.locator('.ilap-panel')).not.toHaveClass(/open/);
        await expect(launcher).toHaveClass(/locked/);
    });

    test('stale pre-login page unlocks on click once the session appears', async ({ context, page }) => {
        // The page is genuinely signed out (cookies cleared, header renders
        // logged-out — that is what locks the launcher in the first place); only
        // the live probe the CLICK makes is stubbed, because re-adding the saved
        // cookies no longer produces a session Steam honours without a
        // navigation, and "no reload" is exactly what this test is about (see
        // routeLoginProbe).
        const setSignedIn = await routeLoginProbe(context, false);
        await context.clearCookies();
        await page.goto(searchUrl());
        await expandWidget(page);
        const launcher = page.locator('.ilap-launcher');
        await expect(launcher).toHaveClass(/locked/);

        // "User signs in in another tab": the session appears while THIS page,
        // loaded logged-out, stays open — its DOM still says logged-out.
        setSignedIn(true);

        await launcher.click(); // re-probe → unlock + open
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/, { timeout: 10000 });
        await expect(launcher).not.toHaveClass(/locked/);
        await expect(launcher).not.toHaveAttribute('title');
    });

    test('logged in: launcher unlocked, click opens the panel', async ({ page }) => {
        test.skip(!fs.existsSync(AUTH_FILE), 'no saved Steam session — run: npm run test:auth');

        await page.goto(searchUrl());
        await expandWidget(page);
        const launcher = page.locator('.ilap-launcher');
        await expect(launcher).not.toHaveClass(/locked/);

        await launcher.click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);
    });
});
