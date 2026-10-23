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

// The built-in ignore lists (ui/popup_presets.js): the icon on the queue bar,
// its menu and the jobs it stages. Driven through the popup window only. No
// Steam page is open and the test build's service worker is empty, so a staged
// job is never drained and nothing here ignores a real game.
//
// Expectations come from the shipped data/presets.json, so the spec holds for
// whatever lists a release ships.

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'presets.json'), 'utf8'));
// The menu's order: the upcoming years soonest first, then 'tba', then the
// released years newest first, then the older ones together.
function rank(b) {
    const up = /^upcoming_(\d{4})/.exec(b);
    if (up) return [0, +up[1]];
    if (b === 'tba') return [1, 0];
    if (/^\d{4}$/.test(b)) return [2, -b];
    return [3, 0];
}
const BUCKETS = Object.keys(DATA.ai).sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1]);
// The year the menu starts on among the open ones: this year's released games,
// or the nearest released year (the newer of two as near), or the first open
// bucket when no released year is open.
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
// The lists that ship whole, in the menu's order, and their English names.
const FLAT_NAME = {
    denuvo: 'Denuvo DRM', anticheat: 'Kernel-level anti-cheat', iap: 'In-App Purchases', vr: 'Every VR game',
};
const FLAT = Object.keys(FLAT_NAME).filter(k => Array.isArray(DATA[k]) && DATA[k].length > 0);

async function openPopup(page, context) {
    const extId = await getExtensionId(context);
    await page.goto(popupUrl(extId));
    await page.locator('#popup-root').waitFor({ timeout: 5000 });
}

async function openMenu(page) {
    await page.locator('#preset-chip').click();
    await expect(page.locator('#preset-menu')).toHaveClass(/open/);
}

async function readQueue(context) {
    const res = await getExtensionStorage(context, 'ilap_curator_queue');
    return Array.isArray(res.ilap_curator_queue) ? res.ilap_curator_queue : [];
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Popup — built-in ignore lists', () => {
    test.skip(BUCKETS.length < 2 || DATA.denuvo.length === 0,
        'needs two AI years and a Denuvo list in data/presets.json');

    test('the menu opens at its full width from its first frame', async ({ page, context }) => {
        // The icon sinks on press. Were that a transform on the icon itself, the
        // icon would be the menu's containing block for as long as it lasted,
        // and the menu, stretched across the bar, opened as a sliver of the
        // icon's width for a few frames. Every frame is sampled, not the end state.
        await openPopup(page, context);
        await page.evaluate(() => {
            const menu = document.getElementById('preset-menu');
            window.__widths = [];
            const t0 = performance.now();
            const tick = () => {
                if (menu.classList.contains('open')) window.__widths.push(menu.getBoundingClientRect().width);
                if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
        const box = await page.locator('#preset-chip').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(100);
        await page.mouse.up();
        await expect(page.locator('#preset-menu')).toHaveClass(/open/);
        await page.waitForTimeout(1000);

        const widths = await page.evaluate(() => window.__widths);
        const bar = await page.locator('#queue-accordion > summary').boundingBox();
        expect(widths.length).toBeGreaterThan(0);
        expect(Math.min(...widths)).toBeGreaterThan(bar.width / 2);
    });

    test('the menu fits under the panel top with one gesture hint line, in every locale', async ({ page, context }) => {
        // The menu opens upward over the panel. With Already played off the hint
        // card loses a line, the bar moves up, and a taller menu ran its title
        // out of the toolbar window. Greek wraps the AI row, Japanese has the
        // tallest lines.
        await setExtensionStorage(context, { ilap_platform_key: 'off' });
        await openPopup(page, context);
        const locales = await page.evaluate(() =>
            window.ILAP.i18n.getLanguages().filter(l => l.translated).map(l => l.code));
        for (const code of locales) {
            await setExtensionStorage(context, { ilap_lang: code });
            await expect(page.locator('#lang-quick')).toHaveValue(code);
            await openMenu(page);
            await page.waitForTimeout(300);
            const top = await page.locator('#preset-menu').evaluate(m => m.getBoundingClientRect().top);
            expect(top, `the lists menu stays inside the window (${code})`).toBeGreaterThanOrEqual(0);
            await page.locator('#preset-chip').click();
            await expect(page.locator('#preset-menu')).not.toHaveClass(/open/);
        }
    });

    test('the menu offers the AI list from the newest year, then the whole lists', async ({ page, context }) => {
        await openPopup(page, context);
        await openMenu(page);

        const ai = page.locator('.preset-opt[data-list="ai"]');
        await expect(ai).toHaveClass(/selected/);
        await expect(ai.locator('.preset-year')).toHaveText(label(DEFAULT));
        await expect(page.locator('.preset-opt .preset-name')).toHaveText(
            ['AI-generated content', ...FLAT.map(k => FLAT_NAME[k])]);
        await expect(page.locator('#preset-go')).toBeEnabled();

        await ai.locator('.preset-year').click();
        await expect(page.locator('.preset-years .select-opt')).toHaveText(BUCKETS.map(label));
    });

    test('Add queues the picked year as its own job, the menu staying open', async ({ page, context }) => {
        await openPopup(page, context);
        await openMenu(page);
        const bucket = BUCKETS[1];
        await page.locator('.preset-year').click();
        await page.locator(`.preset-years [data-bucket="${bucket}"]`).click();
        await page.locator('#preset-go').click();

        await expect.poll(async () => (await readQueue(context)).length).toBe(1);
        const [job] = await readQueue(context);
        expect(job).toMatchObject({
            type: 'preset', curatorId: 'preset_ai_' + bucket, presetKey: 'ai_' + bucket,
            presetRev: DATA.rev['ai_' + bucket], status: 'pending',
            appids: DATA.ai[bucket].map(String), total: DATA.ai[bucket].length,
        });

        // The menu stays open and the queue is not opened for it: the list
        // flies into the job count, which then counts it.
        await expect(page.locator('#preset-menu')).toHaveClass(/open/);
        await expect(page.locator('#queue-accordion')).not.toHaveAttribute('open', '');
        await expect(page.locator('#queue-jobs-chip')).toHaveText('1');
        await page.locator('#queue-accordion > summary .summary-title').click();
        await expect(page.locator('.queue-job-name')).toHaveText(jobName(bucket));
        await expect(page.locator('.queue-job-glyph')).toBeVisible();
    });

    test('the keyboard opens the menu, picks a year and adds it', async ({ page, context }) => {
        await openPopup(page, context);
        await page.locator('#preset-chip').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#preset-menu')).toHaveClass(/open/);
        await expect(page.locator('#queue-accordion')).not.toHaveAttribute('open', '');

        const bucket = BUCKETS[1];
        await page.locator('.preset-year').focus();
        await page.keyboard.press('Enter');
        const row = page.locator(`.preset-years [data-bucket="${bucket}"]`);
        await expect(row).toHaveAttribute('tabindex', '0');
        await row.focus();
        await page.keyboard.press(' ');
        // The years list closed with the pick, so focus moved to Add.
        await expect(page.locator('.preset-year')).toHaveText(label(bucket));
        await expect(page.locator('#preset-go')).toBeFocused();
        await page.keyboard.press('Enter');

        await expect.poll(async () => (await readQueue(context)).map(j => j.presetKey)).toEqual(['ai_' + bucket]);
    });

    test('a triple click on Add queues the list once', async ({ page, context }) => {
        // Add goes off while the list goes in, and stays off once it is queued.
        // Both a triple click and three quick separate presses land one job.
        await openPopup(page, context);
        await openMenu(page);
        await page.locator('.preset-opt[data-list="denuvo"]').click();
        await page.locator('#preset-go').click({ clickCount: 3 });
        await expect.poll(async () => (await readQueue(context)).map(j => j.presetKey)).toEqual(['denuvo']);
        await expect(page.locator('#preset-go')).toBeDisabled();

        await page.locator(`.preset-opt[data-list="${FLAT[1]}"]`).click();
        const box = await page.locator('#preset-go').boundingBox();
        for (let i = 0; i < 3; i++) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(40);
        }
        await expect.poll(async () => (await readQueue(context)).map(j => j.presetKey)).toEqual(['denuvo', FLAT[1]]);
        await page.waitForTimeout(800);
        expect((await readQueue(context)).map(j => j.presetKey)).toEqual(['denuvo', FLAT[1]]);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('2');
    });

    test('Enter held on Add queues one list, its auto-repeat queues nothing', async ({ page, context }) => {
        // Held on the icon, then on a year row and then on Add: the menu opens
        // once, the year is picked and focus lands on Add, and still only the
        // presses that are not repeats count.
        await openPopup(page, context);
        await page.locator('#preset-chip').focus();
        await page.keyboard.down('Enter');
        for (let i = 0; i < 5; i++) { await page.waitForTimeout(60); await page.keyboard.down('Enter'); }
        await page.keyboard.up('Enter');
        await expect(page.locator('#preset-menu')).toHaveClass(/open/);

        await page.locator('#preset-go').focus();
        for (let i = 0; i < 8; i++) { await page.keyboard.down('Enter'); await page.waitForTimeout(60); }
        await page.keyboard.up('Enter');
        await page.waitForTimeout(800);
        expect((await readQueue(context)).map(j => j.presetKey)).toEqual(['ai_' + DEFAULT]);
    });

    test('Denuvo is queued whole', async ({ page, context }) => {
        await openPopup(page, context);
        await openMenu(page);
        await page.locator('.preset-opt[data-list="denuvo"]').click();
        await page.locator('#preset-go').click();

        await expect.poll(async () => (await readQueue(context)).map(j => j.presetKey)).toEqual(['denuvo']);
        await expect(page.locator('.queue-job-name')).toHaveText('Denuvo DRM');
    });

    test('each whole list queues as its own job under its name', async ({ page, context }) => {
        // Three jobs fill the queue.
        const queued = FLAT.slice(0, 3);
        await openPopup(page, context);
        for (const key of queued) {
            await openMenu(page);
            await page.locator(`.preset-opt[data-list="${key}"]`).click();
            await page.locator('#preset-go').click();
            await expect.poll(async () => (await readQueue(context)).map(j => j.presetKey)).toContain(key);
            // The menu stays open after Add: close it before the next round.
            await page.locator('#popup-root').click({ position: { x: 5, y: 5 } });
            await expect(page.locator('#preset-menu')).not.toHaveClass(/open/);
        }
        await expect.poll(async () => (await readQueue(context)).map(j => j.presetKey)).toEqual(queued);
        const jobs = await readQueue(context);
        queued.forEach((key, i) => expect(jobs[i]).toMatchObject({
            presetKey: key, presetRev: DATA.rev[key], appids: DATA[key].map(String), total: DATA[key].length,
        }));
        await expect(page.locator('.queue-job-name')).toHaveText(queued.map(k => FLAT_NAME[k]));
    });

    test('a list run to its end in this version is greyed out, an updated one is offered again', async ({ page, context }) => {
        // The year the menu would start on is done: it starts on the nearest open one.
        const first = DEFAULT;
        const second = startBucket(BUCKETS.filter(b => b !== first));
        await setExtensionStorage(context, {
            ['ilap_preset_done_ai_' + first]: DATA.rev['ai_' + first],
            ilap_preset_done_denuvo: 'an older rev',
        });
        await openPopup(page, context);
        await openMenu(page);

        // Denuvo was run at another rev: this build's list changed since.
        await expect(page.locator('.preset-opt[data-list="denuvo"]')).not.toHaveClass(/disabled/);
        // The finished year is skipped for the next one, and greyed in the list.
        await expect(page.locator('.preset-year')).toHaveText(label(second));
        await page.locator('.preset-year').click();
        await expect(page.locator(`.preset-years [data-bucket="${first}"]`)).toHaveClass(/disabled/);
        await expect(page.locator(`.preset-years [data-bucket="${second}"]`)).not.toHaveClass(/disabled/);
        // The open years drop over the whole lists, which stay in view.
        await expect(page.locator('.preset-opt[data-list="denuvo"]')).toBeVisible();
    });

    test('a list paused halfway and removed is offered again and queues afresh', async ({ page, context }) => {
        await openPopup(page, context);
        await openMenu(page);
        await page.locator('.preset-opt[data-list="denuvo"]').click();
        await page.locator('#preset-go').click();
        await expect.poll(async () => (await readQueue(context)).length).toBe(1);
        const [first] = await readQueue(context);
        // Halfway through, as a drainer would have left it.
        await setExtensionStorage(context, { ['ilap_curator_cursor_' + first.id]: Math.floor(first.total / 2) });

        await page.locator('#queue-accordion > summary .summary-title').click();
        await page.locator('.queue-act[data-act="pause"]').click();
        await page.locator('.queue-act[data-act="remove"]').click();
        await page.locator('.queue-act[data-act="confirm"]').click();
        await expect.poll(async () => (await readQueue(context)).length).toBe(0);

        const keys = Object.keys(await getExtensionStorage(context, null));
        expect(keys.filter(k => k.startsWith('ilap_preset_done_'))).toEqual([]);

        await openMenu(page);
        const denuvo = page.locator('.preset-opt[data-list="denuvo"]');
        await expect(denuvo).not.toHaveClass(/disabled/);
        await denuvo.click();
        await expect(page.locator('#preset-go')).toBeEnabled();
        await page.locator('#preset-go').click();

        await expect.poll(async () => (await readQueue(context)).length).toBe(1);
        const [second] = await readQueue(context);
        expect(second.presetKey).toBe('denuvo');
        expect(second.id).not.toBe(first.id);
        expect(second.status).toBe('pending');
        const cursor = await getExtensionStorage(context, 'ilap_curator_cursor_' + second.id);
        expect(cursor['ilap_curator_cursor_' + second.id]).toBeUndefined();
    });

    test('a list already in the queue is greyed out', async ({ page, context }) => {
        await setExtensionStorage(context, {
            ilap_curator_queue: [{
                id: 'job_preset_denuvo_1', type: 'preset', curatorId: 'preset_denuvo', presetKey: 'denuvo',
                appids: ['1'], total: 1, status: 'paused',
            }],
        });
        await openPopup(page, context);
        await openMenu(page);
        const denuvo = page.locator('.preset-opt[data-list="denuvo"]');
        await expect(denuvo).toHaveClass(/disabled/);
        await expect(denuvo).toHaveAttribute('aria-disabled', 'true');
        // Forced: Playwright will not click an aria-disabled row by itself, and
        // the point is that a click there does nothing.
        await denuvo.click({ force: true });
        await expect(denuvo).not.toHaveClass(/selected/);
    });

    test('an open menu greys a list queued elsewhere and moves off it', async ({ page, context }) => {
        await openPopup(page, context);
        await openMenu(page);
        const denuvo = page.locator('.preset-opt[data-list="denuvo"]');
        await denuvo.click();
        await expect(denuvo).toHaveClass(/selected/);

        // Another tab, or the curator page, queues the same list.
        await setExtensionStorage(context, {
            ilap_curator_queue: [{
                id: 'job_preset_denuvo_1', type: 'preset', curatorId: 'preset_denuvo', presetKey: 'denuvo',
                appids: ['1'], total: 1, status: 'paused',
            }],
        });
        await expect(denuvo).toHaveClass(/disabled/);
        await expect(page.locator('.preset-opt[data-list="ai"]')).toHaveClass(/selected/);
        await expect(page.locator('#preset-go')).toBeEnabled();
    });

    test('a full queue takes no list and says so', async ({ page, context }) => {
        const jobs = [1, 2, 3].map(n => ({
            id: 'job_' + n, type: 'curator', curatorId: String(n), curatorName: 'C' + n,
            filter: 'not_recommended', appids: ['1'], total: 1, status: 'paused',
        }));
        await setExtensionStorage(context, { ilap_curator_queue: jobs });
        await openPopup(page, context);
        await openMenu(page);
        await page.locator('#preset-go').click();

        await expect(page.locator('.preset-msg')).toHaveText('Not added — the queue is full');
        expect((await readQueue(context)).map(j => j.id)).toEqual(['job_1', 'job_2', 'job_3']);
    });

    test('the menu fits under the top of the empty popup in every locale', async ({ page, context }) => {
        // It opens upward with only the header above it, and every list added
        // is one more row. Checked with the years list open and closed.
        test.setTimeout(2 * 60 * 1000);
        await openPopup(page, context);
        const locales = await page.evaluate(() =>
            window.ILAP.i18n.getLanguages().filter(l => l.translated).map(l => l.code));
        const root = await page.locator('#popup-root').boundingBox();
        for (const code of locales) {
            await setExtensionStorage(context, { ilap_lang: code });
            await expect(page.locator('#lang-quick')).toHaveValue(code);
            await openMenu(page);
            for (const state of ['closed', 'open']) {
                if (state === 'open') await page.locator('.preset-year').click();
                const box = await page.locator('#preset-menu').boundingBox();
                expect(box.y, `menu cut off at the top (${code}, years ${state})`).toBeGreaterThanOrEqual(root.y);
            }
            await page.locator('#popup-root').click({ position: { x: 5, y: 5 } });
            await expect(page.locator('#preset-menu')).not.toHaveClass(/open/);
        }
    });

    test('Add flies the picked row into the job count, which counts it once it lands', async ({ page, context }) => {
        await openPopup(page, context);
        await openMenu(page);
        await page.locator('.preset-opt[data-list="denuvo"]').click();
        await page.locator('#preset-go').click();
        // In flight: a copy of the row, inert, while the count still says 0.
        const ghost = page.locator('.preset-ghost');
        await expect(ghost).toHaveCount(1);
        await expect(ghost).toHaveText(/Denuvo/);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('0');
        expect(await ghost.evaluate(el => el.querySelectorAll('[data-list], [role], [id]').length)).toBe(0);
        // Landed: the copy is gone and the count has the list.
        await expect(ghost).toHaveCount(0);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('1');
        await expect(page.locator('#preset-menu')).toHaveClass(/open/);
    });

    test('the selected row\'s highlight slides to the row picked', async ({ page, context }) => {
        await openPopup(page, context);
        await openMenu(page);
        const hl = page.locator('.preset-hl');
        const top = () => hl.evaluate(el => parseFloat(el.style.top));
        const rowTop = (key) => page.locator(`.preset-opt[data-list="${key}"]`).evaluate((row) => {
            const m = row.closest('.preset-menu');
            return row.getBoundingClientRect().top - m.getBoundingClientRect().top - m.clientTop;
        });
        await expect(hl).toBeVisible();
        expect(Math.abs(await top() - await rowTop('ai'))).toBeLessThan(1);
        await page.locator('.preset-opt[data-list="vr"]').click();
        // It moves by a transition, from where it stood.
        await expect(page.locator('.preset-hl')).toHaveClass(/moving/);
        expect(await page.locator('.preset-hl').evaluate(el => getComputedStyle(el).transitionProperty)).toContain('top');
        await expect.poll(async () => Math.abs(await top() - await rowTop('vr'))).toBeLessThan(1);
    });

    test('the menu fades in and out, and is out of reach once shut', async ({ page, context }) => {
        await openPopup(page, context);
        await openMenu(page);
        const menu = page.locator('#preset-menu');
        expect(await menu.evaluate(el => getComputedStyle(el).transitionProperty)).toContain('opacity');
        await page.locator('#popup-root').click({ position: { x: 5, y: 5 } });
        await expect(menu).not.toHaveClass(/open/);
        await expect(menu).toBeHidden();
        expect(await menu.evaluate(el => getComputedStyle(el).visibility)).toBe('hidden');
    });

    test('Add sits in the lower right corner, as wide as its label', async ({ page, context }) => {
        await openPopup(page, context);
        await openMenu(page);
        const menu = await page.locator('#preset-menu').boundingBox();
        const go = await page.locator('#preset-go').boundingBox();
        // The menu's 8px padding and 1px border.
        expect(Math.abs(menu.x + menu.width - 9 - (go.x + go.width))).toBeLessThan(1.5);
        expect(go.width).toBeLessThan(menu.width / 2 + 40);
    });

    test('the years list keeps the menu\'s height and leaves the lists in view', async ({ page, context }) => {
        await openPopup(page, context);
        await openMenu(page);
        const height = () => page.locator('#preset-menu').evaluate(el => el.getBoundingClientRect().height);
        const closed = await height();
        await page.locator('.preset-year').click();
        await expect(page.locator('.preset-years')).toBeVisible();
        expect(await height()).toBe(closed);
        await expect(page.locator('.preset-opt[data-list="vr"]')).toBeVisible();
    });

    test('the AI row starts on this year, or the nearest year still open', async ({ page, context }) => {
        await openPopup(page, context);
        await openMenu(page);
        await expect(page.locator('.preset-year')).toHaveText(label(DEFAULT));
    });

    test('the tooltip hangs under the bar, and once the icon is used it stays down until the pointer leaves', async ({ page, context }) => {
        await openPopup(page, context);
        const tip = page.locator('#preset-tip');
        const chip = page.locator('#preset-chip');
        await chip.hover();
        await expect(tip).toBeVisible({ timeout: 4000 });
        const bar = await page.locator('#queue-accordion > summary').boundingBox();
        const box = await tip.boundingBox();
        expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height);
        const root = await page.locator('#popup-root').boundingBox();
        expect(box.x + box.width).toBeLessThanOrEqual(root.x + root.width);

        await chip.click({ position: { x: 4, y: 4 } });
        await expect(tip).toBeHidden();
        await chip.click({ position: { x: 4, y: 4 } });
        await expect(page.locator('#preset-menu')).not.toHaveClass(/open/);
        await page.waitForTimeout(2600);
        await expect(tip).toBeHidden();

        await page.mouse.move(5, 5);
        await chip.hover();
        await expect(tip).toBeVisible({ timeout: 4000 });
    });

    test('a click elsewhere closes the menu, and the icon never toggles the bar', async ({ page, context }) => {
        await openPopup(page, context);
        await openMenu(page);
        await expect(page.locator('#queue-accordion')).not.toHaveAttribute('open', '');
        await page.locator('#popup-root').click({ position: { x: 5, y: 5 } });
        await expect(page.locator('#preset-menu')).not.toHaveClass(/open/);
    });
});
