// No scrollbar in the on-page widget unless its content really outgrows the
// room it has (a scrollbar that flashes is a bug). The panel caps
// itself to the viewport and scrolls (src/widget/main.js), so a single pixel
// sticking out of it (an underline hung under the tab line, a hidden tooltip
// past its edge) puts a scrollbar on its right in the plain open state. At a
// common laptop viewport nothing here is tall enough to scroll: each state is
// checked once it has settled, and the moves between them frame by frame.
// Every box of the shadow root that can scroll is watched, the menus and the
// year list too. The main states run again at Windows' 125 % and 150 %
// display scaling (a fraction of a pixel rounds another way there), and the
// tabs and the lists in every interface language (a longer label wraps).
//
// Playwright CSS selectors pierce the open shadow root.

const { test, expect, AUTH_FILE } = require('../_fixtures.js');
const { setExtensionStorage } = require('../_extension.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { searchUrl } = require('../_search.js'); // random search term per navigation

test.describe.configure({ retries: 2 }); // hover/corner-driven, like the rest of the widget suite

// The shipped interface languages, from src/i18n.js itself.
const LOCALES = (() => {
    const sandbox = { window: {}, navigator: { language: 'en' }, document: { documentElement: {} } };
    vm.createContext(sandbox);
    for (const f of ['escape.js', 'i18n.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', f), 'utf8'), sandbox);
    }
    return sandbox.window.ILAP.i18n.getLanguages().filter(l => l.translated).map(l => l.code);
})();

// In the page: the boxes of the shadow root that scroll right now. A box
// scrolls when it shows and has more content than room on an axis it may
// scroll on (overflow auto or scroll). The panel is 'panel', the drawers' blocks
// 'lists' and 'queue', any other box its id or first class.
function scrollBoxes() {
    const root = document.getElementById('ilap-widget-host').shadowRoot;
    const name = (el) => el.id === 'popup-root' ? 'panel'
        : el.classList.contains('drawer-inner') && el.closest('#lists-drawer') ? 'lists'
        : el.classList.contains('drawer-inner') && el.closest('#queue-drawer') ? 'queue'
        : el.id || String(el.className).split(' ')[0] || el.tagName;
    const out = [];
    for (const el of root.querySelectorAll('*')) {
        const s = getComputedStyle(el);
        const may = (o) => o === 'auto' || o === 'scroll';
        if (!may(s.overflowY) && !may(s.overflowX)) continue;
        if (s.visibility === 'hidden' || !el.getClientRects().length || !el.clientHeight) continue;
        if ((may(s.overflowY) && el.scrollHeight > el.clientHeight)
            || (may(s.overflowX) && el.scrollWidth > el.clientWidth)) out.push(name(el));
    }
    return out;
}

// Every scroll box of the panel that scrolls right now, by name.
const scrolling = (page) => page.evaluate(scrollBoxes);

// Samples the same boxes every frame for `ms` while `act` runs: the names of
// the boxes that scrolled on any frame. Each sample is taken just after its
// frame was drawn: in the frame's own animation callback the layout is not
// yet the one drawn (a ResizeObserver that resizes a box runs later in the
// same frame). An expression, so scrollBoxes goes in as source (Steam's CSP
// has no eval).
async function scrollingWhile(page, act, ms = 700) {
    const frames = page.evaluate(`new Promise((resolve) => {
        const boxes = ${scrollBoxes};
        const seen = new Set();
        const t0 = performance.now();
        const next = (fn) => requestAnimationFrame(() => setTimeout(fn, 0));
        const tick = () => {
            for (const k of boxes()) seen.add(k);
            if (performance.now() - t0 < ${ms}) next(tick); else resolve([...seen]);
        };
        next(tick);
    })`);
    await act();
    return frames;
}

async function openWidget(page) {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(searchUrl());
    await page.locator('.ilap-chevron').click();
    await expect(page.locator('.ilap-launcher')).not.toHaveClass(/stashed/);
    await expect(page.locator('.ilap-launcher')).not.toHaveClass(/locked/);
}

const needsSession = async () => {
    test.skip(!fs.existsSync(AUTH_FILE), 'no saved Steam session — run: npm run test:auth'); // panel is login-gated
};

// The plain panel, each tab, the lists and the queue: run at every scale.
function mainStates() {
    test('the plain open panel has no scrollbar, from the first frame on', async ({ page }) => {
        await openWidget(page);
        const seen = await scrollingWhile(page, () => page.locator('.ilap-launcher').click());
        expect(seen, 'no scrollbar while the panel opens').toEqual([]);
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);
        expect(await scrolling(page)).toEqual([]);
    });

    test('no scrollbar in any tab, nor on the way between them', async ({ page }) => {
        await openWidget(page);
        await page.locator('.ilap-launcher').click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);
        for (const tab of ['ai', 'lang', 'settings']) {
            const seen = await scrollingWhile(page, () => page.locator('#tab-' + tab).click());
            expect(seen, `no scrollbar while the ${tab} tab opens`).toEqual([]);
            expect(await scrolling(page), tab).toEqual([]);
        }
        const seen = await scrollingWhile(page, () => page.locator('#tab-settings').click());
        expect(seen, 'no scrollbar while the tab folds').toEqual([]);
    });

    test('no scrollbar with the lists drawer out, its year list open, or a tab open beside it', async ({ page }) => {
        await openWidget(page);
        await page.locator('.ilap-launcher').click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);

        // The lists' block never rises over the panel's top (its header).
        // Eight lists outgrow the 277 px panel, so its foot goes down under
        // the line and the lists show whole, with no scroll of their own.
        let seen = await scrollingWhile(page, () => page.locator('#lists-btn').click());
        expect(seen, 'no scrollbar while the drawer slides out').toEqual([]);
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/sliding/);
        expect(await scrolling(page)).toEqual([]);

        seen = await scrollingWhile(page, () => page.locator('#ai-pane .ai-year').click());
        expect(seen, 'no scrollbar while the year list opens').toEqual([]);
        expect(await scrolling(page)).toEqual([]);

        seen = await scrollingWhile(page, () => page.locator('#tab-settings').click());
        expect(seen, 'no scrollbar while the settings open beside the drawer').toEqual([]);
        expect(await scrolling(page)).toEqual([]);
    });

    test('no scrollbar with the queue drawer out on two jobs', async ({ context, page }) => {
        const job = (n) => ({
            id: 'job_' + n, type: 'curator', curatorId: String(n), curatorName: 'Curator ' + n,
            filter: 'not_recommended', appids: ['1', '2'], total: 2, status: 'paused',
        });
        await setExtensionStorage(context, { ilap_curator_queue: [job(1), job(2)] });
        await openWidget(page);
        await page.locator('.ilap-launcher').click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('2');

        const seen = await scrollingWhile(page, () => page.locator('#queue-btn').click());
        expect(seen, 'no scrollbar while the queue slides out').toEqual([]);
        await expect(page.locator('#queue-drawer')).not.toHaveClass(/sliding/);
        expect(await scrolling(page)).toEqual([]);
    });

    test('no scrollbar with the lists\' blue dots, their tips over and under the rows, or a dot folding away', async ({ context, page }) => {
        // Every list run at an older version of it (ListPanes _dot): a dot on every row.
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'presets.json'), 'utf8'));
        const marks = {};
        for (const k of Object.keys(data.rev)) marks['ilap_preset_done_' + k] = 'older00';
        await setExtensionStorage(context, marks);
        await openWidget(page);
        await page.locator('.ilap-launcher').click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);

        let seen = await scrollingWhile(page, () => page.locator('#lists-btn').click());
        expect(seen, 'no scrollbar while the drawer slides out with its dots').toEqual([]);
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/sliding/);
        expect(await scrolling(page)).toEqual([]);
        // The top row's tip drops under it, the last one's rises over it.
        const dots = page.locator('#lists-drawer .list-dot');
        for (const dot of [dots.first(), dots.last()]) {
            seen = await scrollingWhile(page, () => dot.hover());
            expect(seen, 'no scrollbar under a dot\'s tip').toEqual([]);
        }
        seen = await scrollingWhile(page, () => dots.last().click());
        expect(seen, 'no scrollbar while a dot folds away').toEqual([]);
        expect(await scrolling(page)).toEqual([]);
    });
}

test.describe('on-page widget — no scrollbars', () => {

    test.beforeEach(needsSession);

    mainStates();

    test('no scrollbar with the undo menu open, nor under the history tooltip', async ({ context, page }) => {
        const now = Date.now();
        const LONG = 'Spaceman Wakes Up In A New World, The Government Has Been Experimenting On People On the Moon and Created Crazy Vine Monsters';
        await setExtensionStorage(context, {
            ilap_ignore_log: [1, 2, 3].map(n => ({ appid: String(n), ts: now - n * 1000, source: 'mi' })),
            ilap_ignored_history: [0, 1, 2, 3].map(n => ({ name: LONG + ' ' + n, source: 'Default Ignore' })),
            ilap_last_ignored_name: LONG + ' 0',
        });
        await openWidget(page);
        await page.locator('.ilap-launcher').click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);

        // The tooltip ends over the panel's foot, and three long names scroll
        // inside it: its own scroll, for content that really outgrows it.
        const panelOnly = (boxes) => boxes.filter(b => b !== 'history-list');
        let seen = await scrollingWhile(page, () => page.locator('.history-trigger').hover());
        await expect(page.locator('.history-tooltip')).toBeVisible();
        expect(panelOnly(seen), 'no scrollbar while the history tooltip shows').toEqual([]);
        expect(panelOnly(await scrolling(page))).toEqual([]);

        seen = await scrollingWhile(page, () => page.locator('#undo-btn').click());
        await expect(page.locator('#undo-menu')).toHaveClass(/open/);
        expect(panelOnly(seen), 'no scrollbar while the undo menu opens').toEqual([]);
        expect(await scrolling(page)).toEqual([]);

        seen = await scrollingWhile(page, () => page.locator('#undo-btn').click());
        expect(panelOnly(seen), 'no scrollbar while the undo menu shuts').toEqual([]);
    });

    test('no scrollbar in any tab or in the lists, in any language, nor while it switches', async ({ context, page }) => {
        test.setTimeout(300 * 1000);   // every language, four panes each
        await openWidget(page);
        await page.locator('.ilap-launcher').click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);
        const walk = async (where) => {
            for (const code of LOCALES) {
                const seen = await scrollingWhile(page, () => setExtensionStorage(context, { ilap_lang: code }), 450);
                await expect(page.locator('#ilap-shell')).toHaveAttribute('lang', code);
                expect(seen, `no scrollbar while ${where} switches to ${code}`).toEqual([]);
                expect(await scrolling(page), `${where} in ${code}`).toEqual([]);
            }
        };
        for (const tab of ['ai', 'lang', 'settings']) {
            await page.locator('#tab-' + tab).click();
            await expect.poll(() => page.locator('#tab-panel').evaluate(el => el.classList.contains('moving'))).toBe(false);
            await walk(`the ${tab} tab`);
        }
        await page.locator('#tab-settings').click();
        await page.locator('#lists-btn').click();
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/sliding/);
        await walk('the lists');
    });

    test('the drawers\' frames go round their blocks alone', async ({ page }) => {
        await openWidget(page);
        await page.locator('.ilap-launcher').click();
        await page.locator('#lists-btn').click();
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/sliding/);
        const frame = await page.locator('#lists-drawer').evaluate(el => getComputedStyle(el).borderTopStyle);
        expect(frame, 'the drawer itself has no frame').toBe('none');
        const inner = page.locator('#lists-drawer .drawer-inner');
        // Framed all round like the queue's window, its right edge on the panel's left one.
        expect(await inner.evaluate(el => {
            const s = getComputedStyle(el);
            return [s.borderTopColor, s.borderRightStyle];
        })).toEqual(['rgb(69, 161, 250)', 'solid']);
        // With no tab open its rows outgrow the panel. The block's top is
        // the panel's top and its foot goes on under the panel's foot.
        const block = await inner.boundingBox();
        const panel = await page.locator('.ilap-panel #popup-root').boundingBox();
        expect(Math.abs(block.x + block.width - panel.x)).toBeLessThan(1);
        expect(Math.abs(block.y - panel.y)).toBeLessThan(1);
        expect(block.y + block.height).toBeGreaterThan(panel.y + panel.height);
    });

    test('the lists\' block keeps its height while a tab opens and shuts under the line', async ({ page }) => {
        await openWidget(page);
        await page.locator('.ilap-launcher').click();
        await page.locator('#lists-btn').click();
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/sliding/);
        const height = () => page.locator('#lists-drawer .drawer-inner').evaluate(el => el.getBoundingClientRect().height);
        const start = await height();
        for (let i = 0; i < 2; i++) {
            await page.locator('#tab-settings').click();
            await expect.poll(() => page.locator('#tab-panel').evaluate(el => el.classList.contains('moving'))).toBe(false);
            expect(Math.abs(await height() - start)).toBeLessThan(0.5);
            await page.locator('#tab-settings').click();
            await expect.poll(() => page.locator('#tab-panel').evaluate(el => el.getBoundingClientRect().height)).toBe(0);
            expect(Math.abs(await height() - start)).toBeLessThan(0.5);
        }
    });

    test('the lists\' block runs from the panel\'s top down under the line with no scroll, also with Already Played off', async ({ context, page }) => {
        for (const off of [false, true]) {
            if (off) await setExtensionStorage(context, { ilap_platform_key: 'off' });
            await openWidget(page);
            await page.locator('.ilap-launcher').click();
            await expect(page.locator('.ilap-panel')).toHaveClass(/open/);
            await page.locator('#lists-btn').click();
            await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
            await expect(page.locator('#lists-drawer')).not.toHaveClass(/sliding/);
            const inner = page.locator('#lists-drawer .drawer-inner');
            const block = await inner.boundingBox();
            const panel = await page.locator('.ilap-panel #popup-root').boundingBox();
            const state = `Already Played ${off ? 'off' : 'on'}`;
            expect(Math.abs(block.y - panel.y), `top on the panel's (${state})`).toBeLessThan(1);
            expect(block.y + block.height, `foot under the panel's (${state})`).toBeGreaterThan(panel.y + panel.height);
            // Every list shows with no scroll.
            await expect(page.locator('#lists-drawer').getByText('Known bad games', { exact: true })).toBeInViewport();
            expect(await scrolling(page)).toEqual([]);
        }
    });
});

// Windows display scaling: Chromium's device pixel ratio, the CSS viewport
// the same 1366×768.
for (const scale of [1.25, 1.5]) {
    test.describe(`on-page widget — no scrollbars at ${scale * 100} %`, () => {
        test.skip(({ browserName }) => browserName === 'firefox', 'the scale is a Chromium context option');
        test.use({ scale });
        test.beforeEach(needsSession);
        mainStates();
    });
}
