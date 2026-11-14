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

// The built-in ignore lists (ui/popup_presets.js): the lists button in the tab
// line's left corner, the drawer it opens (in the toolbar popup, which this
// spec drives, a band that drops down under the tab line and grows the window
// down, taking turns with the tabs; the widget's drawer beside the panel is in
// tests/widget/scrollbars.spec.js) and the jobs it stages. Driven through the popup window only. No Steam page is
// open and the test build's service worker is empty, so a staged job is never
// drained and nothing here ignores a real game.
//
// Expectations come from the shipped data/presets.json, so the spec holds for
// whatever lists a release ships.

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'presets.json'), 'utf8'));
// The year list's order: the upcoming years soonest first, then 'tba', then
// the released years newest first, then the older ones together.
function rank(b) {
    const up = /^upcoming_(\d{4})/.exec(b);
    if (up) return [0, +up[1]];
    if (b === 'tba') return [1, 0];
    if (/^\d{4}$/.test(b)) return [2, -b];
    return [3, 0];
}
const BUCKETS = Object.keys(DATA.ai).sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1]);
// The year the AI row starts on among the open ones: this year's released
// games, or the nearest released year (the newer of two as near), or the first
// open bucket when no released year is open.
function startBucket(open) {
    const now = new Date().getFullYear();
    const years = open.filter(b => /^\d{4}$/.test(b));
    if (!years.length) return open[0];
    return years.reduce((best, b) => {
        const d = Math.abs(+b - now), bd = Math.abs(+best - now);
        return d < bd || (d === bd && +b > +best) ? b : best;
    });
}
const DEFAULT = startBucket(BUCKETS);
function label(b) {
    const up = /^upcoming_(.+)$/.exec(b), earlier = /^earlier_(.+)$/.exec(b);
    if (up) return 'Upcoming ' + up[1];
    if (earlier) return earlier[1] + ' and earlier';
    return b === 'tba' ? 'To be announced' : b;
}
function jobName(b) {
    const up = /^upcoming_(.+)$/.exec(b);
    if (up) return 'Upcoming AI games ' + up[1];
    return b === 'tba' ? 'AI games, date TBA' : 'AI games ' + label(b);
}
// The lists that ship whole, in the drawer's order (by English name), and their English names.
const FLAT_NAME = {
    denuvo: 'Denuvo DRM', eularetro: 'EULA can change at any time', vr: 'Every VR game',
    iap: 'In-App Purchases', eula: 'Invasive EULA terms', anticheat: 'Kernel access', bad: 'Known bad games',
    lesser: 'Lesser-known bad games',
};
const FLAT = Object.keys(FLAT_NAME).filter(k => Array.isArray(DATA[k]) && DATA[k].length > 0);

const queuedJob = (key) => ({
    id: 'job_preset_' + key + '_1', type: 'preset', curatorId: 'preset_' + key, presetKey: key,
    appids: ['1'], total: 1, status: 'paused',
});

async function openPopup(page, context) {
    const extId = await getExtensionId(context);
    await page.goto(popupUrl(extId));
    await page.locator('#popup-root').waitFor({ timeout: 5000 });
}

// The lists drawer's block of rows (the queue's drawer has one too).
const INNER = '#lists-drawer .drawer-inner';

// Opens the drawer and waits out its slide: it clips while it moves.
async function openDrawer(page) {
    await page.locator('#lists-btn').click();
    await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
    await expect(page.locator('#lists-drawer')).not.toHaveClass(/sliding/);
}

async function pickYear(page, bucket) {
    await page.locator('#ai-pane .ai-year').click();
    await expect(page.locator('.ai-years')).toHaveClass(/open/);
    await page.locator(`.ai-opt[data-bucket="${bucket}"]`).click();
    await expect(page.locator('#ai-pane .ai-year')).toHaveText(label(bucket));
}

const row = (page, key) => page.locator(`.list-row[data-key="${key}"]`);

async function readQueue(context) {
    const res = await getExtensionStorage(context, 'ilap_curator_queue');
    return Array.isArray(res.ilap_curator_queue) ? res.ilap_curator_queue : [];
}

// A built-in list job's games, stored under their own key (Store.getList).
async function readList(context, job) {
    const key = 'ilap_curator_appids_' + job.id;
    return (await getExtensionStorage(context, key))[key];
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Popup — built-in ignore lists drawer', () => {
    test.skip(BUCKETS.length < 2 || DATA.denuvo.length === 0,
        'needs two AI years and a Denuvo list in data/presets.json');

    test('the drawer drops down under the tab line and back, as wide as the panel and as tall as its rows', async ({ page, context }) => {
        await openPopup(page, context);
        const drawer = page.locator('#lists-drawer');
        await expect(drawer).toBeHidden();
        await expect(page.locator('#lists-btn')).toHaveAttribute('aria-expanded', 'false');

        // A click from page script is untrusted and opens nothing.
        await page.evaluate(() => document.getElementById('lists-btn').click());
        await page.waitForTimeout(400);
        await expect(drawer).not.toHaveClass(/open/);

        const glyph = page.locator('#lists-btn > svg:not(.lists-back)');
        const restX = (await glyph.boundingBox()).x;
        const width = await page.evaluate(() => document.documentElement.scrollWidth);
        await page.locator('#lists-btn').click();
        await expect(drawer).toHaveClass(/open/);
        await expect(page.locator('#lists-btn')).toHaveAttribute('aria-expanded', 'true');
        await expect(drawer).not.toHaveClass(/sliding/);
        const box = await drawer.boundingBox();
        const panel = await page.locator('#popup-root').boundingBox();
        const line = await page.locator('#tabline').boundingBox();
        // A band right under the line (the panel's foot with no tab open), as
        // wide as the panel; the window keeps its width and grows down by it.
        expect(Math.abs(box.y - (line.y + line.height))).toBeLessThan(1);
        expect(Math.abs(box.x - panel.x)).toBeLessThan(1);
        expect(Math.abs(box.width - panel.width)).toBeLessThan(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        expect(await page.evaluate(() => document.body.scrollHeight)).toBeGreaterThan(Math.round(panel.height + 100));
        const inner = page.locator(INNER);
        expect(await inner.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0);
        // The lists glyph moved over to the right and a mark pointing down
        // came out on its left.
        await expect(page.locator('#lists-btn .lists-back')).toHaveCSS('opacity', '1');
        expect(await page.locator('#lists-btn .lists-back').evaluate(el => getComputedStyle(el).transform))
            .toMatch(/^matrix\([^,]+, -1, 1, [^,]+, 0, 0\)$/);   // rotate(-90deg): pointing down
        await expect(glyph).toHaveCSS('opacity', '1');
        await expect.poll(async () => (await glyph.boundingBox()).x).toBeGreaterThan(restX + 4);

        await page.locator('#lists-btn').click();
        await expect(page.locator('#lists-btn')).toHaveAttribute('aria-expanded', 'false');
        await expect(drawer).toHaveClass(/sliding/);
        await expect(drawer).toBeHidden();
        expect(await drawer.evaluate(el => getComputedStyle(el).visibility)).toBe('hidden');
        await expect(page.locator('#lists-btn .lists-back')).toHaveCSS('opacity', '0');
        await expect.poll(async () => Math.round((await glyph.boundingBox()).x)).toBe(Math.round(restX));
    });

    test('the lists and the tabs take turns under the line: one shuts the other', async ({ page, context }) => {
        await openPopup(page, context);
        await page.locator('#tab-settings').click();
        await expect(page.locator('#settings-placeholder')).toBeVisible();
        await page.locator('#lists-btn').click();
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        await expect(page.locator('#tab-settings')).toHaveAttribute('aria-selected', 'false');
        await expect(page.locator('#settings-placeholder')).toBeHidden();

        await page.locator('#tab-ai').click();
        await expect(page.locator('#tab-ai')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/open/);
        await expect(page.locator('#lists-btn')).toHaveAttribute('aria-expanded', 'false');
    });

    test('a switch between the lists and a tab is one move, as a switch between two tabs', async ({ page, context }) => {
        // Every frame of a switch: the window's height and the heights of the
        // lists' band and the tabs' panel. The one coming in takes over the
        // other's room at once and grows or shrinks from there, so the two
        // never share the room under the line (two of them moving at once
        // slide the line between them up and down, which jitters), and the
        // window only grows or only shrinks.
        const watch = () => page.evaluate(() => new Promise((resolve) => {
            const out = [];
            const h = (sel) => document.querySelector(sel).getBoundingClientRect().height;
            const t0 = performance.now();
            const tick = () => {
                out.push([document.body.scrollHeight, h('#lists-drawer'), h('#tab-panel')]);
                if (performance.now() - t0 < 700) requestAnimationFrame(tick); else resolve(out);
            };
            requestAnimationFrame(tick);
        }));
        const check = (frames, what) => {
            const shared = frames.filter(([, l, p]) => l > 0 && p > 0);
            expect(shared, `${what}: frames with both under the line`).toEqual([]);
            const steps = frames.slice(1).map((f, k) => f[0] - frames[k][0]).filter(d => d);
            expect(steps.every(d => d > 0) || steps.every(d => d < 0), `${what}: ${frames.map(f => f[0]).join(' ')}`).toBe(true);
        };
        await openPopup(page, context);
        await page.locator('#lists-btn').click();
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/sliding/);

        const toAi = watch();
        await page.locator('#tab-ai').click();
        check(await toAi, 'lists to AI');
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/open/);

        const toLists = watch();
        await page.locator('#lists-btn').click();
        check(await toLists, 'AI to lists');
        await expect(page.locator('#tab-ai')).toHaveAttribute('aria-selected', 'false');
    });

    test('the year list drops over the rows under the year, at its right edge, and the block keeps its size', async ({ page, context }) => {
        await openPopup(page, context);
        await openDrawer(page);
        const inner = page.locator(INNER);
        const shut = await inner.boundingBox();
        const watch = page.evaluate((sel) => new Promise((resolve) => {
            const el = document.querySelector(sel);
            const box = document.querySelector('.ai-years');
            const out = [];
            const t0 = performance.now();
            const tick = () => {
                const r = el.getBoundingClientRect();
                out.push({ top: r.top, bottom: r.bottom, years: box.getBoundingClientRect().height, bar: el.scrollHeight > el.clientHeight });
                if (performance.now() - t0 < 500) requestAnimationFrame(tick); else resolve(out);
            };
            requestAnimationFrame(tick);
        }), INNER);
        await page.locator('#ai-pane .ai-year').click();
        const frames = await watch;
        // The block never moved or grew, and never scrolled.
        frames.forEach(f => {
            expect(Math.abs(f.top - shut.y)).toBeLessThan(1);
            expect(Math.abs(f.bottom - (shut.y + shut.height))).toBeLessThan(1);
        });
        expect(frames.some(f => f.bar), 'no scrollbar on the block').toBe(false);
        // The list unfolds over several frames.
        const heights = new Set(frames.map(f => Math.round(f.years)));
        expect(heights.size, 'the list unfolds over several frames').toBeGreaterThan(4);

        // Under the year button, against its right edge, at least as wide,
        // and over the rows under it: their places did not change.
        const year = await page.locator('#ai-pane .ai-year').boundingBox();
        const list = await page.locator('.ai-years').boundingBox();
        expect(list.y).toBeGreaterThan(year.y + year.height - 0.5);
        expect(Math.abs(list.x + list.width - (year.x + year.width))).toBeLessThan(1);
        expect(list.width).toBeGreaterThanOrEqual(year.width - 0.5);
        // It ends inside the block: past that its box scrolls.
        expect(list.y + list.height).toBeLessThanOrEqual(shut.y + shut.height + 0.5);
        const box = page.locator('.ai-years-box');
        const scrolls = await box.evaluate(el => el.scrollHeight > el.clientHeight);
        if (scrolls) {
            // Opened on the picked year, in view.
            const sel = await page.locator('.ai-opt.selected').boundingBox();
            const b = await box.boundingBox();
            expect(sel.y).toBeGreaterThanOrEqual(b.y - 0.5);
            expect(sel.y + sel.height).toBeLessThanOrEqual(b.y + b.height + 0.5);
        }
    });

    test('the year button is as wide as its year, on the right by the count', async ({ page, context }) => {
        await openPopup(page, context);
        await openDrawer(page);
        const row = await page.locator('#ai-pane .ai-row').boundingBox();
        const year = await page.locator('#ai-pane .ai-year').boundingBox();
        const count = await page.locator('#ai-pane .list-count').boundingBox();
        expect(year.width).toBeLessThan(row.width / 2);
        expect(year.x).toBeGreaterThan(row.x + row.width / 3);
        expect(count.x - (year.x + year.width)).toBeLessThan(12);
    });

    test('on the shortest panel the block drops under the line and the year list ends inside it', async ({ page, context }) => {
        // Already Played set to off drops its hint line: the panel is at its shortest.
        await setExtensionStorage(context, { ilap_platform_key: 'off' });
        await openPopup(page, context);
        await openDrawer(page);
        await page.locator('#ai-pane .ai-year').click();
        await expect(page.locator('.ai-years')).toHaveClass(/open/);
        await page.waitForTimeout(300);
        const m = await page.evaluate((sel) => {
            const inner = document.querySelector(sel);
            const line = document.getElementById('tabline').getBoundingClientRect();
            const r = inner.getBoundingClientRect();
            const list = document.querySelector('.ai-years').getBoundingClientRect();
            return {
                lineBottom: line.bottom, top: r.top, bottom: r.bottom, listBottom: list.bottom,
                inner: inner.scrollHeight > inner.clientHeight,
                page: document.documentElement.scrollHeight > document.documentElement.clientHeight,
            };
        }, INNER);
        expect(m.top).toBeGreaterThanOrEqual(m.lineBottom - 0.5);
        expect(m.listBottom).toBeLessThanOrEqual(m.bottom + 0.5);
        expect(m.inner, 'the block does not scroll').toBe(false);
        expect(m.page, 'the window itself never scrolls').toBe(false);
    });

    test('the drawer drops down and folds up over several frames, and the window never changes width', async ({ page, context }) => {
        // A toolbar popup window that grows sideways flashes as the browser
        // redraws it; growing down does not show.
        await openPopup(page, context);
        const watch = () => page.evaluate(() => new Promise((resolve) => {
            const d = document.getElementById('lists-drawer');
            const out = [];
            const t0 = performance.now();
            const tick = () => {
                out.push({ h: d.getBoundingClientRect().height, page: document.documentElement.scrollWidth });
                if (performance.now() - t0 < 700) requestAnimationFrame(tick); else resolve(out);
            };
            requestAnimationFrame(tick);
        }));
        const width = await page.evaluate(() => document.documentElement.scrollWidth);
        const opening = watch();
        await page.locator('#lists-btn').click();
        const open = await opening;
        const full = Math.max(...open.map(f => f.h));
        expect(full).toBeGreaterThan(150);
        expect(open.filter(f => f.h > 0 && f.h < full).length, 'the drawer drops over several frames').toBeGreaterThan(3);
        expect(open.every(f => f.page === width), 'the window keeps its width').toBe(true);

        const shutting = watch();
        await page.locator('#lists-btn').click();
        const shut = await shutting;
        expect(shut.filter(f => f.h > 0 && f.h < full).length, 'the drawer folds over several frames').toBeGreaterThan(3);
        expect(shut[shut.length - 1].h).toBe(0);
        expect(shut.every(f => f.page === width), 'the window keeps its width').toBe(true);
    });

    test('the drawer offers the AI list on this year, then the whole lists, each with its game count', async ({ page, context }) => {
        await openPopup(page, context);
        await openDrawer(page);

        await expect(page.locator('#ai-pane .list-name')).toHaveText('AI-generated content');
        await expect(page.locator('#ai-pane .ai-year')).toHaveText(label(DEFAULT));
        await expect(row(page, 'ai_' + DEFAULT).locator('.list-count'))
            .toHaveText(DATA.ai[DEFAULT].length.toLocaleString('en'));
        await expect(page.locator('#lists-pane .list-name')).toHaveText(FLAT.map(k => FLAT_NAME[k]));
        for (const k of FLAT) {
            await expect(row(page, k).locator('.list-count')).toHaveText(DATA[k].length.toLocaleString('en'));
            await expect(row(page, k).locator('.list-add')).toBeEnabled();
        }

        await page.locator('#ai-pane .ai-year').click();
        await expect(page.locator('.ai-opt')).toHaveText(BUCKETS.map(label));
        await expect(page.locator('.ai-opt.selected')).toHaveAttribute('data-bucket', DEFAULT);
    });

    test('+ queues the picked year as its own job; the drawer stays open and the row says it is queued', async ({ page, context }) => {
        await openPopup(page, context);
        await openDrawer(page);
        const bucket = BUCKETS[1];
        await pickYear(page, bucket);
        await row(page, 'ai_' + bucket).locator('.list-add').click();

        await expect.poll(async () => (await readQueue(context)).length).toBe(1);
        const [job] = await readQueue(context);
        expect(job).toMatchObject({
            type: 'preset', curatorId: 'preset_ai_' + bucket, presetKey: 'ai_' + bucket,
            presetRev: DATA.rev['ai_' + bucket], status: 'pending', total: DATA.ai[bucket].length,
        });
        expect(await readList(context, job)).toEqual(DATA.ai[bucket].map(String));

        // The drawer stays open and the queue is not opened for it: the row
        // flies into the job count, which then counts it.
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        await expect(page.locator('#queue-btn')).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('#queue-jobs-chip')).toHaveText('1');
        await expect(row(page, 'ai_' + bucket).locator('.list-state.is-queued')).toHaveAttribute('aria-label', 'In queue');
        await expect(row(page, 'ai_' + bucket).locator('.list-add')).toHaveCount(0);
        await page.locator('#queue-btn').click();
        await expect(page.locator('.queue-job-name')).toHaveText(jobName(bucket));
        await expect(page.locator('.queue-job-glyph')).toBeVisible();
    });

    test('the keyboard opens the drawer, picks a year and adds it; Escape shuts the years, then the drawer', async ({ page, context }) => {
        await openPopup(page, context);
        await page.locator('#lists-btn').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);

        const bucket = BUCKETS[1];
        await page.locator('#ai-pane .ai-year').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('.ai-years')).toHaveClass(/open/);
        await expect(page.locator('#ai-pane .ai-year')).toHaveAttribute('aria-expanded', 'true');
        // The open list takes focus on its selected year.
        await expect(page.locator(`.ai-opt[data-bucket="${DEFAULT}"]`)).toBeFocused();
        await page.locator(`.ai-opt[data-bucket="${bucket}"]`).focus();
        await page.keyboard.press('Enter');
        // The pick shuts the list and hands focus back to the year.
        await expect(page.locator('#ai-pane .ai-year')).toHaveText(label(bucket));
        await expect(page.locator('#ai-pane .ai-year')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(row(page, 'ai_' + bucket).locator('.list-add')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect.poll(async () => (await readQueue(context)).map(j => j.presetKey)).toEqual(['ai_' + bucket]);

        await page.locator('#ai-pane .ai-year').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('.ai-years')).toHaveClass(/open/);
        await page.keyboard.press('Escape');
        await expect(page.locator('.ai-years')).not.toHaveClass(/open/);
        await expect(page.locator('#ai-pane .ai-year')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/open/);
        await expect(page.locator('#lists-btn')).toBeFocused();
    });

    test('a triple click on + queues the list once', async ({ page, context }) => {
        // The + goes off while the list goes in, and the row says it is queued
        // once it is. A triple click and three quick separate presses each
        // land one job.
        await openPopup(page, context);
        await openDrawer(page);
        await row(page, 'denuvo').locator('.list-add').click({ clickCount: 3 });
        await expect.poll(async () => (await readQueue(context)).map(j => j.presetKey)).toEqual(['denuvo']);

        const add = row(page, FLAT[1]).locator('.list-add');
        const box = await add.boundingBox();
        for (let i = 0; i < 3; i++) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(40);
        }
        await expect.poll(async () => (await readQueue(context)).map(j => j.presetKey)).toEqual(['denuvo', FLAT[1]]);
        await page.waitForTimeout(800);
        expect((await readQueue(context)).map(j => j.presetKey)).toEqual(['denuvo', FLAT[1]]);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('2');
    });

    test('Enter held on + queues one list, its auto-repeat queues nothing', async ({ page, context }) => {
        await openPopup(page, context);
        await openDrawer(page);
        await row(page, 'denuvo').locator('.list-add').focus();
        for (let i = 0; i < 8; i++) { await page.keyboard.down('Enter'); await page.waitForTimeout(60); }
        await page.keyboard.up('Enter');
        await page.waitForTimeout(800);
        expect((await readQueue(context)).map(j => j.presetKey)).toEqual(['denuvo']);
    });

    test('Kernel access says what it covers in a tip over its name, also to the keyboard on its +', async ({ page, context }) => {
        await openPopup(page, context);
        await openDrawer(page);
        const tip = row(page, 'anticheat').locator('.list-tip');
        await expect(tip).toBeHidden();
        await row(page, 'anticheat').locator('.list-name').hover();
        await expect(tip).toBeVisible();
        await expect(tip).toHaveText('Kernel-level anti-cheat and EULAs that ask for kernel access.');
        await expect(row(page, 'anticheat').locator('.list-add')).toHaveAttribute('aria-describedby', 'list-tip-anticheat');
        // Inside the drawer: it opens no scrollbar and nothing cuts it.
        const inner = page.locator(INNER);
        const box = await tip.boundingBox();
        const frame = await inner.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(frame.x);
        expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
        expect(await inner.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
        // Both bad games lists have one too, the other lists none.
        await expect(page.locator('#lists-pane .list-tip')).toHaveCount(['anticheat', 'bad', 'lesser'].filter(k => FLAT.includes(k)).length);
    });

    test('a cut EULA list name shows whole over itself on hover, inside the drawer', async ({ page, context }) => {
        await openPopup(page, context);
        await openDrawer(page);
        const name = row(page, 'eularetro').locator('.list-name');
        const full = row(page, 'eularetro').locator('.list-name-full');
        // Cut to the row's room, on one line.
        await name.evaluate(el => { el.style.maxWidth = '60px'; });
        expect(await name.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
        await expect(full).toBeHidden();
        await name.hover();
        await expect(full).toBeVisible();
        await expect(full).toHaveText('EULA can change at any time');
        const box = await full.boundingBox();
        const frame = await page.locator(INNER).boundingBox();
        expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
        await page.mouse.move(0, 0);
        await expect(full).toBeHidden();
    });

    test('each whole list queues as its own job under its name', async ({ page, context }) => {
        // Three jobs fill the queue.
        const queued = FLAT.slice(0, 3);
        await openPopup(page, context);
        await openDrawer(page);
        for (const key of queued) {
            await row(page, key).locator('.list-add').click();
            await expect.poll(async () => (await readQueue(context)).map(j => j.presetKey)).toContain(key);
        }
        await expect.poll(async () => (await readQueue(context)).map(j => j.presetKey)).toEqual(queued);
        const jobs = await readQueue(context);
        for (const [i, key] of queued.entries()) {
            expect(jobs[i]).toMatchObject({ presetKey: key, presetRev: DATA.rev[key], total: DATA[key].length });
            expect(await readList(context, jobs[i])).toEqual(DATA[key].map(String));
        }
        await page.locator('#queue-btn').click();
        await expect(page.locator('.queue-job-name')).toHaveText(queued.map(k => FLAT_NAME[k]));
    });

    test('a list run to its end in this version says so, an updated one is offered again', async ({ page, context }) => {
        // The year the row would start on is done: it starts on the nearest open one.
        const first = DEFAULT;
        const second = startBucket(BUCKETS.filter(b => b !== first));
        await setExtensionStorage(context, {
            ['ilap_preset_done_ai_' + first]: DATA.rev['ai_' + first],
            ilap_preset_done_denuvo: 'an older rev',
        });
        await openPopup(page, context);
        await openDrawer(page);

        // Denuvo was run at another rev: this build's list changed since.
        await expect(row(page, 'denuvo').locator('.list-add')).toBeEnabled();
        // The finished year is skipped for the next one, and marked in the list.
        await expect(page.locator('#ai-pane .ai-year')).toHaveText(label(second));
        await page.locator('#ai-pane .ai-year').click();
        await expect(page.locator(`.ai-opt[data-bucket="${first}"]`)).toHaveClass(/is-done/);
        await expect(page.locator(`.ai-opt[data-bucket="${first}"] .ai-opt-mark`)).toHaveText('✓');
        await expect(page.locator(`.ai-opt[data-bucket="${second}"]`)).not.toHaveClass(/is-done/);
        // Picked anyway, the done year shows its state in place of the +.
        await page.locator(`.ai-opt[data-bucket="${first}"]`).click();
        await expect(row(page, 'ai_' + first).locator('.list-state')).toHaveText('✓ Ignored');
    });

    test('an Undo that takes a list\'s mark off offers the list again in an open drawer', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_preset_done_denuvo: DATA.rev.denuvo });
        await openPopup(page, context);
        await openDrawer(page);
        await expect(row(page, 'denuvo').locator('.list-state')).toHaveText('✓ Ignored');

        // What the drainer does on a rollback of one of its games (DoneMarks.unmarkPresets).
        await page.evaluate(() => new Promise(r => chrome.storage.local.remove('ilap_preset_done_denuvo', r)));
        await expect(row(page, 'denuvo').locator('.list-add')).toBeEnabled();
    });

    test('a list paused halfway and removed is offered again and queues afresh', async ({ page, context }) => {
        await openPopup(page, context);
        await openDrawer(page);
        await row(page, 'denuvo').locator('.list-add').click();
        await expect.poll(async () => (await readQueue(context)).length).toBe(1);
        const [first] = await readQueue(context);
        // Halfway through, as a drainer would have left it.
        await setExtensionStorage(context, { ['ilap_curator_cursor_' + first.id]: Math.floor(first.total / 2) });

        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer')).not.toHaveClass(/sliding/);
        await page.locator('.queue-act[data-act="pause"]').click();
        await page.locator('.queue-act[data-act="remove"]').click();
        await page.locator('.queue-act[data-act="confirm"]').click();
        await expect.poll(async () => (await readQueue(context)).length).toBe(0);

        const keys = Object.keys(await getExtensionStorage(context, null));
        expect(keys.filter(k => k.startsWith('ilap_preset_done_'))).toEqual([]);

        // The queue rolls up off the lists, which stayed open under it.
        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer')).toBeHidden();
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        const add = row(page, 'denuvo').locator('.list-add');
        await expect(add).toBeEnabled();
        await add.click();

        await expect.poll(async () => (await readQueue(context)).length).toBe(1);
        const [second] = await readQueue(context);
        expect(second.presetKey).toBe('denuvo');
        expect(second.id).not.toBe(first.id);
        expect(second.status).toBe('pending');
        const cursor = await getExtensionStorage(context, 'ilap_curator_cursor_' + second.id);
        expect(cursor['ilap_curator_cursor_' + second.id]).toBeUndefined();
    });

    test('a list already in the queue says so in place of the +', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [queuedJob('denuvo')] });
        await openPopup(page, context);
        await openDrawer(page);
        await expect(row(page, 'denuvo')).toHaveClass(/is-queued/);
        await expect(row(page, 'denuvo').locator('.list-state.is-queued')).toHaveAttribute('aria-label', 'In queue');
        await expect(row(page, 'denuvo').locator('.list-add')).toHaveCount(0);
    });

    test('a queued list shows a ✓ in the +\'s place, drawn in once, and keeps its colour; its year shows it too', async ({ page, context }) => {
        await openPopup(page, context);
        await openDrawer(page);
        const add = row(page, 'denuvo').locator('.list-add');
        const slot = await add.boundingBox();
        await add.click();
        const mark = row(page, 'denuvo').locator('.list-state.is-queued');
        await expect(mark).toHaveAttribute('aria-label', 'In queue');
        await expect(mark).toHaveClass(/fresh/);
        expect(await mark.locator('path').evaluate(el => getComputedStyle(el).animationName)).toBe('ilap-check-draw');
        // Where the + was, as wide: the row keeps its layout.
        const box = await mark.boundingBox();
        expect(Math.abs((box.x + box.width) - (slot.x + slot.width))).toBeLessThan(1);
        expect(Math.abs(box.width - slot.width)).toBeLessThan(1);
        // Not run yet, so the name is not greyed as a finished list's is.
        expect(await row(page, 'denuvo').locator('.list-name').evaluate(el => getComputedStyle(el).color)).toBe('rgb(199, 213, 224)');

        // A redraw (an AI year queued elsewhere) keeps the ✓ still.
        const other = BUCKETS.find(b => b !== DEFAULT);
        await setExtensionStorage(context, { ilap_curator_queue: (await readQueue(context)).concat([queuedJob('ai_' + other)]) });
        await page.locator('#ai-pane .ai-year').click();
        const year = page.locator(`.ai-opt[data-bucket="${other}"]`);
        await expect(year.locator('.ai-opt-mark.is-queued')).toHaveAttribute('aria-label', 'In queue');
        await expect(year.locator('.ai-opt-mark svg')).toHaveCount(1);
        await expect(year).not.toHaveClass(/is-done/);
        await expect(mark).not.toHaveClass(/fresh/);
    });

    test('an open drawer takes the + off a list queued elsewhere', async ({ page, context }) => {
        await openPopup(page, context);
        await openDrawer(page);
        await expect(row(page, 'denuvo').locator('.list-add')).toBeEnabled();

        // Another tab, or the curator page, queues the same list.
        await setExtensionStorage(context, { ilap_curator_queue: [queuedJob('denuvo')] });
        await expect(row(page, 'denuvo').locator('.list-state.is-queued')).toHaveAttribute('aria-label', 'In queue');
        await expect(row(page, 'ai_' + DEFAULT).locator('.list-add')).toBeEnabled();
    });

    test('a full queue takes no list and says so', async ({ page, context }) => {
        const jobs = [1, 2, 3].map(n => ({
            id: 'job_' + n, type: 'curator', curatorId: String(n), curatorName: 'C' + n,
            filter: 'not_recommended', appids: ['1'], total: 1, status: 'paused',
        }));
        await setExtensionStorage(context, { ilap_curator_queue: jobs });
        await openPopup(page, context);
        await openDrawer(page);
        await row(page, 'ai_' + DEFAULT).locator('.list-add').click();

        await expect(page.locator('#ai-pane .list-msg')).toHaveText('Not added — the queue is full');
        expect((await readQueue(context)).map(j => j.id)).toEqual(['job_1', 'job_2', 'job_3']);
    });

    test('+ flies the row into the job count, which counts it once it lands', async ({ page, context }) => {
        await openPopup(page, context);
        await openDrawer(page);
        await row(page, 'denuvo').locator('.list-add').click();
        // In flight: a copy of the row, inert, while the count still says 0.
        const ghost = page.locator('.list-ghost');
        await expect(ghost).toHaveCount(1);
        await expect(ghost).toHaveText(/Denuvo/);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('0');
        expect(await ghost.evaluate(el => el.inert && el.querySelectorAll('[data-key], [role], [id], [aria-label]').length === 0)).toBe(true);
        // Landed: the copy is gone and the count has the list.
        await expect(ghost).toHaveCount(0);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('1');
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
    });

    test('the year list unfolds and folds as it fades, is out of reach once shut, and a click elsewhere shuts it', async ({ page, context }) => {
        await openPopup(page, context);
        await openDrawer(page);
        const years = page.locator('.ai-years');
        const moves = await years.evaluate(el => getComputedStyle(el).transitionProperty);
        expect(moves).toContain('opacity');
        expect(moves).toContain('grid-template-rows');
        const before = await row(page, 'denuvo').boundingBox();
        await page.locator('#ai-pane .ai-year').click();
        await expect(years).toHaveClass(/open/);
        // Over the rows: they stay where they were.
        expect(await row(page, 'denuvo').boundingBox()).toEqual(before);
        await page.locator('#popup-root').click({ position: { x: 5, y: 5 } });
        await expect(years).not.toHaveClass(/open/);
        // Out of reach once the fold is over.
        await expect.poll(() => years.evaluate(el => getComputedStyle(el).visibility)).toBe('hidden');
        await expect(years).toBeHidden();
        expect(await row(page, 'denuvo').boundingBox()).toEqual(before);
        // The drawer itself stays out.
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
    });
});

// The blue dot (ListPanes _dot, DoneMarks.presetMarks): a list the user ran to
// its end at an older version of it than this build ships, so a run would
// ignore its new games. Its done mark keeps the rev it ran at. Dismissed, the
// dot stays away until the list changes again (ilap_preset_seen_<key>).
test.describe('Popup — built-in lists changed since they were run', () => {
    test.skip(BUCKETS.length < 2 || DATA.denuvo.length === 0 || !DATA.bad || !DATA.vr,
        'needs two AI years and the Denuvo, VR and Known bad lists in data/presets.json');

    const OLD = 'older00';
    const TIP = 'This list changed after you ran it. Run it again to ignore the new games.';
    const done = (key) => 'ilap_preset_done_' + key;
    const seen = (key) => 'ilap_preset_seen_' + key;
    const dot = (page, key) => row(page, key).locator('.list-dot');
    const OTHER = startBucket(BUCKETS.filter(b => b !== DEFAULT));

    test('a list run at an older version has a dot by its name, and so has its year in the year list', async ({ page, context }) => {
        await setExtensionStorage(context, {
            [done('denuvo')]: OLD,
            // An AI list's keep tags are cut off before the compare.
            [done('ai_' + OTHER)]: OLD + '+t',
            [done('vr')]: DATA.rev.vr,
            // A list this build no longer ships.
            [done('ai_1999')]: OLD,
        });
        await openPopup(page, context);
        await openDrawer(page);

        await expect(dot(page, 'denuvo')).toBeVisible();
        await expect(dot(page, 'denuvo')).toHaveAttribute('aria-label', TIP);
        await expect(row(page, 'denuvo').locator('.list-add')).toBeEnabled();
        // Right after the name, where the row's gap would be.
        const name = await row(page, 'denuvo').locator('.list-name').boundingBox();
        const box = await dot(page, 'denuvo').boundingBox();
        expect(Math.abs(box.x - (name.x + name.width))).toBeLessThanOrEqual(1);
        // Done at this version: no dot. Only Denuvo has one among the whole lists.
        await expect(row(page, 'vr')).toHaveClass(/is-done/);
        await expect(page.locator('#lists-pane .list-dot')).toHaveCount(1);

        // The AI row starts on a year with no dot, the other year has one in the list.
        await expect(dot(page, 'ai_' + DEFAULT)).toHaveCount(0);
        await page.locator('#ai-pane .ai-year').click();
        await expect(page.locator('.ai-years')).toHaveClass(/open/);
        await expect(page.locator(`.ai-opt[data-bucket="${OTHER}"] .ai-opt-dot`)).toBeVisible();
        await expect(page.locator('.ai-opt-dot')).toHaveCount(1);
        await page.locator(`.ai-opt[data-bucket="${OTHER}"]`).click();
        await expect(dot(page, 'ai_' + OTHER)).toBeVisible();
    });

    test('the dot grows in as it fades in, once, and stays put through a redraw', async ({ page, context }) => {
        await setExtensionStorage(context, { [done('denuvo')]: OLD });
        await openPopup(page, context);
        await openDrawer(page);
        const inner = dot(page, 'denuvo').locator('.list-dot-in');
        expect(await inner.evaluate(el => getComputedStyle(el).animationName)).toBe('ilap-dot-in');
        // A redraw (another list queued elsewhere) keeps the dot as it is.
        await setExtensionStorage(context, { ilap_curator_queue: [queuedJob('vr')] });
        await expect(row(page, 'vr').locator('.list-state.is-queued')).toHaveAttribute('aria-label', 'In queue');
        await expect(dot(page, 'denuvo')).toHaveClass(/kept/);
        expect(await inner.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    });

    test('its tip shows on hover and on keyboard focus, inside the drawer, over or under the row', async ({ page, context }) => {
        await setExtensionStorage(context, {
            [done('ai_' + DEFAULT)]: OLD, [done('denuvo')]: OLD, [done('bad')]: OLD,
        });
        await openPopup(page, context);
        await openDrawer(page);
        const frame = await page.locator(INNER).boundingBox();
        const inside = async (key) => {
            const tip = dot(page, key).locator('.list-dot-tip');
            await expect(tip).toBeVisible();
            await expect(tip).toHaveText(TIP);
            await expect.poll(() => tip.evaluate(el => getComputedStyle(el).opacity)).toBe('1');
            const b = await tip.boundingBox();
            expect(b.x).toBeGreaterThanOrEqual(frame.x);
            expect(b.x + b.width).toBeLessThanOrEqual(frame.x + frame.width);
            expect(b.y).toBeGreaterThanOrEqual(frame.y);
            expect(b.y + b.height).toBeLessThanOrEqual(frame.y + frame.height);
            return { tip: b, row: await row(page, key).boundingBox() };
        };
        await expect(dot(page, 'denuvo').locator('.list-dot-tip')).toBeHidden();
        // The top row's tip drops under it, the last row's rises over it.
        await dot(page, 'ai_' + DEFAULT).hover();
        const top = await inside('ai_' + DEFAULT);
        expect(top.tip.y).toBeGreaterThanOrEqual(top.row.y + top.row.height - 1);
        await dot(page, 'bad').hover();
        const last = await inside('bad');
        expect(last.tip.y + last.tip.height).toBeLessThanOrEqual(last.row.y + 1);
        expect(await page.locator(INNER).evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
        await page.mouse.move(0, 0);

        // The keyboard: a tab stop before the +.
        await row(page, 'ai_' + DEFAULT).locator('.list-add').focus();
        await page.keyboard.press('Tab');
        await expect(dot(page, 'denuvo')).toBeFocused();
        await inside('denuvo');
        await page.keyboard.press('Tab');
        await expect(row(page, 'denuvo').locator('.list-add')).toBeFocused();
    });

    test('Enter on the dot takes it away and moves the focus to the row\'s +', async ({ page, context }) => {
        await setExtensionStorage(context, { [done('denuvo')]: OLD });
        await openPopup(page, context);
        await openDrawer(page);
        await row(page, 'ai_' + DEFAULT).locator('.list-add').focus();
        await page.keyboard.press('Tab');
        await expect(dot(page, 'denuvo')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(row(page, 'denuvo').locator('.list-add')).toBeFocused();
        await expect(dot(page, 'denuvo')).toHaveCount(0);
        await expect.poll(async () => (await getExtensionStorage(context, seen('denuvo')))[seen('denuvo')]).toBe(DATA.rev.denuvo);
    });

    test('a click on the dot, or on its row off the +, takes the dot away until the list changes again', async ({ page, context }) => {
        await setExtensionStorage(context, { [done('denuvo')]: OLD, [done('vr')]: OLD });
        await openPopup(page, context);
        await openDrawer(page);
        const count = await row(page, 'denuvo').locator('.list-count').boundingBox();
        const add = await row(page, 'denuvo').locator('.list-add').boundingBox();

        await dot(page, 'denuvo').click();
        // It folds away out of reach, and the rest of its row stays put.
        await expect(dot(page, 'denuvo')).toHaveClass(/leaving/);
        await expect(dot(page, 'denuvo')).toHaveCount(0);
        expect(await row(page, 'denuvo').locator('.list-count').boundingBox()).toEqual(count);
        expect(await row(page, 'denuvo').locator('.list-add').boundingBox()).toEqual(add);
        await expect.poll(async () => (await getExtensionStorage(context, seen('denuvo')))[seen('denuvo')]).toBe(DATA.rev.denuvo);

        // The row's name does it too.
        await row(page, 'vr').locator('.list-name').click();
        await expect(dot(page, 'vr')).toHaveCount(0);
        await expect.poll(async () => (await getExtensionStorage(context, seen('vr')))[seen('vr')]).toBe(DATA.rev.vr);

        // Both stay away on the next open, and both lists are still on offer.
        await page.reload();
        await page.locator('#popup-root').waitFor();
        await openDrawer(page);
        await expect(page.locator('.list-dot')).toHaveCount(0);
        await expect(row(page, 'denuvo').locator('.list-add')).toBeEnabled();
        await expect(row(page, 'vr').locator('.list-add')).toBeEnabled();

        // The next version of the list brings it back.
        await setExtensionStorage(context, { [seen('denuvo')]: 'older01' });
        await expect(dot(page, 'denuvo')).toBeVisible();
    });

    test('on the AI row the click takes the picked year\'s dot only, and the year button takes none', async ({ page, context }) => {
        await setExtensionStorage(context, { [done('ai_' + DEFAULT)]: OLD, [done('ai_' + OTHER)]: OLD });
        await openPopup(page, context);
        await openDrawer(page);
        await expect(dot(page, 'ai_' + DEFAULT)).toBeVisible();
        // The year button opens the years and leaves the dot.
        await page.locator('#ai-pane .ai-year').click();
        await expect(page.locator('.ai-years')).toHaveClass(/open/);
        await page.locator('#ai-pane .ai-year').click();
        await expect(page.locator('.ai-years')).not.toHaveClass(/open/);
        await expect(dot(page, 'ai_' + DEFAULT)).toBeVisible();

        await row(page, 'ai_' + DEFAULT).locator('.list-count').click();
        await expect(dot(page, 'ai_' + DEFAULT)).toHaveCount(0);
        await page.locator('#ai-pane .ai-year').click();
        await expect(page.locator(`.ai-opt[data-bucket="${DEFAULT}"] .ai-opt-dot`)).toHaveCount(0);
        await expect(page.locator(`.ai-opt[data-bucket="${OTHER}"] .ai-opt-dot`)).toBeVisible();
        const stored = await getExtensionStorage(context, [seen('ai_' + DEFAULT), seen('ai_' + OTHER)]);
        expect(stored).toEqual({ [seen('ai_' + DEFAULT)]: DATA.rev['ai_' + DEFAULT] });
    });

    test('+ takes the dot with it into the queue, and a run at this version brings none back', async ({ page, context }) => {
        await setExtensionStorage(context, { [done('denuvo')]: OLD });
        await openPopup(page, context);
        await openDrawer(page);
        await row(page, 'denuvo').locator('.list-add').click();
        await expect(row(page, 'denuvo').locator('.list-state.is-queued')).toHaveAttribute('aria-label', 'In queue');
        await expect(dot(page, 'denuvo')).toHaveCount(0);
        // The + dismisses nothing: the dot is gone with the queued state.
        expect(await getExtensionStorage(context, seen('denuvo'))).toEqual({});

        // The drainer ran it to its end at this version.
        await setExtensionStorage(context, { ilap_curator_queue: [], [done('denuvo')]: DATA.rev.denuvo });
        await expect(row(page, 'denuvo').locator('.list-state')).toHaveText('✓ Ignored');
        await expect(dot(page, 'denuvo')).toHaveCount(0);
    });

    test('a keep box changed since a run, or an Undo that took the mark off, brings no dot', async ({ page, context }) => {
        await setExtensionStorage(context, {
            // Run with the translation box ticked, the box now clear: offered again, no dot.
            [done('ai_' + DEFAULT)]: DATA.rev['ai_' + DEFAULT] + '+t',
            [done('denuvo')]: OLD,
        });
        await openPopup(page, context);
        await openDrawer(page);
        await expect(row(page, 'ai_' + DEFAULT).locator('.list-add')).toBeEnabled();
        await expect(dot(page, 'ai_' + DEFAULT)).toHaveCount(0);
        await expect(dot(page, 'denuvo')).toBeVisible();

        // A rollback of one of its games takes the done mark off (DoneMarks.unmarkPresets).
        await page.evaluate((k) => new Promise(r => chrome.storage.local.remove(k, r)), done('denuvo'));
        await expect(dot(page, 'denuvo')).toHaveCount(0);
        await expect(row(page, 'denuvo').locator('.list-add')).toBeEnabled();
    });

    test('reduced motion: the dot only fades in', async ({ page, context }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await setExtensionStorage(context, { [done('denuvo')]: OLD });
        await openPopup(page, context);
        await openDrawer(page);
        expect(await dot(page, 'denuvo').locator('.list-dot-in').evaluate(el => getComputedStyle(el).animationName)).toBe('ilap-dot-fade');
        await dot(page, 'denuvo').click();
        await expect(dot(page, 'denuvo')).toHaveCount(0);
    });
});
