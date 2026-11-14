// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const { test, expect } = require('../_fixtures.js');
const { waitForContentScript } = require('./_helpers');
const { interceptIgnoreApi } = require('../_steam-routes.js');
const { setExtensionStorage, getExtensionStorage, clearExtensionStorage } = require('../_extension.js');

// The AI note on an AI game's own store page (src/manual-ignore/ai-page.js):
// the flag, the developers' own words and a way down to Steam's AI Generated
// Content Disclosure, among the facts at the top of the right column, its
// tooltip, its fold to the header image and the lines it quotes. The game
// pages are ours, served at /app/<id>/ on the store's origin, with Steam's
// markup for the right column and the two blocks that share one id (the Mature
// Content Description and the AI disclosure). The last test opens a real game
// page. LOW only: nothing is queued or sent.

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'presets.json'), 'utf8'));
const ALL = new Set(Object.values(DATA.ai).flat().map(Number));
const TRANSLATION = DATA.aikeep.translation.map(Number);
const INGAME = DATA.aikeep.ingame.map(Number);
const KEPT = new Set(TRANSLATION.concat(INGAME));
const MANUAL = (DATA.aimanual || []).map(Number);
const REMOVED = (DATA.airemoved || []).map(Number);
const PLAIN_AI = [...ALL].filter(a => !KEPT.has(a) && !MANUAL.includes(a) && !REMOVED.includes(a)).map(String);
const TR = TRANSLATION.filter(a => ALL.has(a) && !INGAME.includes(a) && !REMOVED.includes(a)).map(String);
const BY_HAND = MANUAL.filter(a => ALL.has(a)).map(String);
const OFF = REMOVED.filter(a => ALL.has(a) && !KEPT.has(a)).map(String);
// A game newer than every list, and Portal 2, with no AI at all.
const NEW = '99999990';
const PLAIN = '620';
if (ALL.has(Number(NEW)) || ALL.has(Number(PLAIN))) throw new Error('pick games outside the AI lists');

const AI_TEXT = 'Store page art and some in-game illustrations were generated with AI tools and edited by our artist.';

// A game page: the right column's facts and tags at the top, and far below,
// the content descriptor blocks Steam gives (`mature`, `ai` text or null).
// `sized` gives the right column Steam's current sizing: as tall as the
// media beside it (550 px) or its content, whichever is more, with what its
// blocks leave over spread around the facts and the tags, which sit in
// .glance_mid_ctn (the note then goes at the column's end). `desc` is the
// game's description.
function gamePage(appid, { ai = AI_TEXT, mature = true, sized = false, desc = 'A game about cardboard kingdoms.' } = {}) {
    const block = (heading, text) => '<div id="game_area_content_descriptors" class="game_area_content_descriptors">'
        + `<h2>${heading}</h2><p>The developers describe this content like this:</p><p><i>${text}</i></p></div>`;
    const facts = '<div class="glance_ctn_responsive_left"><div class="release_date"><div class="date">2 Nov, 2026</div></div></div>'
        + '<div class="glance_ctn_responsive_right"><div class="glance_tags popular_tags"><a class="app_tag">Strategy</a></div></div>';
    const head = '<div class="game_header_image_ctn"><img class="game_header_image_full" width="324" height="151" alt=""></div>'
        + `<div class="game_description_snippet">${desc}</div>`;
    const steamCss = '#game_highlights{display:flex;gap:16px}.leftcol{width:600px;height:550px;flex:none}.rightcol{float:none}'
        + '.glance_ctn{display:flex;flex-direction:column;min-height:100%}'
        + '.game_header_ctn{display:flex;flex-direction:column;gap:12px}.game_header_image_full{display:block}'
        + '.game_description_snippet{font-size:14px;line-height:19px}'
        + '.glance_mid_ctn{flex:1 0 auto;display:flex;flex-direction:column;justify-content:space-around}'
        + '.glance_ctn_responsive_left{height:94px}.glance_ctn_responsive_right{height:51px}';
    return '<!doctype html><html><head><title>Game</title><style>body{background:#1b2838;color:#c6d4df;font:12px Arial}'
        + '.rightcol{width:324px;float:right}.spacer{height:1800px}' + (sized ? steamCss : '') + '</style></head><body>'
        + '<div id="global_actions"><a class="user_avatar" href="#">me</a></div>'
        + `<div class="page_content_ctn"><div id="appHubAppName" class="apphub_AppName">Game ${appid}</div>`
        + '<div id="game_highlights">' + (sized ? '<div class="leftcol"></div>' : '') + '<div class="rightcol"><div class="glance_ctn">'
        + (sized ? `<div class="game_header_ctn">${head}</div><div class="glance_mid_ctn">${facts}</div>` : head + facts)
        + '</div></div></div><div class="spacer"></div>'
        + (mature ? block('Mature Content Description', 'Some violence.') : '')
        + (ai !== null ? block('AI Generated Content Disclosure', ai) : '')
        + '<div class="spacer"></div></div></body></html>';
}

const url = (appid) => `https://store.steampowered.com/app/${appid}/`;
async function serve(context, appid, opts) {
    await context.route(url(appid), (r) => r.fulfill({ status: 200, contentType: 'text/html', body: gamePage(appid, opts) }));
}
const note = (page) => page.locator('.ilap-ai-note');
const mini = (page) => page.locator('.game_header_image_ctn .ilap-ai-mini');
// The air between the game's description and the facts under it, and the
// lines of the developers' words the note quotes.
const fitOf = (page) => page.evaluate(() => {
    const air = () => Math.round(document.querySelector('.glance_ctn_responsive_left').getBoundingClientRect().top
        - document.querySelector('.game_description_snippet').getBoundingClientRect().bottom);
    const el = document.querySelector('.ilap-ai-note');
    const words = el.querySelector('.ilap-ai-note-text');
    const withNote = air();
    el.style.position = 'absolute';
    const own = air();
    el.style.position = '';
    return { air: withNote, own, lines: el.style.getPropertyValue('--ilap-note-lines'), quoted: !!words && words.offsetHeight > 0 };
});

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — the AI note on a game page', () => {

    test('a listed AI game shows the flag, the developers\' words and a way down to Steam\'s block, before the tags', async ({ page, context }) => {
        const appid = PLAIN_AI[0];
        const calls = await interceptIgnoreApi(context);
        await serve(context, appid);
        await setExtensionStorage(context, { ilap_ai_level: 1, ilap_lang: 'en' });
        await page.goto(url(appid));
        await waitForContentScript(page);

        await expect(note(page)).toHaveCount(1);
        await expect(note(page).locator('.ilap-ai-flag')).toHaveText('AI');
        await expect(note(page).locator('q.ilap-ai-note-text')).toHaveText(AI_TEXT);
        await expect(note(page).locator('.ilap-ai-note-more')).toHaveText('AI Generated Content Disclosure ↓');
        // In the right column, before the tags, so it is on the first screen.
        expect(await note(page).evaluate(el => el.nextElementSibling && el.nextElementSibling.className)).toBe('glance_ctn_responsive_right');
        const top = await note(page).evaluate(el => el.getBoundingClientRect().top);
        expect(top).toBeLessThan(page.viewportSize().height);

        // The button goes to the AI block, not to the Mature one of the same id.
        await note(page).locator('.ilap-ai-note-more').click();
        await expect.poll(() => page.evaluate(() => {
            const ai = Array.from(document.querySelectorAll('[id="game_area_content_descriptors"]'))
                .find(b => b.querySelector('h2').textContent.includes('AI'));
            return Math.round(ai.getBoundingClientRect().top);
        }), { timeout: 5000 }).toBeLessThan(40);
        expect(calls).toEqual([]);
    });

    test('the flag names the AI use the lists know, and a listed game with no disclosure gets the flag alone', async ({ page, context }) => {
        const [tr] = TR;
        await serve(context, tr, { ai: 'The game was translated into Japanese with DeepL.' });
        await setExtensionStorage(context, { ilap_ai_level: 1, ilap_lang: 'en' });
        await page.goto(url(tr));
        await waitForContentScript(page);
        await expect(note(page).locator('.ilap-ai-flag')).toHaveAttribute('data-kind', 'translation');

        const bare = PLAIN_AI[1];
        await serve(context, bare, { ai: null });
        await page.goto(url(bare));
        await waitForContentScript(page);
        await expect(note(page).locator('.ilap-ai-flag')).toHaveText('AI');
        await expect(note(page).locator('q, .ilap-ai-note-more')).toHaveCount(0);
    });

    test('a game the lists mark by hand gets the plain AI flag and a line of our own saying so, in the panel\'s language', async ({ page, context }) => {
        const appid = BY_HAND[0];
        await serve(context, appid, { ai: null });
        await setExtensionStorage(context, { ilap_ai_level: 1, ilap_lang: 'en' });
        await page.goto(url(appid));
        await waitForContentScript(page);

        await expect(note(page).locator('.ilap-ai-flag')).toHaveText('AI');
        const own = note(page).locator('.ilap-ai-note-own');
        await expect(own).toHaveText('Steam Ignore Like a Pro marked this game as AI by hand. Its page has no AI Generated Content Disclosure.');
        await expect(own).toHaveCSS('font-style', 'normal');
        // No quote and no way down: the page has no block to go to.
        await expect(note(page).locator('q, .ilap-ai-note-more')).toHaveCount(0);

        await setExtensionStorage(context, { ilap_lang: 'ru' });
        await expect(own).toHaveText(/^Расширение Steam Ignore Like a Pro отметило эту игру как ИИ вручную\./);
        await expect(note(page).locator('.ilap-ai-flag')).toHaveText('AI');
    });

    test('a game whose developer removed its disclosure gets the plain AI flag, and its tooltip says so, folded too, in the panel\'s language', async ({ page, context }) => {
        const appid = OFF[0];
        await serve(context, appid, { ai: null });
        await setExtensionStorage(context, { ilap_ai_level: 1, ilap_lang: 'en' });
        await page.goto(url(appid));
        await waitForContentScript(page);

        const flag = note(page).locator('.ilap-ai-flag');
        await expect(flag).toHaveText('AI');
        await expect(flag).toHaveAttribute('data-ilap-tip', /^This game had an AI Generated Content Disclosure, but its developer removed it\. Added by /);
        await expect(note(page).locator('q, .ilap-ai-note-own, .ilap-ai-note-more')).toHaveCount(0);

        await flag.hover();
        const tip = page.locator('.ilap-tooltip-floating.show');
        await expect(tip).toHaveText('This game had an AI Generated Content Disclosure, but its developer removed it. Added by Steam Ignore Like a Pro at your AI filter level. You can change the level on its AI tab.');
        await expect(tip.locator('img')).toHaveCount(1);
        await page.mouse.move(0, 0);

        await setExtensionStorage(context, { ilap_lang: 'ru' });
        await expect(flag).toHaveAttribute('data-ilap-tip', /^У этой игры был раздел «Информация об ИИ-контенте», но разработчик его удалил\. /);

        await note(page).locator('.ilap-ai-fold').click();
        await expect(mini(page).locator('.ilap-ai-flag')).toHaveAttribute('data-ilap-tip', /но разработчик его удалил\. /);
    });

    test('a removed game whose page shows a disclosure again is an ordinary AI game', async ({ page, context }) => {
        const appid = OFF[1];
        await serve(context, appid);
        await setExtensionStorage(context, { ilap_ai_level: 1, ilap_lang: 'en' });
        await page.goto(url(appid));
        await waitForContentScript(page);

        const flag = note(page).locator('.ilap-ai-flag');
        await expect(flag).toHaveAttribute('data-kind', 'ai');
        await expect(flag).toHaveAttribute('data-ilap-tip', /^Added by /);
        await expect(note(page).locator('q.ilap-ai-note-text')).toHaveText(AI_TEXT);
    });

    test('the flag says who drew it and where its level is set, and the buttons name themselves', async ({ page, context }) => {
        const appid = PLAIN_AI[4];
        await serve(context, appid);
        await setExtensionStorage(context, { ilap_ai_level: 1, ilap_lang: 'en' });
        await page.goto(url(appid));
        await waitForContentScript(page);
        await expect(note(page)).toHaveCount(1);
        await expect(note(page).locator('.ilap-ai-fold')).toHaveAttribute('aria-label', 'Collapse');
        await expect(note(page).locator('.ilap-ai-fold')).toHaveAttribute('aria-expanded', 'true');

        const tip = page.locator('.ilap-tooltip-floating.show');
        await note(page).locator('.ilap-ai-flag').hover();
        await expect(tip).toHaveText('Added by Steam Ignore Like a Pro at your AI filter level. You can change the level on its AI tab.');
        await expect(tip.locator('img')).toHaveCount(1);
        await expect(tip).toHaveCSS('opacity', '1');
        // Over the flag, its arrow at the flag's left.
        const [t, f] = await Promise.all([tip.boundingBox(), note(page).locator('.ilap-ai-flag').boundingBox()]);
        expect(t.y + t.height).toBeLessThanOrEqual(f.y);
        expect(Math.abs(t.x - f.x)).toBeLessThan(2);

        await note(page).locator('.ilap-ai-fold').hover();
        await expect(tip).toHaveText('Collapse');
        await page.mouse.move(5, 5);
        await expect(page.locator('.ilap-tooltip-floating.show')).toHaveCount(0);

        // The panel's language.
        await setExtensionStorage(context, { ilap_lang: 'ru' });
        await expect(note(page).locator('.ilap-ai-fold')).toHaveAttribute('aria-label', 'Свернуть');
        await note(page).locator('.ilap-ai-flag').hover();
        await expect(tip).toContainText('Добавлено расширением Steam Ignore Like a Pro');
    });

    test('the fold button takes the note to the header image on every game page, and the one there brings it back', async ({ page, context }) => {
        const [a, b] = [PLAIN_AI[5], PLAIN_AI[6]];
        const calls = await interceptIgnoreApi(context);
        await serve(context, a);
        await serve(context, b);
        await setExtensionStorage(context, { ilap_ai_level: 1, ilap_lang: 'en' });
        await page.goto(url(a));
        await waitForContentScript(page);
        await expect(note(page)).toHaveCount(1);
        await expect(mini(page)).toHaveCount(0);

        await note(page).locator('.ilap-ai-fold').click();
        await expect(note(page)).toHaveCount(0, { timeout: 3000 });
        await expect(mini(page).locator('.ilap-ai-flag')).toHaveText('AI');
        await expect(mini(page).locator('.ilap-ai-fold')).toHaveAttribute('aria-expanded', 'false');
        await expect(mini(page).locator('.ilap-ai-fold')).toHaveAttribute('aria-label', 'Expand');
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_ai_note_collapsed')).ilap_ai_note_collapsed).toBe(true);
        // In the header image's top left corner, where Steam puts a capsule's flags, as tall as the flag and its button.
        const [m, img, flag, btn] = await Promise.all([mini(page).boundingBox(),
            page.locator('.game_header_image_ctn').boundingBox(), mini(page).locator('.ilap-ai-flag').boundingBox(),
            mini(page).locator('.ilap-ai-fold').boundingBox()]);
        expect(Math.round(m.x)).toBe(Math.round(img.x));
        expect(Math.round(m.y - img.y)).toBe(14);
        expect(Math.round(btn.height)).toBe(Math.round(flag.height));
        expect(Math.round(btn.x)).toBe(Math.round(flag.x + flag.width));

        // Folded for the next game page too.
        await page.goto(url(b));
        await waitForContentScript(page);
        await expect(mini(page)).toHaveCount(1);
        await page.waitForTimeout(300);
        await expect(note(page)).toHaveCount(0);

        await mini(page).locator('.ilap-ai-fold').click();
        await expect(note(page)).toHaveCount(1);
        await expect(mini(page)).toHaveCount(0);
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_ai_note_collapsed')).ilap_ai_note_collapsed).toBe(false);

        // The master switch takes the folded flag away too.
        await note(page).locator('.ilap-ai-fold').click();
        await expect(mini(page)).toHaveCount(1);
        await setExtensionStorage(context, { ilap_master_enabled: false });
        await expect(mini(page)).toHaveCount(0);
        await expect(note(page)).toHaveCount(0);
        expect(calls).toEqual([]);
    });

    test('the folded flag stays through a change of level or box, which clears the capsules\' flags', async ({ page, context }) => {
        const appid = PLAIN_AI[11];
        await serve(context, appid);
        await setExtensionStorage(context, { ilap_ai_level: 1, ilap_lang: 'en', ilap_ai_note_collapsed: true });
        await page.goto(url(appid));
        await waitForContentScript(page);
        await expect(mini(page)).toHaveCount(1);
        // Each change marks the capsules' flags for a sweep a moment later,
        // which a flag of the note must not fall to.
        for (const change of [{ ilap_ai_level: 2 }, { ilap_ai_keep_translation: true }, { ilap_ai_level: 1 }]) {
            await setExtensionStorage(context, change);
            await page.waitForTimeout(800);
            await expect(mini(page)).toHaveCount(1);
            await expect(mini(page).locator('.ilap-ai-flag')).toHaveText('AI');
            await expect(mini(page).locator('.ilap-ai-fold')).toBeVisible();
        }
        await expect(note(page)).toHaveCount(0);
    });

    test('the note quotes fewer lines where Steam\'s column would lose the air under the description', async ({ page, context }) => {
        const words = 'The art of the cards, the board and the store page was made with generative AI tools. '
            + 'Every picture was then painted over by hand, and the music and the text were made by people.';
        const line = 'A strategy game about cardboard kingdoms and the paper wars between them, ';
        const games = [
            // One line of description: room for all four lines of the words.
            { appid: PLAIN_AI[7], desc: 'A game about cardboard kingdoms.', want: (f) => f.lines === '4' && f.quoted },
            // Three lines: some of them.
            { appid: PLAIN_AI[8], desc: line.repeat(2), want: (f) => f.lines > '0' && f.lines < '4' && f.quoted },
            // Six lines: none, the flag and the way down stay.
            { appid: PLAIN_AI[9], desc: line.repeat(4), want: (f) => f.lines === '0' && !f.quoted },
        ];
        await setExtensionStorage(context, { ilap_ai_level: 1, ilap_lang: 'en' });
        for (const g of games) {
            await serve(context, g.appid, { sized: true, desc: g.desc, ai: words });
            await page.goto(url(g.appid));
            await waitForContentScript(page);
            await expect(note(page)).toHaveCount(1);
            await page.waitForTimeout(400);
            const f = await fitOf(page);
            expect(g.want(f), JSON.stringify(f)).toBe(true);
            // The air kept is 16 px, or Steam's own when less. Only with none
            // of the words may there be less, and still some.
            if (f.lines !== '0') expect(f.air).toBeGreaterThanOrEqual(Math.min(16, f.own));
            else expect(f.air).toBeGreaterThan(0);
            await expect(note(page).locator('.ilap-ai-flag')).toBeVisible();
            await expect(note(page).locator('.ilap-ai-note-more')).toBeVisible();
        }

        // A narrower window wraps the description into more lines: the note
        // gives up words for the air, with no replay of the flag's fade.
        await page.goto(url(PLAIN_AI[7]));
        await waitForContentScript(page);
        await expect(note(page)).toHaveCount(1);
        await page.waitForTimeout(400);
        await page.addStyleTag({ content: '.rightcol{width:200px}' });
        await page.setViewportSize({ width: 1100, height: 720 });
        await page.waitForTimeout(300);
        const f = await fitOf(page);
        expect(f.lines < '4', JSON.stringify(f)).toBe(true);
        expect(await note(page).evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length)).toBe(0);
    });

    test('a game newer than the lists shows by its disclosure; a game with none shows nothing', async ({ page, context }) => {
        await serve(context, NEW, { ai: 'Characters talk with you through an LLM in real time.' });
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        await page.goto(url(NEW));
        await waitForContentScript(page);
        await expect(note(page).locator('.ilap-ai-flag')).toHaveAttribute('data-kind', 'ingame');

        await serve(context, PLAIN, { ai: null });
        await page.goto(url(PLAIN));
        await waitForContentScript(page);
        await page.waitForTimeout(500);
        await expect(note(page)).toHaveCount(0);
    });

    test('the level and the master switch bring it and take it away, its height moving each time', async ({ page, context }) => {
        const appid = PLAIN_AI[2];
        await serve(context, appid);
        await setExtensionStorage(context, { ilap_ai_level: 0 });
        await page.goto(url(appid));
        await waitForContentScript(page);
        await expect(note(page)).toHaveCount(0);

        // Sampled every frame: it grows from nothing, never jumps to its height.
        const heights = page.evaluate(() => new Promise((resolve) => {
            const out = [];
            const t0 = performance.now();
            const tick = () => {
                const el = document.querySelector('.ilap-ai-note');
                out.push(el ? el.getBoundingClientRect().height : -1);
                if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else resolve(out);
            };
            requestAnimationFrame(tick);
        }));
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        const seen = (await heights).filter(h => h >= 0);
        expect(seen.length).toBeGreaterThan(2);
        const full = seen[seen.length - 1];
        expect(seen.some(h => h > 0 && h < full)).toBe(true);

        await setExtensionStorage(context, { ilap_ai_level: 0 });
        await expect(note(page)).toHaveCount(0, { timeout: 3000 });
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        await expect(note(page)).toHaveCount(1, { timeout: 3000 });
        await setExtensionStorage(context, { ilap_master_enabled: false });
        await expect(note(page)).toHaveCount(0, { timeout: 3000 });
    });

    test('a ticked box keeps the note away for a game it keeps, as it keeps the capsules unflagged', async ({ page, context }) => {
        const [tr] = TR;
        await serve(context, tr);
        await setExtensionStorage(context, { ilap_ai_level: 2, ilap_ai_keep_translation: true });
        await page.goto(url(tr));
        await waitForContentScript(page);
        await page.waitForTimeout(500);
        await expect(note(page)).toHaveCount(0);
    });

    test('with reduced motion it comes and goes with no animation', async ({ page, context }) => {
        const appid = PLAIN_AI[3];
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await serve(context, appid);
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        await page.goto(url(appid));
        await waitForContentScript(page);
        await expect(note(page)).toHaveCount(1);
        expect(await note(page).evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length)).toBe(0);
    });

    test('on a real AI game page the note shows Steam\'s own disclosure near the top', async ({ page, context }) => {
        test.setTimeout(90000);
        const appid = '3384720';
        expect(ALL.has(Number(appid))).toBe(true);
        await setExtensionStorage(context, { ilap_ai_level: 1, ilap_lang: 'en' });
        await page.goto(`${url(appid)}?l=english`);
        await waitForContentScript(page);
        await expect(note(page)).toHaveCount(1, { timeout: 15000 });
        await expect(note(page).locator('.ilap-ai-flag')).toBeVisible();
        const steamText = await page.evaluate(() => {
            const b = Array.from(document.querySelectorAll('[id="game_area_content_descriptors"]'))
                .find(x => /AI Generated Content/.test((x.querySelector('h2') || {}).textContent || ''));
            const i = b && b.querySelector('i');
            return i ? i.textContent.trim() : '';
        });
        if (steamText) await expect(note(page).locator('q')).toHaveText(steamText);
        expect(await note(page).evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(page.viewportSize().height);
        // Steam's column keeps air under the description, as on the fixtures.
        const f = await fitOf(page);
        if (f.lines !== '0') expect(f.air, JSON.stringify(f)).toBeGreaterThanOrEqual(Math.min(16, f.own));
    });
});
