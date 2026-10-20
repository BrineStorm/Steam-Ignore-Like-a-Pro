// SPDX-License-Identifier: GPL-3.0-or-later
//
// An ignore the user sends with Steam's own button joins the gate's stream
// (src/steam-activity.js): the content script sees the page's POST in the
// resource timeline, with its status, and a 429 on it escalates the penalty
// every ignore source waits out. The matcher and the own-POST pairing are unit
// specs (steam-activity.unit.spec.js); this pins the wiring in a real page,
// where the observer has to see a request the PAGE made from the isolated
// world.
//
// The POST is the page's own, so context.route sees it, and answers 429 here:
// nothing reaches Steam. Needs a signed-in session (`npm run test:auth`):
// Steam renders the Ignore button only for one.

const { test, expect } = require('../_fixtures.js');
const { getExtensionStorage, clearExtensionStorage } = require('../_extension.js');

// `npm run test:units` takes all of tests/cross-cutting, and CI runs it on a
// runner with no display and no Steam session.
test.skip(!!process.env.CI, 'Live spec: needs a headed browser and a signed-in session');

// Paid games the test account does not own, so the Ignore button is rendered.
// The free entries of the shared app pool are often in the library.
const APPS = ['1172470', '413150', '105600', '252950'];

test('a 429 on Steam\'s own Ignore button escalates the gate penalty', async ({ context, page }) => {
    const posts = [];
    await context.route(/\/recommended\/ignorerecommendation\/?(\?|$)/, (route) => {
        posts.push(route.request().method());
        return route.fulfill({ status: 429, contentType: 'text/html', body: '' });
    });
    await clearExtensionStorage(context);

    const button = page.locator('.queue_btn_ignore');
    let found = false;
    let loadedAt = 0;
    for (const appid of APPS.sort(() => Math.random() - 0.5)) {
        loadedAt = Date.now();
        await page.goto(`/app/${appid}/`, { waitUntil: 'domcontentloaded' });
        if (await button.isVisible({ timeout: 5000 }).catch(() => false)) { found = true; break; }
    }
    expect(found, 'no app page with an Ignore button: is the session signed in?').toBe(true);
    // The content script is injected at document_idle, and its observer misses
    // a POST made before it exists. Its boot stamps activity once the master
    // switch reads on, by which time the observer is watching.
    await expect.poll(async () => (await getExtensionStorage(context, ['ilap_user_active_at']))
        .ilap_user_active_at || 0, { timeout: 15000 }).toBeGreaterThanOrEqual(loadedAt);

    const before = Date.now();
    await button.click();
    await expect.poll(() => posts.length).toBe(1);

    await expect.poll(async () => {
        const s = await getExtensionStorage(context, ['ilap_ignore_gate_penalty']);
        return s.ilap_ignore_gate_penalty && s.ilap_ignore_gate_penalty.level;
    }).toBe(1);
    const s = await getExtensionStorage(context, ['ilap_ignore_gate', 'ilap_user_active_at']);
    expect(s.ilap_ignore_gate).toBeGreaterThanOrEqual(before);
    expect(s.ilap_user_active_at).toBeGreaterThan(0);
});
