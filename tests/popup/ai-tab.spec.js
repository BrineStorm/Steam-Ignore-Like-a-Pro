const fs = require('fs');
const path = require('path');
const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');
const { colours, gap, rgb } = require('../_pixels.js');

// The AI tab (ui/popup_ai.js): the level slider with its tick
// and HIGH's shot droplist, and the two boxes that keep AI games of a kind out
// of the AI lists (data/presets.json → aikeep). Driven through the popup window only. The
// test build's service worker is empty, so a staged list is never drained. What
// a level does on a store page is manual-ignore/ai-browse.spec.js's.

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'presets.json'), 'utf8'));
const KEEP = DATA.aikeep || { translation: [], ingame: [] };
// The AI year with the most games kept for translation, so the count moves.
const BUCKET = Object.keys(DATA.ai).map(b => ({ b, n: DATA.ai[b].filter(a => KEEP.translation.includes(a)).length }))
    .sort((x, y) => y.n - x.n)[0];
const KEY = BUCKET && 'ai_' + BUCKET.b;

async function openPopup(page, context) {
    const extId = await getExtensionId(context);
    await page.goto(popupUrl(extId));
    await page.locator('#popup-root').waitFor({ timeout: 5000 });
}

async function openAiTab(page) {
    await page.locator('#tab-ai').click();
    const pane = page.locator('#ai-tab-pane');
    await expect(pane).toBeVisible();
    // The popup above may still settle and push the pane down, which leaves
    // a hover over the wrong line: wait until the pane stands still.
    await expect.poll(async () => {
        const a = await pane.boundingBox();
        await page.waitForTimeout(150);
        const b = await pane.boundingBox();
        return a.y === b.y && a.height === b.height;
    }).toBe(true);
}

async function openDrawerOn(page, bucket) {
    await page.locator('#lists-btn').click();
    await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
    await expect(page.locator('#lists-drawer')).not.toHaveClass(/sliding/);
    if (await page.locator('#ai-pane .list-row').getAttribute('data-key') !== 'ai_' + bucket) {
        await page.locator('#ai-pane .ai-year').click();
        await expect(page.locator('.ai-years')).toHaveClass(/open/);
        await page.locator(`.ai-opt[data-bucket="${bucket}"]`).click();
        await expect(page.locator('#ai-pane .list-row')).toHaveAttribute('data-key', 'ai_' + bucket);
    }
}

const count = (page) => page.locator('#ai-pane .list-count').innerText().then(s => Number(s.replace(/\D/g, '')));

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Popup — AI tab', () => {
    test.skip(!BUCKET || BUCKET.n === 0, 'needs an AI year with games kept for translation in data/presets.json');

    test('the level starts at Low with the crossed-out AI and its animation on, the two boxes start clear', async ({ page, context }) => {
        await openPopup(page, context);
        await openAiTab(page);
        const pane = page.locator('#ai-tab-pane');
        await expect(pane.locator('.list-title')).toHaveText('AI-generated content');
        const slider = pane.locator('#ai-level');
        await expect(slider).toHaveValue('1');
        await expect(slider).toHaveAccessibleName('AI filter level');
        await expect(slider).toHaveAttribute('aria-valuetext', 'Low');
        await expect(pane.locator('.ai-level-tick')).toHaveText(['Off', 'Low', 'Medium', 'High', 'Max']);
        await expect(pane.locator('.ai-level-hint.shown')).toHaveText('AI games get an AI mark on store pages.');
        await expect(pane.locator('#ai-level-ok')).not.toHaveClass(/shown/);
        await expect(pane.locator('.ai-shot-row')).toHaveClass(/ai-dim/);
        await expect(pane.locator('#ai-shot-name')).toHaveText('Crossed-out AI');
        await expect(pane.locator('input[name="ai-shot"][value="ai"]')).toBeChecked();
        await expect(pane.locator('input[name="ai-shot"][value="ai"]')).toBeDisabled();
        await expect(pane.locator('#ai-shot-anim')).toBeChecked();
        await expect(pane.locator('#ai-shot-anim')).toBeDisabled();
        await expect(pane.getByRole('radiogroup')).toHaveAccessibleName('Shot:');
        await expect(pane.locator('input[data-keep="translation"]')).not.toBeChecked();
        await expect(pane.locator('input[data-keep="ingame"]')).not.toBeChecked();
        await expect(pane.locator('.ai-check').nth(0)).toContainText('Keep games that use AI only for translation');
        await expect(pane.locator('.ai-check').nth(1)).toContainText('Keep games with AI inside the game');
        await expect(pane.locator('.ai-check').nth(1)).toContainText('Live AI during play, such as voiced dialogue.');
        await expect(pane.locator('.ai-keep')).not.toContainText('These apply');
    });

    test('each shot thumbnail names itself in a tooltip a second after the hover, the emoji says how to change it, the random one shows its name', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await openPopup(page, context);
        await openAiTab(page);
        const tips = page.locator('#ai-tab-pane .ai-opt-tip');
        await expect(tips).toHaveText(['Emoji (click to change emoji)', 'Red swipe', 'Crossed-out AI', 'Tomato']);
        const tip = page.locator('#ai-tab-pane .ai-shot-opt:has(input[value="tomato"]) .ai-opt-tip');
        await page.locator('#ai-tab-pane .ai-shot-pic[data-shot="tomato"]').hover();
        await expect(tip).toHaveCSS('transition-delay', /^1s/);
        await expect(tip).toHaveCSS('opacity', '1');
        // The row's first thumbnail keeps its tip inside it.
        const row = await page.locator('#ai-tab-pane .ai-shots').boundingBox();
        for (const v of ['emoji']) {
            await page.locator(`#ai-tab-pane .ai-shot-pic[data-shot="${v}"]`).hover();
            const b = await page.locator(`#ai-tab-pane .ai-shot-opt:has(input[value="${v}"]) .ai-opt-tip`).boundingBox();
            expect(b.x).toBeGreaterThanOrEqual(row.x - 0.5);
            expect(b.x + b.width).toBeLessThanOrEqual(row.x + row.width + 0.5);
        }
    });

    test('a level picked by its name glides there in 0.2 s, with no motion under reduced motion', async ({ page, context }) => {
        await openPopup(page, context);
        await openAiTab(page);
        const pane = page.locator('#ai-tab-pane');
        const slider = pane.locator('#ai-level');
        // The thumb's value and the track's fill, every frame from the click
        // on, until it has stood still for 0.3 s.
        const watch = async (level) => {
            await slider.evaluate((el) => {
                el.closest('#ai-tab-pane').addEventListener('click', () => { window.__clickAt = performance.now(); }, { once: true, capture: true });
                const out = window.__glide = [];
                const tick = () => {
                    out.push({ t: performance.now(), v: Number(el.value), fill: parseFloat(el.style.getPropertyValue('--fill')) });
                    const moved = out.findLastIndex((s, i) => i && s.v !== out[i - 1].v);
                    if (moved < 0 || performance.now() - out[moved].t < 300) requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            });
            await pane.locator(`.ai-level-tick[data-level="${level}"]`).click();
            await expect.poll(() => page.evaluate(() => {
                const s = window.__glide, m = s.findLastIndex((x, i) => i && x.v !== s[i - 1].v);
                return m > 0 && performance.now() - s[m].t >= 300;
            })).toBe(true);
            return page.evaluate(() => window.__glide.filter((s, i, a) => i === 0 || s.v !== a[i - 1].v)
                .map(s => Object.assign(s, { t: s.t - window.__clickAt })));
        };
        let seen = await watch(3);
        // A windowless run draws a frame every 80 ms or so, so the way may
        // show one value only.
        const way = seen.filter(s => s.v > 0 && s.v < 3);
        expect(way.length, JSON.stringify(seen.map(s => s.v))).toBeGreaterThan(0);
        for (const s of way) expect(Math.abs(s.fill - s.v * 25)).toBeLessThan(0.01);
        for (let i = 1; i < seen.length; i++) expect(seen[i].v).toBeGreaterThanOrEqual(seen[i - 1].v);
        // From the click to the thumb standing on the level.
        const end = seen.find(s => s.v === 3).t;
        expect(end).toBeGreaterThan(190);
        expect(end).toBeLessThan(450);
        await expect(slider).toHaveValue('3');
        await expect(slider).toHaveAttribute('step', '1');

        await page.emulateMedia({ reducedMotion: 'reduce' });
        seen = await watch(1);
        expect(seen.filter(s => s.v > 1 && s.v < 3)).toEqual([]);
        await expect(slider).toHaveValue('1');
    });

    test('a glide never steps back, even when its first frame began before the click', async ({ page, context }) => {
        // A frame's time is when the frame began, which can be earlier than the
        // click it follows. Shifted here so that every first frame is.
        await page.addInitScript(() => {
            const raf = window.requestAnimationFrame.bind(window);
            window.requestAnimationFrame = (cb) => raf((now) => cb(now - 100));
        });
        await openPopup(page, context);
        await openAiTab(page);
        const slider = page.locator('#ai-tab-pane #ai-level');
        await expect(slider).toHaveValue('1');
        await slider.evaluate((el) => {
            const seen = window.__seen = [];
            const tick = () => { seen.push(Number(el.value)); requestAnimationFrame(tick); };
            requestAnimationFrame(tick);
        });
        await page.locator('#ai-tab-pane .ai-level-tick[data-level="3"]').click();
        await expect(slider).toHaveValue('3');
        const seen = await page.evaluate(() => window.__seen);
        expect(Math.min(...seen), JSON.stringify(seen)).toBe(1);
    });

    test('a level is stored only by its tick, with the boxes it sets, and reads back on a new open', async ({ page, context }) => {
        await openPopup(page, context);
        await openAiTab(page);
        const pane = page.locator('#ai-tab-pane');
        const height = await pane.evaluate(el => el.getBoundingClientRect().height);
        // The slider stands in the pane's middle, with the save button out and in.
        const offCentre = () => pane.evaluate(el => {
            const p = el.getBoundingClientRect(), s = el.querySelector('#ai-level').getBoundingClientRect();
            return Math.abs((s.left + s.right) / 2 - (p.left + p.right) / 2);
        });
        expect(await offCentre()).toBeLessThanOrEqual(0.5);
        await pane.locator('.ai-level-tick[data-level="2"]').click();
        await expect(pane.locator('#ai-level')).toHaveValue('2');
        await expect(pane.locator('.ai-level-hint.shown')).toHaveText('AI games get an AI mark and a blurred cover.');
        // MEDIUM sets both boxes, shown at once, stored with the tick only.
        await expect(pane.locator('input[data-keep="translation"]')).toBeChecked();
        await expect(pane.locator('input[data-keep="ingame"]')).toBeChecked();
        await expect(pane.locator('#ai-level-ok')).toHaveClass(/shown/);
        expect(await offCentre()).toBeLessThanOrEqual(0.5);
        await page.waitForTimeout(300);
        expect(await getExtensionStorage(context, ['ilap_ai_level', 'ilap_ai_keep_translation'])).toEqual({});
        // Every hint shares one cell: the pane keeps its height.
        expect(await pane.evaluate(el => el.getBoundingClientRect().height)).toBe(height);
        await pane.locator('#ai-level-ok').click();
        // The button turns into a check mark, stays a moment, then goes and
        // is the save button again.
        await expect(pane.locator('#ai-level-ok')).toHaveClass(/\bsaved\b/);
        await expect.poll(() => getExtensionStorage(context, ['ilap_ai_level', 'ilap_ai_keep_translation', 'ilap_ai_keep_ingame']))
            .toEqual({ ilap_ai_level: 2, ilap_ai_keep_translation: true, ilap_ai_keep_ingame: true });
        await expect(pane.locator('#ai-level-ok')).toHaveClass(/\bshown\b/);
        await expect(pane.locator('#ai-level-ok')).not.toHaveClass(/shown/);
        await expect(pane.locator('#ai-level-ok')).not.toHaveClass(/\bsaved\b/);
        // LOW clears both boxes as it is applied, here from the keyboard.
        await pane.locator('#ai-level').focus();
        await page.keyboard.press('ArrowLeft');
        await expect(pane.locator('#ai-level')).toHaveValue('1');
        await expect(pane.locator('input[data-keep="translation"]')).not.toBeChecked();
        await pane.locator('#ai-level-ok').click();
        await expect.poll(() => getExtensionStorage(context, ['ilap_ai_level', 'ilap_ai_keep_translation', 'ilap_ai_keep_ingame']))
            .toEqual({ ilap_ai_level: 1, ilap_ai_keep_translation: false, ilap_ai_keep_ingame: false });
        await page.reload();
        await page.locator('#popup-root').waitFor();
        await expect(page.locator('#ai-tab-pane')).toBeVisible();
        await expect(page.locator('#ai-level')).toHaveValue('1');
        await expect(page.locator('.ai-level-hint.shown')).toHaveText('AI games get an AI mark on store pages.');
    });

    test('a box ticked on the stored level is stored at once and stays, a box moved with a level waits for its tick', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        await openPopup(page, context);
        await openAiTab(page);
        const pane = page.locator('#ai-tab-pane');
        await pane.locator('.ai-check:has(input[data-keep="ingame"])').click();
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_ai_keep_ingame')).ilap_ai_keep_ingame).toBe(true);
        await page.reload();
        await page.locator('#popup-root').waitFor();
        // The popup opens on the tab it was left on.
        await expect(pane).toBeVisible();
        await expect(pane.locator('#ai-level')).toHaveValue('1');
        await expect(pane.locator('input[data-keep="ingame"]')).toBeChecked();
        await pane.locator('.ai-level-tick[data-level="3"]').click();
        await pane.locator('.ai-check:has(input[data-keep="translation"])').click();
        await expect(pane.locator('input[data-keep="translation"]')).not.toBeChecked();
        await page.waitForTimeout(300);
        expect((await getExtensionStorage(context, 'ilap_ai_keep_translation')).ilap_ai_keep_translation).toBeUndefined();
        await pane.locator('#ai-level-ok').click();
        await expect.poll(() => getExtensionStorage(context, ['ilap_ai_level', 'ilap_ai_keep_translation', 'ilap_ai_keep_ingame']))
            .toEqual({ ilap_ai_level: 3, ilap_ai_keep_translation: false, ilap_ai_keep_ingame: true });
        await expect(pane.locator('.ai-shot-row')).not.toHaveClass(/ai-dim/);
    });

    test('a level left with no tick is dropped as the tab shuts', async ({ page, context }) => {
        await openPopup(page, context);
        await openAiTab(page);
        await page.locator('.ai-level-tick[data-level="3"]').click();
        await expect(page.locator('#ai-level-ok')).toHaveClass(/shown/);
        await page.locator('#tab-ai').click();
        await expect(page.locator('#ai-tab-pane')).toBeHidden();
        await openAiTab(page);
        await expect(page.locator('#ai-level')).toHaveValue('1');
        await expect(page.locator('#ai-level-ok')).not.toHaveClass(/shown/);
        await expect(page.locator('input[data-keep="translation"]')).not.toBeChecked();
        expect((await getExtensionStorage(context, 'ilap_ai_level')).ilap_ai_level).toBeUndefined();
    });

    test('Max says sorry, has no tick and stores nothing', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ai_level: 2, ilap_ai_keep_translation: true, ilap_ai_keep_ingame: true });
        await openPopup(page, context);
        await openAiTab(page);
        const pane = page.locator('#ai-tab-pane');
        const before = await pane.boundingBox();
        await pane.locator('.ai-level-tick[data-level="4"]').click();
        await expect(pane.locator('#ai-level')).toHaveValue('4');
        const note = pane.locator('.ai-level-hint.shown');
        await expect(note).toHaveText('Sorry, Max level is impossible because this extension was made with the help of AI, so it won\'t suit you 😔');
        await expect(pane.locator('#ai-level-ok')).not.toHaveClass(/shown/);
        await expect(pane).toHaveClass(/ai-max/);
        // The shot and the boxes go, and the message takes their room in large
        // type: from the hints' top to the pane's bottom, the pane's height kept.
        await expect(pane.locator('.ai-shot-row')).toBeHidden();
        await expect(pane.locator('.ai-keep')).toBeHidden();
        expect(parseFloat(await note.evaluate(el => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(22);
        const after = await pane.boundingBox();
        expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
        const box = await note.boundingBox();
        const hints = await pane.locator('.ai-level-hints').boundingBox();
        expect(Math.abs(box.y - hints.y)).toBeLessThanOrEqual(1);
        expect(after.y + after.height - (box.y + box.height)).toBeLessThanOrEqual(12);
        await page.waitForTimeout(300);
        expect((await getExtensionStorage(context, 'ilap_ai_level')).ilap_ai_level).toBe(2);
        await page.locator('#tab-ai').click();
        await openAiTab(page);
        await expect(pane.locator('#ai-level')).toHaveValue('2');
        await expect(pane).not.toHaveClass(/ai-max/);
    });

    test('the slider and the AI tab show the level: its colour up the track and round the thumb, the word framed at Low and struck at Medium, High and Max', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        await openPopup(page, context);
        const tab = page.locator('#tab-ai');
        // The stored level, from the popup's first read, before the tab opens.
        await expect(tab).toHaveAttribute('data-level', '1');
        await openAiTab(page);
        const pane = page.locator('#ai-tab-pane');
        // Off the tab, so its hover takes no part in what is read.
        await pane.locator('.list-title').hover();
        const CLIPPED = 'inset(0px 100% 0px 0px)', WHOLE = 'inset(0px)';
        // Per level: the slider's colour (popup.css --lvl) as a token and as
        // pixels, whether the glyph's frame is drawn, and its strike's colour.
        const LOOK = [
            { lvl: '#8f98a0', px: [143, 152, 160], frame: false, strike: null },
            { lvl: '#1a9fff', px: [26, 159, 255], frame: true, strike: null },
            { lvl: '#ffd21a', px: [255, 210, 26], frame: false, strike: [255, 210, 26] },
            { lvl: '#e3261f', px: [227, 38, 31], frame: false, strike: [227, 38, 31] },
            { lvl: '#111111', px: [17, 17, 17], frame: false, strike: [17, 17, 17] },
        ];
        const TRACK = [58, 74, 94];
        const glyphStyle = () => tab.evaluate((el) => {
            const cs = (sel) => getComputedStyle(el.querySelector(sel));
            return {
                frame: cs('.ai-frame').strokeDashoffset, strike: cs('.ai-slash').clipPath,
            };
        });
        // Levels Low, then moved and waiting for their tick, then Off.
        for (const level of [1, 2, 3, 4, 0]) {
            const want = LOOK[level];
            if (level !== 1) await pane.locator(`.ai-level-tick[data-level="${level}"]`).click();
            await expect(tab).toHaveAttribute('data-level', String(level));
            await expect(pane.locator('.ai-level')).toHaveAttribute('data-level', String(level));
            expect(await pane.locator('#ai-level').evaluate(el => getComputedStyle(el).getPropertyValue('--lvl').trim()), `level ${level}`).toBe(want.lvl);
            // Drawn along its length or taken back.
            const frame = want.frame ? '0px' : '1px', strike = want.strike ? WHOLE : CLIPPED;
            await expect.poll(glyphStyle, { message: `level ${level}` })
                .toEqual({ frame, strike });

            // On screen, once the panel has come to rest (it drops down as the
            // tab opens, and the slider moves with it). The thumb: its ring in
            // the level's colour round a white middle. The track: the level's
            // colour up to the thumb, the rest dark.
            await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
            const s = await pane.locator('#ai-level').boundingBox();
            const cx = s.x + 7 + (s.width - 14) * level / 4, cy = s.y + 9;
            // The glyph (viewBox 33×22 at 1:1): a solid part of the funnel right
            // of the word, the frame's top edge and the point its path starts
            // at (where a dash shifted off still leaves a dot), a point of the
            // strike between the A and the I, and a corner where the glyph
            // draws nothing.
            const g = await page.locator('#tab-ai .ai-glyph').boundingBox();
            const at = (x, y) => [g.x + x, g.y + y];
            // The ring's colour eases over .2 s on the thumb, a pseudo-element
            // that neither getAnimations nor Playwright's `animations: 'disabled'`
            // reaches: read once it is there.
            await expect.poll(async () => gap((await colours(page, [[cx - 5.5, cy]]))[0], want.px),
                { message: `the thumb's ring at level ${level}` }).toBeLessThanOrEqual(2);
            const [ring, middle, fill, rest, gear, frameTop, frameStart, strikeAt, empty] = await colours(page, [
                [cx - 5.5, cy], [cx, cy], [s.x + (cx - s.x - 7) / 2, cy], [cx + 7 + (s.x + s.width - cx - 7) / 2, cy],
                at(27.4, 8), at(11, 3.4), at(5.6, 3.4), at(13.5, 10.1), at(31, 21),
            ]);
            expect(gap(ring, want.px), `the thumb's ring at level ${level}`).toBeLessThanOrEqual(2);
            expect(gap(middle, [255, 255, 255]), `the thumb's middle at level ${level}`).toBeLessThanOrEqual(2);
            if (level > 0) expect(gap(fill, want.px), `the track up to the thumb at level ${level}`).toBeLessThanOrEqual(2);
            if (level < 4) expect(gap(rest, TRACK), `the track past the thumb at level ${level}`).toBeLessThanOrEqual(2);
            // The funnel stands right of the word, in the tab's colour.
            expect(gap(gear, rgb(await tab.evaluate(el => getComputedStyle(el).color))), `the funnel at level ${level}`).toBeLessThanOrEqual(3);
            // A 1.4px frame line may sit across two pixel rows: near, not exact.
            if (want.frame) {
                expect(gap(frameTop, [26, 159, 255]), `the frame at level ${level}`).toBeLessThanOrEqual(60);
            } else {
                expect(gap(frameTop, empty), `no frame at level ${level}`).toBeLessThanOrEqual(3);
                expect(gap(frameStart, empty), `no dot of a frame at level ${level}`).toBeLessThanOrEqual(3);
            }
            if (want.strike) expect(gap(strikeAt, want.strike), `the strike at level ${level}`).toBeLessThanOrEqual(3);
            else expect(gap(strikeAt, empty), `no strike at level ${level}`).toBeLessThanOrEqual(3);
        }

        // A level left with no tick is dropped as the tab shuts, and the
        // glyph goes back to the stored one.
        await tab.click();
        await expect(page.locator('#ai-tab-pane')).toBeHidden();
        await expect(tab).toHaveAttribute('data-level', '1');
        // A level stored elsewhere (the widget, another window) reaches it too.
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await expect(tab).toHaveAttribute('data-level', '3');
    });

    test('a level moved by page script stores nothing', async ({ page, context }) => {
        await openPopup(page, context);
        await openAiTab(page);
        await page.evaluate(() => {
            const slider = document.querySelector('#ai-level');
            slider.value = '3';
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#ai-level-ok').click();
        });
        await page.waitForTimeout(300);
        expect((await getExtensionStorage(context, 'ilap_ai_level')).ilap_ai_level).toBeUndefined();
        await expect(page.locator('#ai-level-ok')).not.toHaveClass(/shown/);
    });

    test('the shots are thumbnails in one row; a pick is stored and read back on a new open', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await openPopup(page, context);
        await openAiTab(page);
        const radios = page.locator('#ai-tab-pane input[name="ai-shot"]');
        expect(await radios.evaluateAll(els => els.map(el => el.getAttribute('aria-label'))))
            .toEqual(['Emoji', 'Red swipe', 'Crossed-out AI', 'Tomato', 'Random']);
        // The random thumbnail is its name, its word whole.
        const random = page.locator('#ai-tab-pane .ai-shot-pic[data-shot="random"]');
        await expect(random).toHaveText('Random');
        expect(await random.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        // One row, inside the pane, with no scrollbar.
        const pics = await page.locator('#ai-tab-pane .ai-shot-pic').evaluateAll(els => els.map(el => el.getBoundingClientRect().toJSON()));
        const pane = await page.locator('#ai-tab-pane').evaluate(el => el.getBoundingClientRect().toJSON());
        expect(new Set(pics.map(r => Math.round(r.top))).size).toBe(1);
        expect(pics[pics.length - 1].right).toBeLessThanOrEqual(pane.right);
        expect(Math.min(...pics.map(r => r.width))).toBeGreaterThan(24);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.locator('.ai-shot-opt:has(input[value="emoji"])').click();
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_ai_shot')).ilap_ai_shot).toBe('emoji');
        await expect(page.locator('#ai-shot-name')).toHaveText('Emoji');
        await page.reload();
        await page.locator('#popup-root').waitFor();
        await openAiTab(page);
        await expect(page.locator('input[name="ai-shot"][value="emoji"]')).toBeChecked();
        await expect(page.locator('#ai-shot-name')).toHaveText('Emoji');
    });

    test('the shot picker works from the keyboard', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await openPopup(page, context);
        await openAiTab(page);
        await page.locator('input[name="ai-shot"][value="tomato"]').focus();
        await page.keyboard.press('ArrowRight');
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_ai_shot')).ilap_ai_shot).toBe('random');
        await expect(page.locator('#ai-shot-name')).toHaveText('Random');
    });

    // The emoji shot's own pick (Settings.SHOT_EMOJI): a caret in the emoji
    // thumbnail's corner opens a grid of emoji over the panel.
    const stored = async (context, key) => (await getExtensionStorage(context, key))[key];
    const EMOJI_PIC = '#ai-tab-pane .ai-shot-pic[data-shot="emoji"]';

    test('the emoji thumbnail shows the picked emoji; its caret opens a grid over the panel, and a pick is stored with the emoji shot', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ai_level: 3, ilap_ai_shot: 'swipe', ilap_ai_shot_emoji: '\u{1F4A9}' });
        await openPopup(page, context);
        await openAiTab(page);
        const pane = page.locator('#ai-tab-pane');
        const caret = pane.locator('.ai-emoji-btn');
        const grid = pane.locator('.ai-emoji-grid');
        await expect(page.locator(EMOJI_PIC)).toHaveText('\u{1F4A9}');
        await expect(caret).toHaveAttribute('aria-expanded', 'false');
        await expect(grid).toBeHidden();
        const paneBox = await pane.boundingBox();

        await caret.click();
        await expect(grid).toBeVisible();
        await expect(caret).toHaveAttribute('aria-expanded', 'true');
        await expect(grid.locator('.ai-emoji-opt')).toHaveCount(20);
        await expect(grid.locator('.ai-emoji-opt[aria-checked="true"]')).toHaveText('\u{1F4A9}');
        // Up over the panel, inside the window, and the AI tab keeps its height.
        await expect.poll(() => grid.evaluate(el => getComputedStyle(el).opacity)).toBe('1');
        const g = await grid.boundingBox();
        const thumb = await page.locator(EMOJI_PIC).boundingBox();
        expect(g.y + g.height).toBeLessThanOrEqual(thumb.y);
        expect(g.y).toBeGreaterThanOrEqual(0);
        expect(g.x).toBeGreaterThanOrEqual(0);
        expect(g.x + g.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
        expect((await pane.boundingBox()).height).toBe(paneBox.height);
        expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);

        await grid.locator('.ai-emoji-opt[data-emoji="\u{270C}\u{FE0F}"]').click();
        await expect(grid).toBeHidden();
        await expect(caret).toHaveAttribute('aria-expanded', 'false');
        await expect.poll(() => stored(context, 'ilap_ai_shot_emoji')).toBe('\u{270C}\u{FE0F}');
        await expect.poll(() => stored(context, 'ilap_ai_shot')).toBe('emoji');
        await expect(page.locator(EMOJI_PIC)).toHaveText('\u{270C}\u{FE0F}');
        await expect(page.locator('input[name="ai-shot"][value="emoji"]')).toBeChecked();
        await expect(page.locator('#ai-shot-name')).toHaveText('Emoji');

        await page.reload();
        await page.locator('#popup-root').waitFor();
        await openAiTab(page);
        await expect(page.locator(EMOJI_PIC)).toHaveText('\u{270C}\u{FE0F}');
    });

    test('a click on the emoji thumbnail picks it, a second click opens the grid, and a click elsewhere shuts it', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ai_level: 3, ilap_ai_shot: 'swipe' });
        await openPopup(page, context);
        await openAiTab(page);
        const grid = page.locator('#ai-tab-pane .ai-emoji-grid');
        await expect(page.locator(EMOJI_PIC)).toHaveText('\u{1F44E}');
        await page.locator(EMOJI_PIC).click();
        await expect.poll(() => stored(context, 'ilap_ai_shot')).toBe('emoji');
        await expect(grid).toBeHidden();
        await page.locator(EMOJI_PIC).click();
        await expect(grid).toBeVisible();
        // The grid covers the lines over the thumbnails: a click under them.
        await page.locator('#ai-tab-pane .ai-keep').click({ position: { x: 2, y: 2 } });
        await expect(grid).toBeHidden();
    });

    test('the emoji grid from the keyboard: the caret opens it on the picked emoji, arrows walk it, Enter picks, Escape and Tab shut it', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ai_level: 3, ilap_ai_shot: 'emoji' });
        await openPopup(page, context);
        await openAiTab(page);
        const caret = page.locator('#ai-tab-pane .ai-emoji-btn');
        const grid = page.locator('#ai-tab-pane .ai-emoji-grid');
        const opt = (i) => grid.locator('.ai-emoji-opt').nth(i);
        // One tab stop in the grid, on the picked emoji.
        expect(await grid.locator('.ai-emoji-opt').evaluateAll(els => els.filter(el => el.tabIndex === 0).length)).toBe(1);

        await caret.focus();
        await page.keyboard.press('Enter');
        await expect(grid).toBeVisible();
        await expect(opt(0)).toBeFocused();
        await page.keyboard.press('ArrowRight');
        await expect(opt(1)).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(opt(6)).toBeFocused();
        await page.keyboard.press('End');
        await expect(opt(19)).toBeFocused();
        await page.keyboard.press('Home');
        await expect(opt(0)).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await expect.poll(() => stored(context, 'ilap_ai_shot_emoji')).toBe(await opt(5).getAttribute('data-emoji'));
        await expect(grid).toBeHidden();
        await expect(caret).toBeFocused();

        await page.keyboard.press('Enter');
        await expect(opt(5)).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(grid).toBeHidden();
        await expect(caret).toBeFocused();
        // Escape took the grid only: the AI tab stays open.
        await expect(page.locator('#ai-tab-pane')).toBeVisible();

        await page.keyboard.press('Enter');
        await expect(grid).toBeVisible();
        await page.keyboard.press('Tab');
        await expect(grid).toBeHidden();
    });

    test('the emoji caret is dead off High and with the shot animation off', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ai_level: 2, ilap_ai_shot: 'emoji' });
        await openPopup(page, context);
        await openAiTab(page);
        const caret = page.locator('#ai-tab-pane .ai-emoji-btn');
        await expect(caret).toBeDisabled();
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await expect(caret).toBeEnabled();
        await caret.click();
        await expect(page.locator('#ai-tab-pane .ai-emoji-grid')).toBeVisible();
        // The animation turned off shuts an open grid.
        await setExtensionStorage(context, { ilap_ai_shot_anim: false });
        await expect(caret).toBeDisabled();
        await expect(page.locator('#ai-tab-pane .ai-emoji-grid')).toBeHidden();
    });

    test('the shot animation toggle: its tooltip, off it dims the styles and is stored, and it reads back', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await openPopup(page, context);
        await openAiTab(page);
        const pane = page.locator('#ai-tab-pane');
        const toggle = pane.locator('#ai-shot-anim');
        const shots = pane.locator('.ai-shots');
        await expect(toggle).toBeChecked();
        await expect(toggle).toBeEnabled();
        await expect(toggle).toHaveAccessibleName('Shot animation');
        // In the caption line: the line keeps its height with the toggle in it.
        const head = await pane.locator('.ai-shot-head').evaluate(el => el.getBoundingClientRect().height);
        expect(head).toBeLessThanOrEqual(18);
        // Our own tooltip, faded in on a hover, inside the panel.
        const tip = pane.locator('.ai-shot-tip');
        await expect(tip).toHaveCSS('opacity', '0');
        await pane.locator('.ai-shot-anim').hover();
        await expect(tip).toHaveCSS('opacity', '1');
        await expect(tip).toHaveText('Shot animation');
        const box = await tip.evaluate(el => el.getBoundingClientRect().toJSON());
        const root = await page.locator('#popup-root').evaluate(el => el.getBoundingClientRect().toJSON());
        expect(box.left).toBeGreaterThanOrEqual(root.left);
        expect(box.right).toBeLessThanOrEqual(root.right);
        expect(box.top).toBeGreaterThanOrEqual(root.top);
        expect(await shots.evaluate(el => getComputedStyle(el).transitionProperty)).toContain('opacity');
        await pane.locator('.ai-shot-anim .slider').click();
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_ai_shot_anim')).ilap_ai_shot_anim).toBe(false);
        await expect(shots).toHaveClass(/ai-dim/);
        await expect(shots).toHaveCSS('opacity', '0.45');
        await expect(pane.locator('input[name="ai-shot"][value="ai"]')).toBeDisabled();
        // The style picked stays for when the animation comes back.
        await expect(pane.locator('input[name="ai-shot"][value="ai"]')).toBeChecked();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.reload();
        await page.locator('#popup-root').waitFor();
        await openAiTab(page);
        await expect(page.locator('#ai-shot-anim')).not.toBeChecked();
        await expect(page.locator('#ai-tab-pane .ai-shots')).toHaveClass(/ai-dim/);
        await page.locator('#ai-tab-pane .ai-shot-anim .slider').click();
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_ai_shot_anim')).ilap_ai_shot_anim).toBe(true);
        await expect(page.locator('#ai-tab-pane .ai-shots')).not.toHaveClass(/ai-dim/);
        await expect(page.locator('#ai-tab-pane input[name="ai-shot"][value="ai"]')).toBeEnabled();
    });

    test('a box is a pill toggle: switched on it is stored, the knob slides, and it reads back on a new open', async ({ page, context }) => {
        await openPopup(page, context);
        await openAiTab(page);
        const box = page.locator('input[data-keep="ingame"]');
        const knob = page.locator('.ai-check:has(input[data-keep="ingame"]) .slider');
        expect(await knob.evaluate(el => getComputedStyle(el, '::before').transitionProperty)).toMatch(/all|transform/);
        await expect(box).toHaveAccessibleName(/Keep games with AI inside the game/);
        await page.locator('.ai-check:has(input[data-keep="ingame"])').click();
        await expect(box).toBeChecked();
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_ai_keep_ingame')).ilap_ai_keep_ingame).toBe(true);
        await page.reload();
        await page.locator('#popup-root').waitFor();
        await openAiTab(page);
        await expect(box).toBeChecked();
    });

    test('a box changed by page script stores nothing', async ({ page, context }) => {
        await openPopup(page, context);
        await openAiTab(page);
        await page.evaluate(() => {
            const box = document.querySelector('input[data-keep="translation"]');
            box.checked = true;
            box.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(300);
        expect((await getExtensionStorage(context, 'ilap_ai_keep_translation')).ilap_ai_keep_translation).toBeUndefined();
    });

    test('ticking a box takes its games out of the AI list: the count, the job and its rev', async ({ page, context }) => {
        await openPopup(page, context);
        await openDrawerOn(page, BUCKET.b);
        const all = DATA.ai[BUCKET.b].length;
        expect(await count(page)).toBe(all);
        await openAiTab(page);
        await page.locator('.ai-check:has(input[data-keep="translation"])').click();
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_ai_keep_translation')).ilap_ai_keep_translation).toBe(true);
        // In the toolbar popup the tab folded the lists: open again, on the same year.
        await openDrawerOn(page, BUCKET.b);
        await expect.poll(() => count(page)).toBe(all - BUCKET.n);
        await page.locator(`.list-row[data-key="${KEY}"] .list-add`).click();
        await expect.poll(async () => ((await getExtensionStorage(context, 'ilap_curator_queue')).ilap_curator_queue || []).length).toBe(1);
        const job = (await getExtensionStorage(context, 'ilap_curator_queue')).ilap_curator_queue[0];
        expect(job.presetRev).toBe(DATA.rev[KEY] + '+t');
        // The list is stored under its own key (Store.getList).
        const listKey = 'ilap_curator_appids_' + job.id;
        const appids = (await getExtensionStorage(context, listKey))[listKey];
        expect(appids.length).toBe(all - BUCKET.n);
        expect(appids.some(a => KEEP.translation.includes(Number(a)))).toBe(false);
    });

    test('a list run with a box ticked is offered again once the box is clear, and not while it is ticked', async ({ page, context }) => {
        await setExtensionStorage(context, { ['ilap_preset_done_' + KEY]: DATA.rev[KEY] + '+t', ilap_ai_keep_translation: true });
        await openPopup(page, context);
        await openDrawerOn(page, BUCKET.b);
        await expect(page.locator(`.list-row[data-key="${KEY}"]`)).toHaveClass(/is-done/);
        await openAiTab(page);
        await page.locator('.ai-check:has(input[data-keep="translation"])').click();
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_ai_keep_translation')).ilap_ai_keep_translation).toBe(false);
        await openDrawerOn(page, BUCKET.b);
        await expect(page.locator(`.list-row[data-key="${KEY}"] .list-add`)).toBeEnabled();
    });

    test('a list run with no box ticked stays done when a box is ticked: its games are a part of that run', async ({ page, context }) => {
        await setExtensionStorage(context, { ['ilap_preset_done_' + KEY]: DATA.rev[KEY] });
        await openPopup(page, context);
        await openDrawerOn(page, BUCKET.b);
        await expect(page.locator(`.list-row[data-key="${KEY}"]`)).toHaveClass(/is-done/);
        await openAiTab(page);
        await page.locator('.ai-check:has(input[data-keep="translation"])').click();
        await page.locator('.ai-check:has(input[data-keep="ingame"])').click();
        await expect.poll(async () => (await getExtensionStorage(context, 'ilap_ai_keep_ingame')).ilap_ai_keep_ingame).toBe(true);
        await openDrawerOn(page, BUCKET.b);
        await expect(page.locator(`.list-row[data-key="${KEY}"]`)).toHaveClass(/is-done/);
    });

    test('the pane follows the interface language', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_lang: 'ru' });
        await openPopup(page, context);
        await openAiTab(page);
        const pane = page.locator('#ai-tab-pane');
        await expect(pane.locator('.ai-check').first()).toContainText('Оставлять игры, где ИИ только для перевода');
        await expect(pane.locator('.ai-level-tick')).toHaveText(['Откл.', 'Низкий', 'Средний', 'Высокий', 'Макс.']);
        await expect(pane.locator('.ai-level-hint.shown')).toHaveText('ИИ-игры получают метку AI на страницах магазина.');
        await expect(pane.locator('#ai-shot-name')).toHaveText('Перечёркнутый ИИ');
        await expect(pane.locator('#ai-shot-anim')).toHaveAccessibleName('Анимация выстрела');
        await expect(pane.locator('input[name="ai-shot"][value="ai"]')).toHaveAttribute('aria-label', 'Перечёркнутый ИИ');
    });
});
