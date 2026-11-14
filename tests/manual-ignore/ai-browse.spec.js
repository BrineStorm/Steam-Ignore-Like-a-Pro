// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const { test, expect } = require('../_fixtures.js');
const { SEL, DRAIN_TIMEOUT, waitForContentScript } = require('./_helpers');
const { interceptIgnoreApi, routeLoginProbe } = require('../_steam-routes.js');
const { setExtensionStorage, getExtensionStorage, clearExtensionStorage } = require('../_extension.js');

// The AI tab's level on a store page (src/manual-ignore/ai-browse.js, shot.js).
// LOW marks the AI games a page loads, MEDIUM blurs them too, and HIGH
// queues, shoots, badges and ignores them through the drainer, and flags only
// a game un-ignored by hand. Everything else is left. A shot waits for its
// capsule's art and for enough of the capsule in view, and is drawn inside it. The page is our own,
// served on the store's origin so the content scripts run on it, with capsules
// of games we pick from data/presets.json. Its header reads signed in. The
// extension's userdata read and the ignore POST are stubbed, so nothing
// reaches the account. Which games a scan takes is ai-browse.unit.spec.js's.

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'presets.json'), 'utf8'));
const AI = Object.values(DATA.ai).flat().map(String);
const AI_SET = new Set(AI);
// AI games, a few per test so no two tests share one.
const pick = (from, n) => AI.slice(from, from + n);
// Portal 2, no AI disclosure.
const PLAIN = '620';
if (AI_SET.has(PLAIN)) throw new Error('620 is in the AI lists, pick another plain game');

const PAGE = 'https://store.steampowered.com/ilaptest/aibrowse/';

// A whole 1×1 GIF: a broken image counts as art not loaded, and is never shot.
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
const capsule = (appid, { src = GIF, w = 184, h = 69 } = {}) => `<a class="tab_item" href="https://store.steampowered.com/app/${appid}/Game_${appid}/">`
    + `<img src="${src}" width="${w}" height="${h}" alt="">`
    + `<div class="tab_item_name">Game ${appid}</div></a>`;
// A 1×1 PNG, for capsule art served by a route.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// A store page with these capsules, and `inDialog` ones in an open <dialog>.
function pageHtml(appids, inDialog = []) {
    return '<!doctype html><html><head><title>ILAP AI browsing</title>'
        + '<style>.tab_item{display:block;width:184px;margin:6px}</style></head><body>'
        + '<div id="global_actions"><a class="user_avatar" href="#">me</a></div>'
        + `<div id="page_root">${appids.map(a => capsule(a)).join('')}</div>`
        + (inDialog.length ? `<dialog open>${inDialog.map(a => capsule(a)).join('')}</dialog>` : '')
        + '</body></html>';
}

async function servePage(context, url, html) {
    await context.route(url, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
}

// The extension's userdata read only (`?_=`), as routeUserdata, with a library and a wishlist.
async function routeAccount(context, { owned = [], wishlist = [] } = {}) {
    await context.route('**/dynamicstore/userdata/**', async (route) => {
        if (!new URL(route.request().url()).searchParams.has('_')) return route.continue();
        await route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ rgIgnoredApps: {}, rgOwnedApps: [1].concat(owned.map(Number)), rgWishlist: wishlist.map(Number) }),
        });
    });
}

// Every shot the extension draws, counted in the page's own world: its style,
// the capsule link it was drawn in and when. A tomato's drips are counted
// apart, and so is the time each game's badge came.
async function countShots(page, { withCapsule = false } = {}) {
    await page.addInitScript((overlay) => {
        window.__ilapShots = [];
        window.__ilapDrips = 0;
        window.__ilapBadgeAt = {};
        new MutationObserver((muts) => {
            for (const m of muts) for (const n of m.addedNodes) {
                if (!n.classList) continue;
                if (n.classList.contains('ilap-shot-drip')) window.__ilapDrips++;
                if (n.matches(overlay) && n.dataset.ilapAppid) window.__ilapBadgeAt[n.dataset.ilapAppid] = performance.now();
                const style = /\bilap-shot-(tomato|emoji|aimark|sixseven|swipe)\b/.exec(n.className);
                if (!style) continue;
                const cap = n.closest('a[href*="/app/"]');
                window.__ilapShots.push({
                    style: style[1], at: performance.now(),
                    capsule: cap ? /\/app\/(\d+)/.exec(cap.getAttribute('href'))[1] : null,
                    blurred: !!(cap && cap.querySelector('.ilap-ai-blur, .ilap-blur-backdrop')),
                });
            }
        // The document itself: an init script runs before <html> exists.
        }).observe(document, { childList: true, subtree: true });
    }, SEL.overlay);
    return () => page.evaluate((full) => window.__ilapShots.map(s => (full ? s : s.style)), withCapsule);
}

const badge = (page, appid) => page.locator(`${SEL.overlay}[data-ilap-appid="${appid}"]`);
const posted = (calls) => calls.filter(c => !c.remove).map(c => c.appid);

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — AI games while browsing', () => {

    test('the AI games a page loads are shot, badged and ignored, the rest are left', async ({ page, context }) => {
        const games = pick(0, 3);
        const [boxed] = pick(3, 1);
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context);
        await servePage(context, PAGE, pageHtml(games.concat(PLAIN), [boxed]));
        await setExtensionStorage(context, { ilap_ai_level: 3, ilap_ai_shot: 'tomato' });
        const shots = await countShots(page, { withCapsule: true });
        // Every AI flag the page ever gets: High draws none before the shot.
        await page.addInitScript(() => {
            window.__ilapFlags = 0;
            new MutationObserver((ms) => {
                for (const m of ms) for (const n of m.addedNodes) {
                    if (n.nodeType === 1 && (n.matches('.ilap-ai-flagbox') || n.querySelector('.ilap-ai-flagbox'))) window.__ilapFlags += 1;
                }
            }).observe(document, { childList: true, subtree: true });
        });

        await page.goto(PAGE);
        await waitForContentScript(page);

        for (const appid of games) await expect(badge(page, appid)).toHaveCount(1, { timeout: 10000 });
        // One tomato per game, splatted inside its own capsule, with its
        // juice running down (at least three drips each). The cover is sharp
        // when the shot starts, and the badge and the blur come 0.3 s after
        // the tomato lands, while the juice still runs.
        const drawn = await shots();
        expect(drawn.map(d => d.style)).toEqual(games.map(() => 'tomato'));
        expect(drawn.map(d => d.capsule).sort()).toEqual([...games].sort());
        for (const d of drawn) expect(d.blurred, d.capsule).toBe(false);
        expect(await page.evaluate(() => window.__ilapDrips)).toBeGreaterThanOrEqual(games.length * 3);
        // One load's games are shot one after another, 0.3 s apart
        // (shot.js STAGGER_MS), so the badges come 0.3 s apart too.
        const badgeAt = await page.evaluate(() => window.__ilapBadgeAt);
        const lags = drawn.map(d => badgeAt[d.capsule] - d.at).sort((a, b) => a - b);
        lags.forEach((lag, k) => {
            expect(lag, String(k)).toBeGreaterThan(800 + 300 * k - 60);
            expect(lag, String(k)).toBeLessThan(1500 + 300 * k);
            if (k) expect(lag - lags[k - 1], String(k)).toBeGreaterThan(240);
        });
        // The capsule's top right corner has the crossed AI, and the flag
        // is gone, over the blurred cover.
        for (const appid of games) {
            await expect(badge(page, appid)).toHaveClass(/\bilap-ignored-auto\b/);
            const cap = page.locator(`a[href*="/app/${appid}/"]`);
            await expect(cap.locator('.ilap-ai-tag')).toHaveCount(1);
            await expect(cap.locator('.ilap-ai-tag')).toHaveClass(/\bilap-ai-tag-ignored\b/);
            await expect(cap.locator('.ilap-ai-flagbox')).toHaveCount(0);
            // The crossed-out mark's image (the red slash's gradient), not the plain one.
            const mark = await cap.locator('.ilap-ai-tag').evaluate(el => getComputedStyle(el).backgroundImage);
            expect(mark).toContain('linearGradient');
            await expect(cap.locator('img').first()).toHaveClass(/\bilap-ai-blur\b/);
            const corner = await cap.evaluate((el) => {
                const c = el.getBoundingClientRect();
                const t = el.querySelector('.ilap-ai-tag').getBoundingClientRect();
                return [Math.round(c.right - t.right), Math.round(t.top - c.top)];
            });
            expect(corner).toEqual([3, 3]);
        }
        await expect.poll(() => posted(calls).sort(), { timeout: DRAIN_TIMEOUT }).toEqual([...games].sort());
        for (const c of calls) expect(c.reason).toBe(0);
        expect(await page.evaluate(() => window.__ilapFlags)).toBe(0);
        await expect(badge(page, PLAIN)).toHaveCount(0);
        await expect(badge(page, boxed)).toHaveCount(0);
        // The marks stay a moment, then go, and leave no scrollbar.
        await expect(page.locator('.ilap-shot-layer')).toHaveCount(0, { timeout: 10000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

    test('at Off the page is left as it is', async ({ page, context }) => {
        const games = pick(4, 2);
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context);
        await servePage(context, PAGE, pageHtml(games));
        // Low is the default, so Off is picked.
        await setExtensionStorage(context, { ilap_ai_level: 0 });
        await page.goto(PAGE);
        await waitForContentScript(page);
        await page.waitForTimeout(2500);
        expect(calls).toEqual([]);
        for (const appid of games) await expect(badge(page, appid)).toHaveCount(0);
        await expect(page.locator('.ilap-ai-tag, .ilap-ai-flagbox')).toHaveCount(0);
    });

    test('games the user owns or wishlisted are left, with no flag', async ({ page, context }) => {
        const [owned, wished, free] = pick(6, 3);
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context, { owned: [owned], wishlist: [wished] });
        await servePage(context, PAGE, pageHtml([owned, wished, free]));
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await page.goto(PAGE);
        await waitForContentScript(page);
        await expect(badge(page, free)).toHaveCount(1, { timeout: 10000 });
        await expect.poll(() => posted(calls), { timeout: DRAIN_TIMEOUT }).toEqual([free]);
        await expect(badge(page, owned)).toHaveCount(0);
        await expect(badge(page, wished)).toHaveCount(0);
        await expect(page.locator('.ilap-ai-flagbox')).toHaveCount(0);
    });

    test('the 67th game shot gets the 67, whatever the style: it flies in over the whole window, lands in its capsule cracking it, and its flight layer goes', async ({ page, context }) => {
        const [appid] = pick(28, 1);
        await interceptIgnoreApi(context);
        await routeAccount(context);
        await servePage(context, PAGE, pageHtml([appid]));
        await setExtensionStorage(context, { ilap_ai_level: 3, ilap_ai_shot: 'swipe', ilap_ai_shot_count: 66 });
        const shots = await countShots(page, { withCapsule: true });
        // The flight's first painted size, and whether its layer is fixed.
        // The landing's cracks, flash and shards, and the capsule they are in.
        await page.addInitScript(() => {
            window.__ilapFly = [];
            window.__ilapCrack = [];
            new MutationObserver((muts) => {
                for (const m of muts) for (const n of m.addedNodes) {
                    if (!n.classList) continue;
                    const part = /\bilap-shot-(crack|flash|shard)\b/.exec(n.className);
                    if (part) {
                        const cap = n.closest('a[href*="/app/"]');
                        window.__ilapCrack.push({
                            part: part[1], lines: n.querySelectorAll('path').length,
                            capsule: cap ? /\/app\/(\d+)/.exec(cap.getAttribute('href'))[1] : null,
                        });
                    }
                    if (!n.classList.contains('ilap-shot-follow')) continue;
                    requestAnimationFrame(() => window.__ilapFly.push({
                        height: n.firstElementChild.getBoundingClientRect().height,
                        fixed: getComputedStyle(n.parentElement).position === 'fixed',
                    }));
                }
            }).observe(document, { childList: true, subtree: true });
        });
        await page.goto(PAGE);
        await waitForContentScript(page);
        await expect(badge(page, appid)).toHaveCount(1, { timeout: 10000 });
        const [fly] = await page.evaluate(() => window.__ilapFly);
        const capH = await page.locator(`a[href*="/app/${appid}/"]`).evaluate(el => el.getBoundingClientRect().height);
        expect(fly.fixed).toBe(true);
        expect(fly.height).toBeGreaterThan(capH * 3);
        expect((await shots()).map(({ style, capsule }) => ({ style, capsule }))).toEqual([{ style: 'sixseven', capsule: appid }]);
        // One crack drawing of at least nine cracks, one flash and a dozen
        // shards, all in the 67's capsule.
        const crack = await page.evaluate(() => window.__ilapCrack);
        expect(crack.filter(c => c.part === 'crack').map(c => c.lines >= 9)).toEqual([true]);
        expect(crack.filter(c => c.part === 'flash')).toHaveLength(1);
        expect(crack.filter(c => c.part === 'shard')).toHaveLength(12);
        expect(new Set(crack.map(c => c.capsule))).toEqual(new Set([appid]));
        await expect(page.locator('.ilap-shot-sky')).toHaveCount(0, { timeout: 10000 });
        await expect(page.locator('.ilap-shot-layer')).toHaveCount(0, { timeout: 10000 });
        expect((await getExtensionStorage(context, 'ilap_ai_shot_count')).ilap_ai_shot_count).toBe(67);
    });

    test('a capsule the page adds later is shot too, in the style picked', async ({ page, context }) => {
        const [late] = pick(9, 1);
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context);
        await servePage(context, PAGE, pageHtml([PLAIN]));
        await setExtensionStorage(context, { ilap_ai_level: 3, ilap_ai_shot: 'emoji' });
        const shots = await countShots(page);
        await page.goto(PAGE);
        await waitForContentScript(page);
        await page.evaluate((html) => document.getElementById('page_root').insertAdjacentHTML('beforeend', html), capsule(late));
        await expect(badge(page, late)).toHaveCount(1, { timeout: 10000 });
        expect(await shots()).toEqual(['emoji']);
        await expect.poll(() => posted(calls), { timeout: DRAIN_TIMEOUT }).toEqual([late]);
    });

    test('the emoji stamp draws the emoji picked in the AI tab, and a new pick on the next shot', async ({ page, context }) => {
        const [first, late, third] = pick(46, 3);
        await interceptIgnoreApi(context);
        await routeAccount(context);
        await servePage(context, PAGE, pageHtml([first]));
        await setExtensionStorage(context, { ilap_ai_level: 3, ilap_ai_shot: 'emoji', ilap_ai_shot_emoji: '\u{1F4A9}' });
        // The text of every emoji stamp, in flight and landed.
        await page.addInitScript(() => {
            window.__ilapEmoji = [];
            const STAMP = '.ilap-shot-emoji, .ilap-fly-emoji';
            new MutationObserver((muts) => {
                for (const m of muts) for (const n of m.addedNodes) {
                    if (!n.querySelectorAll) continue;
                    for (const s of [n, ...n.querySelectorAll(STAMP)]) if (s.matches(STAMP)) window.__ilapEmoji.push(s.textContent);
                }
            // The document itself: an init script runs before <html> exists.
            }).observe(document, { childList: true, subtree: true });
        });
        const glyphs = () => page.evaluate(() => [...new Set(window.__ilapEmoji)]);
        await page.goto(PAGE);
        await waitForContentScript(page);
        await expect(badge(page, first)).toHaveCount(1, { timeout: 10000 });
        expect(await glyphs()).toEqual(['\u{1F4A9}']);

        // Picked again while the page is open: the next capsule gets the new one.
        await page.evaluate(() => { window.__ilapEmoji = []; });
        await setExtensionStorage(context, { ilap_ai_shot_emoji: '\u{270C}\u{FE0F}' });
        await page.waitForTimeout(300);
        await page.evaluate((html) => document.getElementById('page_root').insertAdjacentHTML('beforeend', html), capsule(late));
        await expect(badge(page, late)).toHaveCount(1, { timeout: 10000 });
        expect(await glyphs()).toEqual(['\u{270C}\u{FE0F}']);

        // A value no build offers is the thumbs down.
        await page.evaluate(() => { window.__ilapEmoji = []; });
        await setExtensionStorage(context, { ilap_ai_shot_emoji: 'not an emoji' });
        await page.waitForTimeout(300);
        await page.evaluate((html) => document.getElementById('page_root').insertAdjacentHTML('beforeend', html), capsule(third));
        await expect(badge(page, third)).toHaveCount(1, { timeout: 10000 });
        expect(await glyphs()).toEqual(['\u{1F44E}']);
    });

    test('the red swipe and the crossed-out AI are drawn too', async ({ page, context }) => {
        // Once: every init script runs on each load.
        const shots = await countShots(page);
        for (const [style, cls, appid] of [['swipe', 'swipe', pick(11, 1)[0]], ['ai', 'aimark', pick(29, 1)[0]]]) {
            await interceptIgnoreApi(context);
            await routeAccount(context);
            await servePage(context, PAGE, pageHtml([appid]));
            await setExtensionStorage(context, { ilap_ai_level: 3, ilap_ai_shot: style });
            await page.goto(PAGE);
            await waitForContentScript(page);
            await expect(badge(page, appid)).toHaveCount(1, { timeout: 10000 });
            expect(await shots(), style).toEqual([cls]);
            await context.unrouteAll({ behavior: 'ignoreErrors' });
        }
    });

    test('with no style picked the shot is the crossed-out AI', async ({ page, context }) => {
        const [appid] = pick(62, 1);
        await interceptIgnoreApi(context);
        await routeAccount(context);
        await servePage(context, PAGE, pageHtml([appid]));
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        const shots = await countShots(page);
        await page.goto(PAGE);
        await waitForContentScript(page);
        await expect(badge(page, appid)).toHaveCount(1, { timeout: 10000 });
        expect(await shots()).toEqual(['aimark']);
    });

    test('random gives each capsule its own style, and its emoji is any of the grid', async ({ page, context }) => {
        const games = pick(35, 4);
        await interceptIgnoreApi(context);
        await routeAccount(context);
        await servePage(context, PAGE, pageHtml(games));
        await setExtensionStorage(context, { ilap_ai_level: 3, ilap_ai_shot: 'random', ilap_ai_shot_emoji: '\u{1F40C}' });
        const shots = await countShots(page);
        await page.goto(PAGE);
        await waitForContentScript(page);
        for (const appid of games) await expect(badge(page, appid)).toHaveCount(1, { timeout: 10000 });
        expect((await shots()).sort()).toEqual(['aimark', 'emoji', 'swipe', 'tomato']);
        // Its emoji is dealt from the grid (the unit spec has the deal).
        await expect(page.locator('.ilap-shot-emoji')).toHaveText(/\p{Extended_Pictographic}/u, { timeout: 5000 });
    });

    test('a shot is drawn on its capsule and moves with the page', async ({ page, context }) => {
        const [appid] = pick(23, 1);
        await interceptIgnoreApi(context);
        await routeAccount(context);
        await servePage(context, PAGE, pageHtml([appid]).replace('</body>', '<div style="height:2400px"></div></body>'));
        await setExtensionStorage(context, { ilap_ai_level: 3, ilap_ai_shot: 'swipe' });
        await page.goto(PAGE);
        await waitForContentScript(page);
        await expect(page.locator('.ilap-shot-layer')).toHaveCount(1, { timeout: 10000 });
        const boxes = () => page.evaluate((id) => {
            const cap = document.querySelector(`a[href*="/app/${id}/"]`);
            const l = cap.querySelector(':scope > .ilap-shot-layer');
            const r = (el) => { const b = el.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round); };
            return { capsule: r(cap), layer: l ? r(l) : null };
        }, appid);
        const before = await boxes();
        expect(before.layer).toEqual(before.capsule);
        await page.evaluate(() => window.scrollBy(0, 40));
        const after = await boxes();
        expect(after.layer).toEqual(after.capsule);
        expect(after.capsule[1]).toBe(before.capsule[1] - 40);
    });

    test('a capsule just in from the window\'s bottom waits until its whole shot fits in view', async ({ page, context }) => {
        const [below] = pick(24, 1);
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context);
        const html = pageHtml([PLAIN]).replace('</div></body>',
            `<div style="height:2400px"></div>${capsule(below)}</div><div style="height:2400px"></div></body>`);
        await servePage(context, PAGE, html);
        await setExtensionStorage(context, { ilap_ai_level: 3, ilap_ai_shot: 'swipe' });
        const shots = await countShots(page);
        await page.goto(PAGE);
        await waitForContentScript(page);
        // Scrolled so the capsule's top edge is 20 px over the window's bottom.
        const link = page.locator(`a[href*="/app/${below}/"]`);
        await link.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - (window.innerHeight - 20)));
        expect(Math.round(await link.evaluate(el => window.innerHeight - el.getBoundingClientRect().top))).toBe(20);
        await page.waitForTimeout(2500);
        expect(await shots()).toEqual([]);
        expect(calls).toEqual([]);
        await page.evaluate(() => window.scrollBy(0, 120));
        await expect(badge(page, below)).toHaveCount(1, { timeout: 10000 });
        expect(await shots()).toEqual(['swipe']);
    });

    test('no shot and no POST before the capsule\'s art has loaded', async ({ page, context }) => {
        const [appid] = pick(25, 1);
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context);
        const art = 'https://store.steampowered.com/ilaptest/art/' + appid + '.png';
        let release;
        const held = new Promise(r => { release = r; });
        await context.route(art, async (route) => {
            await held;
            await route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
        });
        await servePage(context, PAGE, pageHtml([]).replace('<div id="page_root"></div>',
            `<div id="page_root">${capsule(appid, { src: art })}</div>`));
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        const shots = await countShots(page);
        await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        expect(await shots()).toEqual([]);
        expect(calls).toEqual([]);
        await expect(badge(page, appid)).toHaveCount(0);
        release();
        await expect(badge(page, appid)).toHaveCount(1, { timeout: 10000 });
        expect(await shots()).toEqual(['aimark']);
        await expect.poll(() => posted(calls), { timeout: DRAIN_TIMEOUT }).toEqual([appid]);
    });

    test('the red swipe fits a small capsule, such as a search row', async ({ page, context }) => {
        const [appid] = pick(26, 1);
        await interceptIgnoreApi(context);
        await routeAccount(context);
        const row = capsule(appid, { w: 120, h: 45 }).replace('class="tab_item"', 'class="tab_item" style="width:120px"');
        await servePage(context, PAGE, pageHtml([]).replace('<div id="page_root"></div>', `<div id="page_root">${row}</div>`));
        await setExtensionStorage(context, { ilap_ai_level: 3, ilap_ai_shot: 'swipe' });
        await page.goto(PAGE);
        await waitForContentScript(page);
        const swipe = page.locator('.ilap-shot-swipe');
        await expect(swipe).toHaveCount(1, { timeout: 10000 });
        const fit = await swipe.evaluate((el) => {
            const s = el.getBoundingClientRect();
            const c = el.closest('a').getBoundingClientRect();
            return { inside: s.top >= c.top && s.bottom <= c.bottom && s.left >= c.left && s.right <= c.right, thick: el.offsetHeight };
        });
        expect(fit.inside).toBe(true);
        expect(fit.thick).toBeLessThan(12);
    });

    test('the IGNORED badge and the crossed AI grow with a big capsule, a small one keeps the base size, a search row doubles the mark', async ({ page, context }) => {
        const [big, row, searchRow] = pick(50, 3);
        await interceptIgnoreApi(context);
        await routeAccount(context);
        const wide = (appid, w, h) => capsule(appid, { w, h }).replace('class="tab_item"', `class="tab_item" style="width:${w}px"`);
        // A Steam search result: a wide row with its 184x69 cover at the start.
        const search = (appid) => `<a class="search_result_row" style="display:flex;width:984px" href="https://store.steampowered.com/app/${appid}/Game_${appid}/">`
            + `<div class="search_capsule"><img src="${GIF}" width="184" height="69" style="display:block" alt=""></div>`
            + `<div class="responsive_search_name_combined"><span class="title">Game ${appid}</span></div></a>`;
        await servePage(context, PAGE, pageHtml([]).replace('<div id="page_root"></div>',
            `<div id="page_root">${wide(big, 562, 263)}${wide(row, 120, 45)}${search(searchRow)}</div>`));
        await setExtensionStorage(context, { ilap_ai_level: 3, ilap_ai_shot_anim: false });
        await page.goto(PAGE);
        await waitForContentScript(page);
        const size = async (appid) => {
            await expect(badge(page, appid)).toHaveCount(1, { timeout: 10000 });
            const cap = page.locator(`a[href*="/app/${appid}/"]`);
            await expect(cap.locator('.ilap-ai-tag-ignored')).toHaveCount(1);
            return cap.evaluate((el) => {
                const b = el.querySelector('.ilap-ignored-overlay'), m = el.querySelector('.ilap-ai-tag');
                // The base sizes in styles.css, by the badge's kind.
                const base = b.classList.contains('ilap-grid-badge') ? 10 : b.classList.contains('ilap-hero-badge') ? 12 : 11;
                const p = b.parentElement;
                return {
                    side: Number(b.style.getPropertyValue('--ilap-side')),
                    want: Math.round(Math.sqrt(p.offsetWidth * p.offsetHeight)),
                    font: parseFloat(getComputedStyle(b).fontSize), base,
                    mark: m.getBoundingClientRect().height,
                };
            });
        };
        // The big capsule's badge is as many times its base size as its side
        // is over 260 px, up to 1.6, and its mark reaches the 68 px cap.
        const b = await size(big);
        expect(b.side).toBe(b.want);
        expect(b.font).toBeCloseTo(b.base * Math.min(1.6, b.side / 260), 1);
        expect(b.font).toBeGreaterThan(b.base * 1.3);
        expect(Math.round(b.mark)).toBe(68);
        // A small capsule keeps the base badge and the smallest mark.
        const r = await size(row);
        expect(r.font).toBe(r.base);
        expect(Math.round(r.mark)).toBe(20);
        // A search row's mark sits in its cover, at twice the smallest size.
        await expect(badge(page, searchRow)).toHaveCount(1, { timeout: 10000 });
        const mark = page.locator(`a[href*="/app/${searchRow}/"] .ilap-ai-tag-ignored`);
        await expect(mark).toHaveCount(1);
        expect(await mark.evaluate(el => [el.parentElement.className, Math.round(el.getBoundingClientRect().height)]))
            .toEqual(['search_capsule', 40]);
    });

    test('a game un-ignored by hand on its badge is never shot again, and takes the AI flag', async ({ page, context }) => {
        const [appid] = pick(27, 1);
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context);
        // The rollback reads an empty ignore list here, and an undo pass then
        // asks /account/ whether the session is live: answered signed in, so the
        // test does not hang on the saved session.
        await routeLoginProbe(context, true);
        await servePage(context, PAGE, pageHtml([appid]));
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await page.goto(PAGE);
        await waitForContentScript(page);
        await expect(badge(page, appid)).toHaveCount(1, { timeout: 10000 });
        // Past the un-ignore's cooldown, so the click is taken whether the
        // ignore was sent already or not.
        await page.waitForTimeout(2500);
        await badge(page, appid).click();
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_ai_spared')).ilap_ai_spared,
            { timeout: 10000 }).toEqual([appid]);
        await expect(badge(page, appid)).toHaveCount(0, { timeout: DRAIN_TIMEOUT });
        const flag = page.locator(`a[href*="/app/${appid}/"] .ilap-ai-flagbox`);
        await expect(flag).toHaveCount(1, { timeout: 5000 });

        const shots = await countShots(page);
        const before = posted(calls).length;
        await page.reload();
        await waitForContentScript(page);
        await page.waitForTimeout(2500);
        expect(await shots()).toEqual([]);
        await expect(badge(page, appid)).toHaveCount(0);
        await expect(flag).toHaveCount(1);
        expect(posted(calls).length).toBe(before);
    });

    test('at High only the game un-ignored by hand has the AI flag, and it is left unshot', async ({ page, context }) => {
        const [spared, other] = pick(54, 2);
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context);
        await servePage(context, PAGE, pageHtml([spared, other]));
        await setExtensionStorage(context, { ilap_ai_level: 3, ilap_ai_spared: [spared] });
        await page.goto(PAGE);
        await waitForContentScript(page);
        await expect(badge(page, other)).toHaveCount(1, { timeout: 10000 });
        await expect(page.locator(`a[href*="/app/${spared}/"] .ilap-ai-flagbox > .ilap-ai-flag`)).toHaveCount(1, { timeout: 5000 });
        await expect(page.locator(`a[href*="/app/${other}/"] .ilap-ai-flagbox`)).toHaveCount(0);
        await expect.poll(() => posted(calls), { timeout: DRAIN_TIMEOUT }).toEqual([other]);
        await expect(badge(page, spared)).toHaveCount(0);
    });

    test('a game the user ignored elsewhere is left unshot and keeps its reason, though the read does not have it yet', async ({ page, context }) => {
        const [queued, logged, other] = pick(58, 3);
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context);
        await servePage(context, PAGE, pageHtml([queued, logged, other]));
        const now = Date.now();
        await setExtensionStorage(context, {
            ilap_ai_level: 3, ilap_ai_shot: 'tomato',
            // A blue swipe from another tab still waiting, and one that has landed,
            // dated ahead so a slow machine cannot age it past the read's lag.
            ilap_curator_queue: [{
                id: 'job_mi', type: 'mi', curatorId: 'mi', curatorName: '', appids: [queued],
                meta: { [queued]: { name: 'Swiped', reason: 2, ts: now } }, total: 1, status: 'pending', addedAt: now,
            }],
            ilap_ignore_log_index: { first: 0, last: 0 },
            ilap_ignore_log_c0: [{ appid: logged, ts: now + 60000, source: 'mi' }],
        });
        const shots = await countShots(page, { withCapsule: true });
        await page.goto(PAGE);
        await waitForContentScript(page);
        await expect(badge(page, other)).toHaveCount(1, { timeout: 10000 });
        expect((await shots()).map(s => s.capsule)).toEqual([other]);
        await expect.poll(() => calls.filter(c => !c.remove).map(c => [c.appid, c.reason]).sort(), { timeout: DRAIN_TIMEOUT })
            .toEqual([[queued, 2], [other, 0]].sort());
        await expect(badge(page, queued)).toHaveCount(0);
        await expect(badge(page, logged)).toHaveCount(0);
    });

    test('with reduced motion the badge comes with no shot', async ({ page, context }) => {
        const [appid] = pick(12, 1);
        await interceptIgnoreApi(context);
        await routeAccount(context);
        await servePage(context, PAGE, pageHtml([appid]));
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const shots = await countShots(page);
        await page.goto(PAGE);
        await waitForContentScript(page);
        await expect(badge(page, appid)).toHaveCount(1, { timeout: 10000 });
        expect(await shots()).toEqual([]);
    });

    test('with the shot animation off the badge comes at once with no shot, and the game is still ignored', async ({ page, context }) => {
        const [appid] = pick(13, 1);
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context);
        await servePage(context, PAGE, pageHtml([appid]));
        await setExtensionStorage(context, { ilap_ai_level: 3, ilap_ai_shot: 'tomato', ilap_ai_shot_anim: false });
        const shots = await countShots(page);
        await page.goto(PAGE);
        await waitForContentScript(page);
        await expect(badge(page, appid)).toHaveCount(1, { timeout: 10000 });
        await expect(badge(page, appid)).toHaveClass(/\bilap-ignored-auto\b/);
        await expect(page.locator(`a[href*="/app/${appid}/"] .ilap-ai-tag-ignored`)).toHaveCount(1);
        expect(await shots()).toEqual([]);
        expect(await page.evaluate(() => window.__ilapDrips)).toBe(0);
        await expect(page.locator('.ilap-shot-layer, .ilap-shot-sky')).toHaveCount(0);
        await expect.poll(() => posted(calls), { timeout: DRAIN_TIMEOUT }).toEqual([appid]);
    });

    test('a capsule out of view waits, and is shot once it scrolls into view', async ({ page, context }) => {
        const [below] = pick(15, 1);
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context);
        const html = pageHtml([PLAIN]).replace('</div></body>',
            `<div style="height:2400px"></div>${capsule(below)}</div></body>`);
        await servePage(context, PAGE, html);
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        const shots = await countShots(page);
        await page.goto(PAGE);
        await waitForContentScript(page);
        await page.waitForTimeout(2500);
        expect(calls).toEqual([]);
        await expect(badge(page, below)).toHaveCount(0);
        await page.locator(`a[href*="/app/${below}/"]`).scrollIntoViewIfNeeded();
        await expect(badge(page, below)).toHaveCount(1, { timeout: 10000 });
        expect((await shots()).length).toBe(1);
        await expect.poll(() => posted(calls), { timeout: DRAIN_TIMEOUT }).toEqual([below]);
    });

    test('on a Classic Discovery Queue page only the strip under the game is shot', async ({ page, context }) => {
        const [own, above, strip] = pick(16, 3);
        const url = `https://store.steampowered.com/app/${own}/Game_${own}/?queue=1`;
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context);
        const html = pageHtml([above]).replace('</div></body>',
            `<div class="related_items_ctn">${capsule(strip)}</div></div></body>`);
        await context.route(`https://store.steampowered.com/app/${own}/**`,
            (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await page.goto(url);
        await waitForContentScript(page);
        await expect(badge(page, strip)).toHaveCount(1, { timeout: 10000 });
        await expect.poll(() => posted(calls), { timeout: DRAIN_TIMEOUT }).toEqual([strip]);
        await expect(badge(page, above)).toHaveCount(0);
    });

    test('the game whose page is open is left, the games on it are shot', async ({ page, context }) => {
        const [own, other] = pick(13, 2);
        const url = `https://store.steampowered.com/app/${own}/Game_${own}/`;
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context);
        await servePage(context, url, pageHtml([own, other]));
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await page.goto(url);
        await waitForContentScript(page);
        await expect(badge(page, other)).toHaveCount(1, { timeout: 10000 });
        await expect.poll(() => posted(calls), { timeout: DRAIN_TIMEOUT }).toEqual([other]);
        await expect(badge(page, own)).toHaveCount(0);
    });

    test('Low flags every AI game, owned ones too, and blurs, badges and sends nothing', async ({ page, context }) => {
        const [owned, other] = pick(30, 2);
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context, { owned: [owned] });
        await servePage(context, PAGE, pageHtml([owned, other, PLAIN]));
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        const shots = await countShots(page);
        await page.goto(PAGE);
        await waitForContentScript(page);
        for (const appid of [owned, other]) {
            const flag = page.locator(`a[href*="/app/${appid}/"] .ilap-ai-flagbox > .ilap-ai-flag`);
            await expect(flag).toHaveCount(1, { timeout: 10000 });
            await expect(flag).toHaveText(/^AI\b/);
        }
        await expect(page.locator(`a[href*="/app/${PLAIN}/"] .ilap-ai-flagbox`)).toHaveCount(0);
        await expect(page.locator('.ilap-ai-tag')).toHaveCount(0);
        await page.waitForTimeout(2500);
        await expect(page.locator('.ilap-ai-blur')).toHaveCount(0);
        expect(calls).toEqual([]);
        expect(await shots()).toEqual([]);
        await expect(page.locator(SEL.overlay)).toHaveCount(0);

        // The flag says what it is with its words and takes no pointer: a
        // hover over it raises no tooltip of ours.
        const flag = page.locator(`a[href*="/app/${other}/"] .ilap-ai-flag`);
        await flag.hover({ force: true });
        await page.waitForTimeout(1500);
        await expect(page.locator('body > .ilap-tooltip-floating.show')).toHaveCount(0);
    });

    test('Medium marks and blurs the AI games and sends nothing, a level change repaints, the master off strips it all', async ({ page, context }) => {
        const games = pick(32, 2);
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context);
        await servePage(context, PAGE, pageHtml(games.concat(PLAIN)));
        await setExtensionStorage(context, { ilap_ai_level: 2 });
        await page.goto(PAGE);
        await waitForContentScript(page);
        for (const appid of games) {
            const cap = page.locator(`a[href*="/app/${appid}/"]`);
            await expect(cap.locator('.ilap-ai-flagbox')).toHaveCount(1, { timeout: 10000 });
            await expect(cap.locator('img').first()).toHaveClass(/\bilap-ai-blur\b/);
        }
        await expect(page.locator(`a[href*="/app/${PLAIN}/"] img`)).not.toHaveClass(/\bilap-ai-blur\b/);
        await page.waitForTimeout(2500);
        expect(calls).toEqual([]);
        await expect(page.locator(SEL.overlay)).toHaveCount(0);
        // The blur setting is the badges' own: off, it leaves the AI blur.
        await setExtensionStorage(context, { ilap_mask_enabled: false });
        await page.waitForTimeout(500);
        await expect(page.locator('.ilap-ai-blur')).toHaveCount(games.length);
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        await expect(page.locator('.ilap-ai-blur')).toHaveCount(0, { timeout: 5000 });
        await expect(page.locator('.ilap-ai-flagbox')).toHaveCount(games.length, { timeout: 5000 });
        await setExtensionStorage(context, { ilap_master_enabled: false });
        await expect(page.locator('.ilap-ai-flagbox')).toHaveCount(0, { timeout: 5000 });
    });

    test('a level lowered from High leaves the shot games ignored and badged', async ({ page, context }) => {
        const [appid] = pick(34, 1);
        const calls = await interceptIgnoreApi(context);
        await routeAccount(context);
        await servePage(context, PAGE, pageHtml([appid]));
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await page.goto(PAGE);
        await waitForContentScript(page);
        await expect(badge(page, appid)).toHaveCount(1, { timeout: 10000 });
        await expect.poll(() => posted(calls), { timeout: DRAIN_TIMEOUT }).toEqual([appid]);
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        await page.waitForTimeout(1500);
        await expect(badge(page, appid)).toHaveCount(1);
        await expect(page.locator(`a[href*="/app/${appid}/"] .ilap-ai-tag`)).toHaveClass(/\bilap-ai-tag-ignored\b/);
        expect(calls.filter(c => c.remove)).toEqual([]);
    });
});
