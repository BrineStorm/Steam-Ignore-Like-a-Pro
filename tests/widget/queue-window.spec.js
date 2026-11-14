// The ignore queue in the on-page widget: the toolbar popup's slim strips
// (tests/popup/queue.spec.js) in a small window that unrolls out of the
// panel's left side from its upper right corner, its right edge on the
// panel's left one, its top level with the panel's. The lists' window, when
// out, moves down under it, and opens under it. A tab of the line shuts the
// lists' window and leaves the queue out. A click anywhere off the widget
// shuts both. Every job is a hand-seeded storage entry and
// stays paused, so nothing here ignores a real game.
//
// Playwright CSS selectors pierce the open shadow root.

const { test, expect, AUTH_FILE } = require('../_fixtures.js');
const { setExtensionStorage } = require('../_extension.js');
const fs = require('fs');

const { searchUrl } = require('../_search.js'); // random search term per navigation

test.describe.configure({ retries: 2 }); // hover/corner-driven, like the rest of the widget suite

const job = (n, over) => Object.assign({
    id: 'job_' + n, type: 'curator', curatorId: String(n), curatorName: 'Curator ' + n,
    filter: 'not_recommended', appids: Array.from({ length: 10 }, (_, i) => String(i + 1)), total: 10, status: 'paused',
}, over);

async function openPanel(page) {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(searchUrl());
    await page.locator('.ilap-chevron').click();
    await expect(page.locator('.ilap-launcher')).not.toHaveClass(/locked/);
    await page.locator('.ilap-launcher').click();
    await expect(page.locator('.ilap-panel')).toHaveClass(/open/);
}

// A click on the page's bare left margin, off the widget: it reaches no link,
// so the page stays and the widget with it.
async function clickOffWidget(page) {
    const url = page.url();
    await page.mouse.click(20, 600);
    await expect(page.locator('.ilap-panel')).not.toHaveClass(/open/);
    expect(page.url()).toBe(url);
}

async function openQueue(page) {
    await page.locator('#queue-btn').click();
    await expect(page.locator('#queue-drawer')).toHaveClass(/open/);
    await expect(page.locator('#queue-drawer')).not.toHaveClass(/sliding/);
}

test.describe('on-page widget — ignore queue window', () => {

    test.beforeEach(async () => {
        test.skip(!fs.existsSync(AUTH_FILE), 'no saved Steam session — run: npm run test:auth'); // panel is login-gated
    });

    test('the window meets the panel\'s left edge level with its top, framed all round as in the toolbar, with the strips', async ({ context, page }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [job(1)], ilap_curator_cursor_job_1: 4 });
        await openPanel(page);
        await openQueue(page);
        const panel = await page.locator('.ilap-panel #popup-root').boundingBox();
        const inner = page.locator('#queue-drawer .drawer-inner');
        const ib = await inner.boundingBox();
        expect(Math.abs(ib.x + ib.width - panel.x)).toBeLessThan(1);
        expect(Math.abs(ib.y - panel.y)).toBeLessThan(1);
        expect(ib.height).toBeLessThanOrEqual(panel.height + 0.5);
        const frame = await inner.evaluate(el => {
            const s = getComputedStyle(el);
            return [s.borderTopColor, s.borderRightStyle];
        });
        expect(frame).toEqual(['rgb(69, 161, 250)', 'solid']);
        await expect(page.locator('#queue-list')).toHaveClass(/strips/);
        await expect(page.locator('.queue-job').first().locator('.queue-job-pct')).toHaveText('40%');
    });

    // Jobs 1, 2, 5 and 6 have nothing in the ⚠ slot, 3 and 4 have the ⚠: a slot
    // filled on some strips only is what puts the bars out of line.
    test('every strip starts its mini bar at the same place, whatever the name, the glyph, the ⚠ or the percent', async ({ context, page }) => {
        const long = 'A curator whose name is far too long for the column';
        await setExtensionStorage(context, {
            ilap_curator_queue: [
                job(1, { curatorName: 'Hi' }),
                job(2, { curatorName: long }),
                job(3, { curatorName: 'Hi' }),
                job(4, { curatorName: long }),
                job(5, { id: 'job_preset_ai_earlier_2023_1', type: 'preset', curatorId: 'preset_ai_earlier_2023', presetKey: 'ai_earlier_2023', curatorName: '' }),
                job(6, { id: 'job_undo_1', type: 'undo', curatorId: 'undo', curatorName: '', scope: { n: 10 } }),
            ],
            ilap_curator_skipped_job_3: 12,
            ilap_curator_skipped_job_4: 128,
            ilap_curator_cursor_job_4: 10,
        });
        await openPanel(page);
        await openQueue(page);
        await expect(page.locator('.queue-job').nth(3).locator('.queue-job-pct')).toHaveText('100%');
        const bars = await page.locator('.queue-mini').evaluateAll(els => els.map(e => e.getBoundingClientRect().x));
        expect(bars).toHaveLength(6);
        expect(new Set(bars).size, `bars start at ${bars.join(', ')}`).toBe(1);
    });

    // The store's font runs wider than the toolbar popup's. In a window of the
    // toolbar's width this name lost its last digits here, in Russian first.
    test('the name column keeps this year\'s AI list name whole, with the ⚠ slot on the strip', async ({ context, page }) => {
        const key = 'ai_' + new Date().getFullYear();
        await setExtensionStorage(context, {
            ilap_lang: 'ru',
            ilap_curator_queue: [job(1, { id: 'job_preset_' + key + '_1', type: 'preset', curatorId: 'preset_' + key, presetKey: key, curatorName: '' })],
        });
        await openPanel(page);
        await openQueue(page);
        const [text, box] = await page.locator('.queue-job-name').evaluate(el => {
            const range = el.ownerDocument.createRange();
            range.selectNodeContents(el);
            return [range.getBoundingClientRect().width, el.getBoundingClientRect().width];
        });
        expect(text).toBeLessThanOrEqual(box);
    });

    test('it unrolls from its upper right corner, by the panel', async ({ context, page }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [job(1)] });
        await openPanel(page);
        await page.locator('#queue-btn').click();
        const from = await page.locator('#queue-drawer .drawer-inner').evaluate(el => {
            const a = el.getAnimations()[0];
            return a ? a.effect.getKeyframes()[0].clipPath : null;
        });
        expect(from).toBe('inset(0px 0px 100% 100%)');
    });

    test('the lists\' window unrolls from its lower right corner, by its button', async ({ page }) => {
        await openPanel(page);
        await page.locator('#lists-btn').click();
        // The rows are read first, so the motion starts a moment after the click.
        await expect.poll(() => page.locator('#lists-drawer .drawer-inner').evaluate(el => {
            const a = el.getAnimations().find(x => x.effect.getKeyframes()[0].clipPath);
            return a ? a.effect.getKeyframes()[0].clipPath : null;
        }), { intervals: [10] }).toBe('inset(100% 0px 0px 100%)');
    });

    test('the lists\' window moves down under it, scrolling inside over the viewport\'s bottom, and back up as it shuts; the lists button opens them under it', async ({ context, page }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [job(1), job(2)] });
        await openPanel(page);
        // A short screen, so the lists run out of room under the queue.
        await page.setViewportSize({ width: 1366, height: 480 });
        await page.locator('#lists-btn').click();
        // The rows are read first, so the slide starts a moment after the click.
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/sliding/);
        const lists = page.locator('#lists-drawer .drawer-inner');
        const before = await lists.boundingBox();
        await page.locator('#queue-btn').click();
        // It slides down as the queue unrolls.
        await expect.poll(() => lists.evaluate(el => el.getAnimations().some(a => a.effect.getKeyframes()[0].transform)),
            { intervals: [10] }).toBe(true);
        await expect(page.locator('#queue-drawer')).not.toHaveClass(/sliding/);
        await expect(lists).not.toHaveClass(/moving/);
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        const queue = await page.locator('#queue-drawer .drawer-inner').boundingBox();
        const under = await lists.boundingBox();
        expect(under.y).toBeGreaterThanOrEqual(queue.y + queue.height);
        expect(under.y + under.height).toBeLessThanOrEqual(480 - 11.5);
        expect(await lists.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer')).toBeHidden();
        await expect(lists).not.toHaveClass(/moving/);
        const after = await lists.boundingBox();
        expect(Math.abs(after.y - before.y)).toBeLessThan(1);
        expect(Math.abs(after.height - before.height)).toBeLessThan(1);
        // The lists button shuts the lists and opens them again under the
        // queue, which stays out.
        await openQueue(page);
        await page.locator('#lists-btn').click();
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/open/);
        await page.locator('#lists-btn').click();
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/sliding/);
        await expect(page.locator('#queue-drawer')).toHaveClass(/open/);
        const queueAgain = await page.locator('#queue-drawer .drawer-inner').boundingBox();
        const underAgain = await lists.boundingBox();
        expect(underAgain.y).toBeGreaterThanOrEqual(queueAgain.y + queueAgain.height);
    });

    test('any tab of the line shuts the lists\' window and leaves the queue out', async ({ context, page }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [job(1)] });
        await openPanel(page);
        await openQueue(page);
        for (const tab of ['#tab-ai', '#tab-lang', '#tab-settings']) {
            await page.locator('#lists-btn').click();
            await expect(page.locator('#lists-drawer'), tab).toHaveClass(/open/);
            await expect(page.locator('#lists-drawer')).not.toHaveClass(/sliding/);
            await page.locator(tab).click();
            await expect(page.locator('#lists-drawer'), tab).not.toHaveClass(/open/);
            await expect(page.locator('#lists-btn')).toHaveAttribute('aria-expanded', 'false');
            await expect(page.locator('#queue-drawer'), tab).toHaveClass(/open/);
            await expect(page.locator('#queue-btn')).toHaveAttribute('aria-expanded', 'true');
        }
    });

    test('a click off the widget shuts it: the panel opens again without it', async ({ context, page }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [job(1)] });
        await openPanel(page);
        await openQueue(page);
        await clickOffWidget(page);
        await page.locator('.ilap-launcher').click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);
        await expect(page.locator('#queue-drawer')).not.toHaveClass(/open/);
        await expect(page.locator('#queue-drawer')).toBeHidden();
    });

    test('a click off the widget shuts the lists\' window: the panel opens again without it, on the tab it had', async ({ page }) => {
        await openPanel(page);
        await page.locator('#tab-settings').click();
        await expect(page.locator('#tab-settings')).toHaveAttribute('aria-selected', 'true');
        await page.locator('#lists-btn').click();
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/sliding/);
        await clickOffWidget(page);
        await page.locator('.ilap-launcher').click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/open/);
        await expect(page.locator('#lists-drawer')).toBeHidden();
        await expect(page.locator('#lists-btn')).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('#tab-settings')).toHaveAttribute('aria-selected', 'true');
    });

    test('the lists button and the queue\'s icon have the open tab\'s mark while their window is out, as wide as every cell\'s', async ({ page }) => {
        await openPanel(page);
        const mark = (sel, pseudo) => page.locator(sel).evaluate((el, p) => {
            const s = getComputedStyle(el, p);
            return { w: parseFloat(s.width), opacity: s.opacity };
        }, pseudo);
        const widths = [];
        for (const id of ['#lists-btn', '#tab-ai', '#tab-lang', '#tab-settings']) widths.push((await mark(id, '::after')).w);
        expect(Math.max(...widths) - Math.min(...widths), widths.join(', ')).toBeLessThan(0.5);
        await page.locator('#lists-btn').click();
        await expect.poll(async () => (await mark('#lists-btn', '::after')).opacity).toBe('1');
        await page.locator('#queue-btn').click();
        await expect.poll(async () => (await mark('#queue-btn', '::before')).opacity).toBe('1');
        // Both windows out, both marks on.
        expect((await mark('#lists-btn', '::after')).opacity).toBe('1');
        await page.locator('#queue-btn').click();
        await expect.poll(async () => (await mark('#queue-btn', '::before')).opacity).toBe('0');
        await page.locator('#lists-btn').click();
        await expect.poll(async () => (await mark('#lists-btn', '::after')).opacity).toBe('0');
    });

    test('the job count sits in a square', async ({ context, page }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [job(1)] });
        await openPanel(page);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('1');
        await expect(page.locator('#queue-jobs-chip')).toHaveCSS('border-radius', '4px');
    });
});
