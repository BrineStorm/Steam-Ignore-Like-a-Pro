const { test, expect } = require('../_fixtures.js');
const { AUTH_FILE, SEL, openExploreQueue, interceptIgnoreApi } = require('./_helpers');
const { setExtensionStorage, clearExtensionStorage } = require('../_extension.js');
const presets = require('../../data/presets.json');

test.use({ storageState: AUTH_FILE });

// The AI tab's HIGH level in a Classic Discovery Queue run: a game whose page
// shows a non-empty AI disclosure is ignored whatever its reviews. The queue
// serves whatever game is next, so the served page is rewritten on its way in.
// Steam's own descriptor blocks and review rows are renamed away (the game then
// has no reviews, which "Bad Reviews" mode spares) and the test's block goes
// in. Only an AI verdict can ignore such a game. Every ignore is route-faked.

// Games the built-in lists name count with no disclosure on the page, so the
// tests walk the queue to a game they do not name.
const LISTED = new Set(Object.values(presets.ai).flat().map(String));
const MAX_POSITIONS = 8;

const block = (heading, text) => '<div id="game_area_content_descriptors" class="game_area_description" data-ilap-test>'
    + `<h2>${heading}</h2><p>The developers describe it like this:</p><p><i>${text}</i></p></div>`;
const AI_RU = block('Информация об ИИ-контенте', 'Some of the background art was generated with AI.');
const MATURE = block('Mature Content Description', 'This game contains violence.');

async function rewriteQueuePages(context, inject) {
    await context.route((url) => /^\/app\/\d+/.test(url.pathname) && url.searchParams.has('queue'), async (route) => {
        if (route.request().resourceType() !== 'document') return route.continue();
        const res = await route.fetch();
        const body = (await res.text())
            .replace(/id="game_area_content_descriptors"/g, 'id="ilap_test_descriptors"')
            .replace(/id="userReviews"/g, 'id="ilap_test_reviews"')
            .replace('</body>', `${inject}</body>`);
        await route.fulfill({ response: res, body });
    });
}

// A queue page whose game no built-in list names. The queue lands on it by a
// redirect, which a route never sees, so the page is loaded again and then
// comes rewritten.
async function openUnlistedGame(page) {
    for (let pos = 0; pos < MAX_POSITIONS; pos++) {
        const appid = await openExploreQueue(page, pos);
        if (!appid || LISTED.has(appid)) continue;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('[data-ilap-test]')).toHaveCount(1);
        await expect(page.locator(SEL.runBtn)).toBeVisible({ timeout: 15000 });
        return appid;
    }
    throw new Error(`no unlisted game in the first ${MAX_POSITIONS} queue positions`);
}

async function runAndReadBadge(page) {
    await page.locator(SEL.runBtn).click();
    const badge = page.locator('.ilap-micro-badge').first();
    await badge.waitFor({ state: 'attached', timeout: 30000 });
    return (await badge.textContent()).trim().toUpperCase();
}

test.describe('Classic DQ — AI games on the AI tab\'s HIGH level', () => {
    test.beforeEach(async ({ context }) => {
        await clearExtensionStorage(context);
        await setExtensionStorage(context, {
            ilap_q_master: true, ilap_q_mode: 'bad', ilap_automation_ack: true,
            ilap_ai_keep_translation: true, ilap_ai_keep_ingame: true,
        });
    });

    test.afterEach(async ({ context }) => {
        await clearExtensionStorage(context);
    });

    test('HIGH ignores a game with no reviews for its disclosure, in the page\'s language', async ({ page, context }) => {
        test.setTimeout(180000);
        const calls = await interceptIgnoreApi(context);
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await rewriteQueuePages(context, AI_RU);
        const appid = await openUnlistedGame(page);

        expect(await runAndReadBadge(page)).toBe('IGNORED');
        expect(calls.filter(c => c.appid === appid)).toEqual([{ appid, reason: 0 }]);
    });

    test('the Mature Content Description of the same id is no disclosure', async ({ page, context }) => {
        test.setTimeout(180000);
        const calls = await interceptIgnoreApi(context);
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await rewriteQueuePages(context, MATURE);
        const appid = await openUnlistedGame(page);

        expect(await runAndReadBadge(page)).toBe('NO REVIEWS');
        expect(calls.filter(c => c.appid === appid)).toEqual([]);
    });

    test('below HIGH the disclosure changes nothing', async ({ page, context }) => {
        test.setTimeout(180000);
        const calls = await interceptIgnoreApi(context);
        await setExtensionStorage(context, { ilap_ai_level: 2 });
        await rewriteQueuePages(context, AI_RU);
        const appid = await openUnlistedGame(page);

        expect(await runAndReadBadge(page)).toBe('NO REVIEWS');
        expect(calls.filter(c => c.appid === appid)).toEqual([]);
    });
});
