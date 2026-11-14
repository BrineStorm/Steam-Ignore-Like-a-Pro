// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const { test, expect } = require('../_fixtures.js');
const { waitForContentScript } = require('./_helpers');
const { interceptIgnoreApi } = require('../_steam-routes.js');
const { setExtensionStorage, clearExtensionStorage } = require('../_extension.js');

// The AI tab's flag on an AI game's capsule (src/manual-ignore/ai-marks.js
// tag, styles.css .ilap-ai-flag) next to Steam's own capsule flags.
// It must stand where Steam's IN LIBRARY stands, under it when both are there,
// survive Steam re-flagging the capsule, take no pointer, and fold and hide as
// Steam's flags do. The fixture page is ours, on the store's origin, with
// Steam's own flag rules copied verbatim from its stylesheets
// (shared_global.css, search.css, home.css) and its search row markup. The last
// tests run on the real search page, where Steam's own hover card must still
// open over a flagged row. LOW only: nothing is queued or sent.

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'presets.json'), 'utf8'));
const ALL = new Set(Object.values(DATA.ai).flat().map(Number));
const TRANSLATION = DATA.aikeep.translation.map(Number);
const INGAME = DATA.aikeep.ingame.map(Number);
const KEPT = new Set(TRANSLATION.concat(INGAME));
const MANUAL = (DATA.aimanual || []).map(Number);
// An AI game of each kind the flag names.
const REMOVED = (DATA.airemoved || []).map(Number);
const PLAIN_AI = [...ALL].filter(a => !KEPT.has(a) && !MANUAL.includes(a) && !REMOVED.includes(a)).map(String);
const TR = TRANSLATION.filter(a => ALL.has(a) && !INGAME.includes(a) && !REMOVED.includes(a)).map(String);
const IG = INGAME.filter(a => ALL.has(a) && !REMOVED.includes(a)).map(String);
const BY_HAND = MANUAL.filter(a => ALL.has(a)).map(String);
// Portal 2, no AI disclosure.
const PLAIN = '620';
if (ALL.has(Number(PLAIN))) throw new Error('620 is in the AI lists, pick another plain game');

const PAGE = 'https://store.steampowered.com/ilaptest/aiflag/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// Steam's flag rules as its stylesheets have them.
const STEAM_FLAG_CSS = `
.ds_flag { position: absolute; left: 0; top: 14px; font-size: 10px; color: #111111; box-shadow: 0 0 10px rgba(0,0,0,0.9); height: 18px; line-height: 19px; padding: 0 0 0 18px; white-space: nowrap; z-index: 5; }
.ds_flag.ds_owned_flag { background: #4f95bd; }
.search_result_row .ds_flag { top: 12px; }
.ds_collapse_flag.ds_flagged .ds_flag { overflow: hidden; max-width: 0; transition: all 0.5s; }
.ds_collapse_flag.ds_flagged:hover .ds_flag { max-width: 120px; }
.v7 .ds_flagged { container-type: inline-size; container-name: ds_flagged_capsule; }
@container ds_flagged_capsule (max-width: 250px) { .ds_flag { width: 0; overflow: hidden; } }
.with_microtrailer:hover .ds_flag, .hover_active .ds_flag { opacity: 0; }
`;

// A search row as Steam serves it. `owned`: Steam has flagged it IN LIBRARY.
const row = (appid, { owned = false } = {}) => `<a class="search_result_row ds_collapse_flag${owned ? ' ds_flagged ds_owned' : ''}" data-ds-appid="${appid}" `
    + `href="https://store.steampowered.com/app/${appid}/Game_${appid}/" style="display:block;position:relative;height:69px;margin:4px 0;background:#16202d">`
    + `<div class="search_capsule"><img src="https://ilaptest.invalid/cap/${appid}.png" width="184" height="69" alt=""></div>`
    + `<div class="search_name"><span class="title">Game ${appid}</span></div>`
    + (owned ? '<div class="ds_flag ds_owned_flag">IN LIBRARY&nbsp;&nbsp;</div>' : '')
    + '</a>';
// A home capsule Steam has flagged, as small as Steam folds its flags on.
const homeCap = (appid) => `<div class="v7"><a class="store_capsule ds_flagged ds_owned" data-ds-appid="${appid}" `
    + `href="https://store.steampowered.com/app/${appid}/" style="display:block;position:relative;width:200px;height:94px">`
    + `<img src="https://ilaptest.invalid/cap/${appid}.png" width="200" height="94" alt="">`
    + '<div class="ds_flag ds_owned_flag">IN LIBRARY&nbsp;&nbsp;</div></a></div>';

function pageHtml(body) {
    return '<!doctype html><html><head><title>ILAP AI flag</title>'
        + `<style>body{background:#1b2838;font:12px Arial,sans-serif;color:#c6d4df}${STEAM_FLAG_CSS}</style></head><body>`
        + '<div id="global_actions"><a class="user_avatar" href="#">me</a></div>'
        + `<div id="page_root" style="width:900px">${body}</div></body></html>`;
}

async function serve(context, body) {
    await context.route('https://ilaptest.invalid/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    await context.route(PAGE, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: pageHtml(body) }));
}

const flagOf = (page, appid) => page.locator(`.ilap-ai-flagbox[data-ilap-appid="${appid}"] > .ilap-ai-flag`);
const rectOf = (locator) => locator.evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height }; });

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — the AI flag next to Steam\'s own flags', () => {

    test('each AI capsule gets one flag where Steam puts its own, naming the AI use; a plain game gets none', async ({ page, context }) => {
        const [ai] = PLAIN_AI;
        await serve(context, row(ai) + row(TR[0]) + row(IG[0]) + row(BY_HAND[0]) + row(PLAIN) + row(PLAIN_AI[1], { owned: true }));
        await setExtensionStorage(context, { ilap_ai_level: 1, ilap_lang: 'en' });
        await page.goto(PAGE);
        await waitForContentScript(page);

        await expect(flagOf(page, ai)).toHaveCount(1);
        await expect(flagOf(page, ai)).toHaveText('AI');
        await expect(flagOf(page, ai)).toHaveAttribute('data-kind', 'ai');
        await expect(flagOf(page, TR[0])).toHaveAttribute('data-kind', 'translation');
        await expect(flagOf(page, TR[0])).toHaveText(/^AI · \S/);
        await expect(flagOf(page, IG[0])).toHaveAttribute('data-kind', 'ingame');
        await expect(flagOf(page, IG[0])).toHaveText(/^AI · \S/);
        // A game the lists mark by hand (aimanual) looks like any AI game here.
        await expect(flagOf(page, BY_HAND[0])).toHaveAttribute('data-kind', 'ai');
        await expect(flagOf(page, BY_HAND[0])).toHaveText('AI');
        await expect(page.locator(`.ilap-ai-flagbox[data-ilap-appid="${PLAIN}"]`)).toHaveCount(0);
        // Uppercase as Steam's flags, from the words in the dictionary.
        expect(await flagOf(page, TR[0]).evaluate(el => getComputedStyle(el).textTransform)).toBe('uppercase');

        // Steam's rule for a search row places it: 12px from the row's top, at
        // its left edge, as Steam's own flag in the owned row below stands.
        const r = await page.locator(`a[data-ds-appid="${ai}"]`).evaluate(el => el.getBoundingClientRect().toJSON());
        const f = await rectOf(flagOf(page, ai));
        expect(Math.round(f.top - r.top)).toBe(12);
        expect(Math.round(f.left - r.left)).toBe(0);
        expect(Math.round(f.height)).toBe(18);
        const owned = page.locator(`a[data-ds-appid="${PLAIN_AI[1]}"]`);
        const steam = await rectOf(owned.locator(':scope > .ds_flag.ds_owned_flag'));
        const or = await owned.evaluate(el => el.getBoundingClientRect().toJSON());
        expect(Math.round(steam.top - or.top)).toBe(12);
    });

    test('one flag per game in a row: a curator review row with its cover and a small gift link flags the cover only, whichever comes first', async ({ page, context }) => {
        // A curator review row as Steam serves it: the capsule link, and a second
        // link to the same game over the whole review text, with small platform
        // and gift icons at its right.
        const review = (appid, textFirst) => {
            const cover = `<div><a class="store_capsule" data-ds-appid="${appid}" href="https://store.steampowered.com/app/${appid}/" style="display:block;position:relative;width:229px;height:107px">`
                + `<img src="https://ilaptest.invalid/cap/${appid}.png" width="229" height="107" alt=""></a></div>`;
            const text = `<a class="recommendation_link" href="https://store.steampowered.com/app/${appid}/?curator_clanid=1" style="display:block;position:relative;width:600px;height:107px">`
                + '<div class="recommendation_desc">Gen AI used!</div>'
                + '<div class="icons" style="position:absolute;right:4px;top:4px"><img src="https://ilaptest.invalid/win.png" width="16" height="16" alt="">'
                + '<img src="https://ilaptest.invalid/gift.png" width="16" height="16" alt=""></div></a>';
            return `<div class="recommendation" style="position:relative;display:flex;gap:10px;margin:6px 0;background:#16202d">`
                + (textFirst ? text + cover : cover + text) + '</div>';
        };
        const [a, b] = PLAIN_AI;
        await serve(context, review(a, false) + review(b, true));
        await setExtensionStorage(context, { ilap_ai_level: 1, ilap_lang: 'en' });
        await page.goto(PAGE);
        await waitForContentScript(page);
        for (const appid of [a, b]) {
            await expect(flagOf(page, appid)).toHaveCount(1);
            // The flag stands on the cover, not on the gift link.
            await expect.poll(() => page.locator(`.ilap-ai-flagbox[data-ilap-appid="${appid}"]`).evaluate(el => !!el.closest('a.store_capsule'))).toBe(true);
        }
        // At Medium the cover is blurred and the row's small icons are not.
        await setExtensionStorage(context, { ilap_ai_level: 2 });
        await expect(page.locator('a.store_capsule .ilap-ai-blur')).toHaveCount(2);
        await expect(page.locator('.icons .ilap-ai-blur')).toHaveCount(0);
        await expect(page.locator('.ilap-ai-flagbox')).toHaveCount(2);
    });

    test('under Steam\'s own flag when the capsule has one, and Steam re-flagging the capsule leaves ours', async ({ page, context }) => {
        const appid = PLAIN_AI[2];
        await serve(context, row(appid, { owned: true }));
        await setExtensionStorage(context, { ilap_ai_level: 1, ilap_lang: 'en' });
        await page.goto(PAGE);
        await waitForContentScript(page);

        const cap = page.locator(`a[data-ds-appid="${appid}"]`);
        await cap.hover();   // Steam's collapsed flags open on hover, ours with them
        await page.waitForTimeout(600);
        const steam = await rectOf(cap.locator(':scope > .ds_flag.ds_owned_flag'));
        const ours = await rectOf(flagOf(page, appid));
        expect(ours.top).toBeGreaterThanOrEqual(steam.bottom);
        expect(ours.left).toBe(steam.left);

        // What dynamicstore.js does on every re-flag: drop the capsule's .ds_flag
        // children and append new ones. Ours rides its own layer and stays.
        await cap.evaluate((el) => {
            el.classList.remove('ds_flagged', 'ds_owned');
            Array.from(el.children).filter(c => c.matches('.ds_flag')).forEach(c => c.remove());
            el.classList.add('ds_flagged', 'ds_wishlist');
            el.insertAdjacentHTML('beforeend', '<div class="ds_flag ds_owned_flag">ON WISHLIST&nbsp;&nbsp;</div>');
        });
        await expect(flagOf(page, appid)).toHaveCount(1);
        await expect(cap.locator(':scope > .ds_flag')).toHaveCount(1);   // Steam's own, ours is not its child
        await page.waitForTimeout(400);   // a scan after the mutation
        await expect(page.locator('.ilap-ai-flagbox')).toHaveCount(1);
    });

    test('the flag takes no pointer: hover and click land on Steam\'s capsule under it', async ({ page, context }) => {
        const appid = PLAIN_AI[3];
        await serve(context, row(appid));
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        await page.addInitScript(() => {
            window.__hits = [];
            document.addEventListener('mouseover', (e) => window.__hits.push(['over', e.target.className]), true);
            document.addEventListener('click', (e) => {
                const a = e.target.closest('a');
                window.__hits.push(['click', a ? a.getAttribute('href') : null]);
                e.preventDefault();
            }, true);
        });
        await page.goto(PAGE);
        await waitForContentScript(page);

        const f = await rectOf(flagOf(page, appid));
        const x = f.left + f.width / 2;
        const y = f.top + f.height / 2;
        const under = await page.evaluate(([x, y]) => {
            const el = document.elementFromPoint(x, y);
            return { inFlag: !!el.closest('.ilap-ai-flagbox'), inRow: !!el.closest('.search_result_row') };
        }, [x, y]);
        expect(under).toEqual({ inFlag: false, inRow: true });
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.up();
        const hits = await page.evaluate(() => window.__hits);
        expect(hits.some(([kind, cls]) => kind === 'over' && /ilap/.test(String(cls)))).toBe(false);
        expect(hits.filter(([kind]) => kind === 'click')).toEqual([['click', `https://store.steampowered.com/app/${appid}/Game_${appid}/`]]);
        expect(await page.locator(`a[data-ds-appid="${appid}"]`).evaluate(el => el.matches(':hover'))).toBe(true);
    });

    test('it folds and hides as Steam\'s flags do: its icon only on a small flagged capsule, gone while a trailer plays', async ({ page, context }) => {
        const small = PLAIN_AI[4];
        const trailer = PLAIN_AI[5];
        await serve(context, homeCap(small) + row(trailer));
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        await page.goto(PAGE);
        await waitForContentScript(page);

        // Steam folds a flag to its 18px icon on a flagged capsule up to 250px
        // wide, its own and ours alike.
        await expect(flagOf(page, small)).toHaveCount(1);
        const folded = await rectOf(flagOf(page, small));
        const theirs = await rectOf(page.locator(`a[data-ds-appid="${small}"] > .ds_flag.ds_owned_flag`));
        expect(Math.round(folded.width)).toBe(Math.round(theirs.width));
        expect(Math.round(folded.width)).toBeLessThanOrEqual(19);

        // A hover trailer: Steam hides its flags (.hover_active), ours goes with them.
        const cap = page.locator(`a[data-ds-appid="${trailer}"]`);
        await expect.poll(() => flagOf(page, trailer).evaluate(el => getComputedStyle(el).opacity)).toBe('1');
        await cap.evaluate(el => el.classList.add('hover_active'));
        await expect.poll(() => flagOf(page, trailer).evaluate(el => getComputedStyle(el).opacity)).toBe('0');
    });

    test('it takes the level\'s colour and grows with the capsule', async ({ page, context }) => {
        const inRow = PLAIN_AI[8];
        const inCap = PLAIN_AI[9];
        // A capsule as big as the small ones under a tag page's Popular Titles.
        const tagCap = `<a class="store_capsule" data-ds-appid="${inCap}" href="https://store.steampowered.com/app/${inCap}/" `
            + 'style="display:block;position:relative;width:376px;height:176px">'
            + `<img src="https://ilaptest.invalid/cap/${inCap}.png" width="376" height="176" alt=""></a>`;
        await serve(context, row(inRow) + tagCap);
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        await page.goto(PAGE);
        await waitForContentScript(page);

        // 14% of the capsule's height, never under Steam's 18px.
        await expect(flagOf(page, inCap)).toHaveCount(1);
        expect(Math.round((await rectOf(flagOf(page, inRow))).height)).toBe(18);
        expect(Math.round((await rectOf(flagOf(page, inCap))).height)).toBe(Math.round(176 * 0.14));

        // The slider's colours: Low blue, Medium yellow. High, which would queue
        // the games, is read off the page's level mark alone.
        const look = () => flagOf(page, inCap).evaluate(el => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
        await expect.poll(look).toEqual(['rgb(26, 159, 255)', 'rgb(17, 17, 17)']);
        await setExtensionStorage(context, { ilap_ai_level: 2 });
        await expect.poll(look).toEqual(['rgb(255, 210, 26)', 'rgb(17, 17, 17)']);
        await page.evaluate(() => { document.documentElement.dataset.ilapAiLevel = '3'; });
        await expect.poll(look).toEqual(['rgb(227, 38, 31)', 'rgb(255, 255, 255)']);
    });

    test('with reduced motion the flag comes with no animation', async ({ page, context }) => {
        const appid = PLAIN_AI[6];
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await serve(context, row(appid));
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        await page.goto(PAGE);
        await waitForContentScript(page);
        await expect(flagOf(page, appid)).toHaveCount(1);
        expect(await flagOf(page, appid).evaluate(el => el.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
    });

    test('Off and the master switch take the flags off; at Medium the flag stays sharp over the blurred cover', async ({ page, context }) => {
        const appid = PLAIN_AI[7];
        const calls = await interceptIgnoreApi(context);
        await serve(context, row(appid));
        await setExtensionStorage(context, { ilap_ai_level: 2 });
        await page.goto(PAGE);
        await waitForContentScript(page);

        await expect(flagOf(page, appid)).toHaveCount(1);
        await expect(page.locator(`a[data-ds-appid="${appid}"] .ilap-ai-blur, a[data-ds-appid="${appid}"] .ilap-blur-backdrop`)).not.toHaveCount(0);
        // The flag's layer is over the blur: nothing of the blur stacks above it.
        expect(await page.locator(`.ilap-ai-flagbox[data-ilap-appid="${appid}"]`).evaluate(el => getComputedStyle(el).zIndex)).toBe('51');
        expect(await flagOf(page, appid).evaluate(el => getComputedStyle(el).filter)).toBe('none');

        await setExtensionStorage(context, { ilap_ai_level: 0 });
        await expect(page.locator('.ilap-ai-flagbox')).toHaveCount(0, { timeout: 3000 });
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        await expect(flagOf(page, appid)).toHaveCount(1, { timeout: 3000 });
        await setExtensionStorage(context, { ilap_master_enabled: false });
        await expect(page.locator('.ilap-ai-flagbox')).toHaveCount(0, { timeout: 3000 });
        expect(calls).toEqual([]);   // Low and Medium send nothing
    });
});

// The real store: Steam's own hover card and its search box over flagged
// capsules. LOW only, nothing queued.
test.describe('Manual Ignore — the AI flag on the live store', () => {
    test.setTimeout(90000);

    test('Steam\'s hover card opens over a flagged search row, also from the flag itself, and covers the flag', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        await page.goto('https://store.steampowered.com/search/?sort_by=Released_DESC&category1=998');
        await waitForContentScript(page);
        const flags = page.locator('.search_result_row .ilap-ai-flag');
        await expect(flags.first()).toBeVisible({ timeout: 20000 });

        const flag = flags.first();
        await flag.scrollIntoViewIfNeeded();
        const f = await rectOf(flag);
        await page.mouse.move(f.left + f.width / 2, f.top + f.height / 2);
        const hover = page.locator('#global_hover');
        await expect(hover).toBeVisible({ timeout: 10000 });
        // Nothing of ours inside Steam's card, and the card is on top where it shows.
        await expect(hover.locator('.ilap-ai-flag, .ilap-ai-flagbox')).toHaveCount(0);
        const covered = await hover.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 40));
            return !!hit && el.contains(hit);
        });
        expect(covered).toBe(true);
        expect(calls).toEqual([]);
    });

    test('a flagged game in the store search box\'s suggestions keeps its flag inside its row and the box answers the pointer', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        await page.goto('https://store.steampowered.com/search/');
        await waitForContentScript(page);
        // An AI game of the lists with a name made to be found.
        const appid = '3384720';
        expect(ALL.has(Number(appid))).toBe(true);
        // The header's search box is Steam's React one: hashed classes, the
        // suggestions in [id^=searchSuggestions], no data-ds-appid on a row.
        const box = page.locator('input[name="term"]').first();
        await box.click();
        await box.pressSequentially('Disguise Royale', { delay: 40 });
        const match = page.locator(`[id^="searchSuggestions"] a[href*="/app/${appid}/"]`);
        await expect(match).toBeVisible({ timeout: 15000 });
        const flag = match.locator('.ilap-ai-flag');
        await expect(flag).toBeVisible({ timeout: 10000 });
        const m = await rectOf(match);
        const f = await rectOf(flag);
        expect(f.left).toBeGreaterThanOrEqual(m.left - 1);
        expect(f.right).toBeLessThanOrEqual(m.right + 1);
        expect(f.bottom).toBeLessThanOrEqual(m.bottom + 1);
        // The pointer on the flag reaches the suggestion under it.
        const hit = await page.evaluate(([x, y]) => {
            const el = document.elementFromPoint(x, y);
            return !!el && !el.closest('.ilap-ai-flagbox') && !!el.closest('a[href*="/app/"]');
        }, [f.left + f.width / 2, f.top + f.height / 2]);
        expect(hit).toBe(true);
    });
});
