// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const { test, expect, AUTH_FILE } = require('../_fixtures.js');
const { SEL, pickRows, rightClickSwipe, installContextMenuSpy, readContextMenuSpy } = require('../manual-ignore/_helpers');
const { interceptIgnoreApi, routeUserdata } = require('../_steam-routes.js');
const { getExtensionId, setExtensionStorage, getExtensionStorage, clearExtensionStorage, popupUrl } = require('../_extension.js');
const { searchUrl } = require('../_search.js');

// The extension on an old, busy machine: the page's CPU is slowed RATE times over
// CDP, and each test checks that things still happen, and happen once. No time is
// measured, so a slow run is no failure. A lost swipe, a capsule left unmarked, a
// second POST or a stuck panel is.
//
// Only the page's main thread is slowed. The browser process and storage keep their
// speed, so a machine short of memory or disk can still fail in ways this cannot
// show. The test build's service worker is empty, so the drain runs in the slowed
// page, and the shipping worker's own drain is not covered here.
//
// Ignore POSTs and the extension's userdata read are stubbed: nothing reaches the
// account.
//
// Not part of `npm test`: `npm run test:slow`, before a release. No retries, since
// a test that passes only on its second try is what this suite looks for.

const RATE = 6;
const LONG = 180000;

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'presets.json'), 'utf8'));
const AI = [...new Set(Object.values(DATA.ai).flat().map(String))];
// Capsules of no real game, with appids far over any Steam has given.
const plain = (n, base = 90000000) => Array.from({ length: n }, (_, i) => String(base + i));
const mix = (a, b) => a.flatMap((x, i) => (i < b.length ? [x, b[i]] : [x]));

const PAGE = 'https://store.steampowered.com/ilaptest/slow/';
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
const capsule = (appid) => `<a class="tab_item" href="https://store.steampowered.com/app/${appid}/Game_${appid}/">`
    + `<img src="${GIF}" width="184" height="69" alt=""><div class="tab_item_name">Game ${appid}</div></a>`;

// A store page with these capsules. Its header reads signed in.
const servePage = (context, appids) => context.route(PAGE, (route) => route.fulfill({
    status: 200, contentType: 'text/html',
    body: '<!doctype html><html><head><title>ILAP slow machine</title>'
        + '<style>.tab_item{display:block;width:184px;margin:6px}</style></head><body>'
        + '<div id="global_actions"><a class="user_avatar" href="#">me</a></div>'
        + `<div id="page_root">${appids.map(capsule).join('')}</div></body></html>`,
}));

async function slowDown(context, page) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
}

// Content scripts boot on 'load' and then read storage. The main thread going idle
// says the boot's work is through, at whatever speed this machine has today.
async function settled(page) {
    await page.waitForLoadState('load');
    await page.evaluate(() => new Promise((r) => requestIdleCallback(r, { timeout: 30000 })));
    await page.waitForTimeout(800);
}

// The same work, its best of three, in milliseconds.
const workMs = (page) => page.evaluate(() => {
    let best = Infinity;
    for (let round = 0; round < 3; round++) {
        const start = performance.now();
        let x = 0;
        for (let i = 0; i < 2e7; i++) x = (x + i) % 7;
        if (x >= 0) best = Math.min(best, performance.now() - start);
    }
    return best;
});

const capsuleOf = (page, appid) => page.locator(`a[href*="/app/${appid}/"]`);
const badge = (page, appid) => page.locator(`${SEL.overlay}[data-ilap-appid="${appid}"]`);
const posted = (calls) => calls.filter(c => !c.remove).map(c => c.appid).sort();
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function pickLevel(page, level, context) {
    await page.locator(`#ai-tab-pane .ai-level-tick[data-level="${level}"]`).click();
    await page.locator('#ai-tab-pane #ai-level-ok').click();
    await expect.poll(async () => (await getExtensionStorage(context, 'ilap_ai_level')).ilap_ai_level).toBe(level);
}

// Years of use: the ignore log at its cap, and a built-in list as long as a list
// gets, waiting in the queue. The log's games, the list's and the test's differ.
function longTimeUser() {
    const now = Date.now();
    const seed = { ilap_ignore_log_index: { first: 1, last: 200 } };
    for (let seq = 1; seq <= 200; seq++) {
        seed['ilap_ignore_log_c' + seq] = Array.from({ length: 100 }, (_, i) => {
            const n = (seq - 1) * 100 + i;
            return { appid: String(70000000 + n), name: 'Game ' + n, ts: now - 3600e3 - (20000 - n) * 1000, source: 'curator', curatorId: 'preset_ai' };
        });
    }
    const key = 'ai_' + Object.keys(DATA.ai)[0];
    const id = 'job_preset_' + key + '_1';
    seed.ilap_curator_queue = [{
        id, type: 'preset', curatorId: 'preset_' + key, presetKey: key, presetRev: '', total: 20000, status: 'pending', addedAt: now,
    }];
    seed['ilap_curator_appids_' + id] = plain(20000, 80000000);
    // No creators: the undo button stays live while the account ignores any.
    seed.ilap_creators = { ignored: {}, followed: [], ts: now };
    return seed;
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test('the slowdown is real, on a store page and in the panel, and outlives a navigation', async ({ page, context }) => {
    await servePage(context, []);
    await page.goto(PAGE);
    const fast = await workMs(page);
    await slowDown(context, page);
    expect(await workMs(page)).toBeGreaterThan(fast * 2);
    await page.goto(popupUrl(await getExtensionId(context)));
    expect(await workMs(page)).toBeGreaterThan(fast * 2);
});

test.describe(`Slow machine: the CPU slowed ${RATE} times`, () => {
    test.beforeEach(async ({ context, page }) => {
        await slowDown(context, page);
    });

    test('swipes both ways on a live search page: each badges its row, takes the native menu and sends one POST with its reason', async ({ page, context }) => {
        test.skip(!fs.existsSync(AUTH_FILE), 'no saved Steam session, run: npm run test:auth');
        const calls = await interceptIgnoreApi(context);
        await routeUserdata(context, []);
        await page.goto(searchUrl());
        await settled(page);
        const [red, blue] = await pickRows(page, 2);
        await installContextMenuSpy(page);

        await rightClickSwipe(page, red.link, 120);
        await rightClickSwipe(page, blue.link, -120);

        await expect(badge(page, red.appid)).toHaveCount(1);
        await expect(badge(page, blue.appid)).toHaveCount(1);
        await expect.poll(() => Object.fromEntries(calls.map(c => [c.appid, c.reason])), { timeout: LONG })
            .toEqual({ [red.appid]: 0, [blue.appid]: 2 });
        expect(calls).toHaveLength(2);
        const spy = await readContextMenuSpy(page);
        expect(spy.fired).toBeGreaterThan(0);
        expect(spy.prevented).toBe(spy.fired);
    });

    test('the toolbar panel: a tab picked at once stays picked, a level and a shot are stored, the lists drawer opens whole', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_surface_mode: 'popup', ilap_popup_tab: 'settings' });
        await page.goto(popupUrl(await getExtensionId(context)), { waitUntil: 'commit' });
        // With no wait for the boot, which restores the stored tab. The pick landing
        // inside that read is tabs.spec.js's, which holds the read: the slowdown
        // alone does not reach it (seen with that fix taken out).
        await page.locator('#tab-ai').click();
        await expect(page.locator('#tab-ai')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#ai-tab-pane')).toBeVisible();
        await settled(page);
        await expect(page.locator('#tab-ai')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#ai-tab-pane')).toBeVisible();

        await pickLevel(page, 3, context);
        await page.locator('.ai-shot-opt:has(input[value="tomato"])').click();
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_ai_shot')).ilap_ai_shot).toBe('tomato');
        await expect(page.locator('#ai-shot-name')).toHaveText('Tomato');

        await page.locator('#lists-btn').click();
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/sliding/);
        await expect(page.locator('#ai-pane .list-row')).toBeVisible();
        expect(await noSideScroll(page)).toBe(true);
    });

    test('the on-page widget on a live search page opens with its data, switches a tab and stores a level', async ({ page, context }) => {
        test.skip(!fs.existsSync(AUTH_FILE), 'no saved Steam session, run: npm run test:auth');
        await interceptIgnoreApi(context);
        await routeUserdata(context, []);
        await setExtensionStorage(context, {
            ilap_ignored_count: 42,
            // Fresh, so the page's own poll leaves it alone.
            ilap_ignored_total: { total: 900, tallyAt: 40, ts: Date.now() },
            ilap_last_ignored_name: 'Hydrated Game',
        });
        await page.goto(searchUrl());
        await settled(page);

        await page.locator('.ilap-chevron').click();
        const launcher = page.locator('.ilap-launcher');
        await expect(launcher).not.toHaveClass(/stashed/);
        await expect(launcher).not.toHaveClass(/locked/);
        await launcher.click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);
        await expect(page.locator('#count-link')).toHaveText('42');
        await expect(page.locator('#last-game')).toHaveText('Hydrated Game');

        await page.locator('#tab-ai').click();
        await expect(page.locator('#ai-tab-pane')).toBeVisible();
        await pickLevel(page, 2, context);
    });

    test('300 capsules at Medium: every AI game gets its flag and blur, the plain ones none, and so with capsules added later', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        await routeUserdata(context, []);
        await servePage(context, mix(AI.slice(0, 120), plain(180)));
        await setExtensionStorage(context, { ilap_ai_level: 2 });
        await page.goto(PAGE);
        const flagged = () => page.locator('.ilap-ai-flagbox').evaluateAll(els => els.map(el => el.dataset.ilapAppid).sort());

        await expect.poll(flagged, { timeout: 30000 }).toEqual(AI.slice(0, 120).sort());
        await expect(page.locator('img.ilap-ai-blur')).toHaveCount(120);

        // As an endless page adds its next rows.
        const more = mix(AI.slice(120, 160), plain(20, 91000000)).map(capsule).join('');
        await page.evaluate((html) => document.getElementById('page_root').insertAdjacentHTML('beforeend', html), more);
        await expect.poll(flagged, { timeout: 30000 }).toEqual(AI.slice(0, 160).sort());
        await expect(page.locator('img.ilap-ai-blur')).toHaveCount(160);

        expect(calls).toEqual([]);
        expect(await noSideScroll(page)).toBe(true);
    });

    test('30 AI games at High with a fling through the page: each is shot, badged and ignored once, and no mark stays', async ({ page, context }) => {
        const games = AI.slice(200, 230);
        const calls = await interceptIgnoreApi(context);
        await routeUserdata(context, []);
        await servePage(context, mix(games, plain(30)));
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await page.goto(PAGE);
        await settled(page);

        // Down and back at once, while the first shots fly.
        await page.mouse.move(400, 400);
        for (const dy of [1500, 1500, 1500, -4500]) {
            await page.mouse.wheel(0, dy);
            await page.waitForTimeout(200);
        }
        // Every capsule comes to rest in view at some point.
        for (const appid of games) {
            await capsuleOf(page, appid).scrollIntoViewIfNeeded();
            await expect(badge(page, appid)).toHaveCount(1);
        }

        await expect.poll(() => posted(calls), { timeout: LONG }).toEqual([...games].sort());
        for (const c of calls) expect(c.reason).toBe(0);
        await expect(page.locator('.ilap-shot-layer')).toHaveCount(0);
        await expect(page.locator('.ilap-shot-sky')).toHaveCount(0);
        for (const appid of plain(3)) await expect(badge(page, appid)).toHaveCount(0);
        expect(await noSideScroll(page)).toBe(true);
    });

    test('a full ignore log and a 20000-game list waiting: the panel opens with both, a shot and a swipe go out, and the list goes on', async ({ page, context }) => {
        const [shot] = AI.slice(300, 301);
        const [swiped] = plain(1);
        const calls = await interceptIgnoreApi(context);
        await routeUserdata(context, []);
        await servePage(context, [shot, swiped]);
        await setExtensionStorage(context, { ...longTimeUser(), ilap_surface_mode: 'popup', ilap_ai_level: 3 });

        await page.goto(popupUrl(await getExtensionId(context)));
        await expect(page.locator('#queue-jobs-chip')).toHaveText('1');
        await page.locator('#undo-btn').click();
        await expect(page.locator('#undo-count')).toHaveAttribute('placeholder', '20000');
        await page.keyboard.press('Escape');
        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer')).toHaveClass(/open/);
        await expect(page.locator('#queue-drawer')).not.toHaveClass(/sliding/);
        await expect(page.locator('#queue-list')).toBeVisible();

        await page.goto(PAGE);
        await settled(page);
        await rightClickSwipe(page, capsuleOf(page, swiped), 120);
        await expect(badge(page, swiped)).toHaveCount(1);
        await expect(badge(page, shot)).toHaveCount(1);
        await expect.poll(() => posted(calls).filter(a => a === shot || a === swiped), { timeout: LONG })
            .toEqual([shot, swiped].sort());
        await expect.poll(() => posted(calls).length, { timeout: LONG }).toBeGreaterThan(2);
    });
});
