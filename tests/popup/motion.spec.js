const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

// Nothing in the popup appears, disappears or changes height in one frame:
// each change has its motion, and none with reduced motion. Each check
// samples the element every frame while the change runs and asks whether it
// ever had a motion of its own (a CSS transition or animation, or one run
// from script) of at least ANIMATED_MS. The motions' look is the other
// suites'. Driven through the toolbar popup window, in popup surface mode.
// No store tab is open and the test build's service worker is empty, so a
// staged job is never drained.

const ANIMATED_MS = 100;

const logEntry = (n) => ({ appid: String(n), ts: Date.now() - n * 1000, source: 'mi' });

let jobSeq = 0;
const job = (over = {}) => Object.assign({
    id: 'job_motion_' + (++jobSeq), type: 'curator', curatorId: String(500 + jobSeq), curatorName: 'Curator ' + jobSeq,
    filter: 'not_recommended', appids: ['1', '2'], total: 2, status: 'paused',
}, over);

// Opened and come to rest: a change made in the window's first frames has
// no frame before it to move from, and no hand is that quick.
async function openPopup(page, context) {
    await page.goto(popupUrl(await getExtensionId(context)));
    await page.locator('#popup-root').waitFor({ timeout: 5000 });
    await page.waitForFunction(() => document.getAnimations().length === 0);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// Whether the element `sel` names (looked up once, as the change starts) had
// a motion of ANIMATED_MS or longer on any frame within `ms` while `act` ran.
async function animatedWhile(page, sel, act, ms = 500) {
    const seen = page.evaluate(([sel, ms, min]) => new Promise((resolve) => {
        const el = document.querySelector(sel);
        if (!el) { resolve(null); return; }
        let moved = false;
        const t0 = performance.now();
        const tick = () => {
            moved = moved || el.getAnimations().some(a => a.effect && a.effect.getComputedTiming().duration >= min);
            if (performance.now() - t0 < ms) requestAnimationFrame(tick); else resolve(moved);
        };
        requestAnimationFrame(tick);
    }), [sel, ms, ANIMATED_MS]);
    await act();
    return seen;
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Popup — every show and hide has its motion', () => {

    test('the undo menu fades in and out', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ignore_log: [logEntry(1), logEntry(2)] });
        await openPopup(page, context);
        await expect(page.locator('#undo-btn')).toBeEnabled();
        expect(await animatedWhile(page, '#undo-menu', () => page.locator('#undo-btn').click()), 'opens').toBe(true);
        await expect(page.locator('#undo-menu')).toHaveClass(/open/);
        expect(await animatedWhile(page, '#undo-menu', () => page.locator('#undo-btn').click()), 'shuts').toBe(true);
        await expect(page.locator('#undo-menu')).toBeHidden();
    });

    test("the undo menu's message folds in", async ({ page, context }) => {
        // A rollback already queued: the menu says so (a staged one flies into the queue instead).
        await setExtensionStorage(context, { ilap_ignore_log: [logEntry(1), logEntry(2)], ilap_curator_queue: [
            { id: 'job_undo_1', type: 'undo', curatorId: 'undo', curatorName: '', appids: ['1'], total: 1, status: 'pending', scope: { n: 1 } },
        ] });
        await openPopup(page, context);
        await page.locator('#undo-btn').click();
        await page.locator('#undo-count').dblclick();
        expect(await animatedWhile(page, '#undo-msg', () => page.locator('#undo-go').click())).toBe(true);
        await expect(page.locator('#undo-msg')).toBeVisible();
    });

    test('the Games | Creators line folds in, and a pane switch moves the menu', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ignore_log: [logEntry(1)] });
        await openPopup(page, context);
        await page.locator('#undo-btn').click();
        await expect(page.locator('#undo-menu')).toHaveClass(/open/);
        // The undo box redraws at most once a second (popup_main.js renderUndoSoon).
        const line = await animatedWhile(page, '#undo-tabs', () =>
            setExtensionStorage(context, { ilap_creators: { ignored: { 4: 'Valve' }, followed: [] } }), 1600);
        expect(line, 'the tab line').toBe(true);
        await expect(page.locator('#undo-tabs')).toBeVisible();
        expect(await animatedWhile(page, '#undo-menu', () => page.locator('#undo-tab-creators').click()), 'the menu').toBe(true);
        await expect(page.locator('#undo-pane-creators')).toBeVisible();
        await expect(page.locator('#undo-pane-creators')).toHaveClass(/undo-pane-in/);
    });

    test('a droplist fades in', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_creators: { ignored: { 4: 'Valve', 5: 'Bethesda' }, followed: [] } });
        await openPopup(page, context);
        await page.locator('#undo-btn').click();
        await page.locator('#undo-tab-creators').click();
        const menu = '.undo-creator-shell .select-menu';
        expect(await animatedWhile(page, menu, () => page.locator('#undo-creator-display').click())).toBe(true);
        await expect(page.locator(menu)).toHaveClass(/open/);
    });

    test('a strip gone from the queue elsewhere folds away, and a new one fades in', async ({ page, context }) => {
        const a = job(), b = job();
        await setExtensionStorage(context, { ilap_curator_queue: [a, b] });
        await openPopup(page, context);
        await page.locator('#queue-btn').click();
        await expect(page.locator('.queue-job')).toHaveCount(2);
        await expect(page.locator('#queue-drawer')).not.toHaveClass(/sliding/);

        // Another tab, the curator page's menu or the drainer took job b out.
        const gone = await animatedWhile(page, `.queue-job[data-job-id="${b.id}"]`, () =>
            setExtensionStorage(context, { ilap_curator_queue: [a] }));
        expect(gone, 'the strip that goes').toBe(true);
        await expect(page.locator('.queue-job')).toHaveCount(1);

        const c = job();
        await setExtensionStorage(context, { ilap_curator_queue: [a, c] });
        await expect(page.locator(`.queue-job[data-job-id="${c.id}"]`)).toHaveCount(1);
        // Sampled from its first frame in the list.
        expect(await page.locator(`.queue-job[data-job-id="${c.id}"]`).evaluate((el, min) =>
            el.getAnimations().some(x => x.effect && x.effect.getComputedTiming().duration >= min), ANIMATED_MS),
            'the strip that comes').toBe(true);
    });

    test("the AI tab's frame and strike are drawn along their length as the level moves", async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ai_level: 0 });
        await openPopup(page, context);
        expect(await animatedWhile(page, '#tab-ai .ai-frame', () =>
            setExtensionStorage(context, { ilap_ai_level: 1 })), 'the frame').toBe(true);
        await expect(page.locator('#tab-ai')).toHaveAttribute('data-level', '1');
        expect(await animatedWhile(page, '#tab-ai .ai-slash', () =>
            setExtensionStorage(context, { ilap_ai_level: 3 })), 'the strike').toBe(true);
        await expect(page.locator('#tab-ai')).toHaveAttribute('data-level', '3');
    });

    test('with reduced motion nothing moves, and each change is made at once', async ({ page, context }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await setExtensionStorage(context, { ilap_ignore_log: [logEntry(1), logEntry(2)] });
        await openPopup(page, context);
        await expect(page.locator('#undo-btn')).toBeEnabled();
        expect(await animatedWhile(page, '#undo-menu', () => page.locator('#undo-btn').click()), 'the menu').toBe(false);
        await expect(page.locator('#undo-menu')).toBeVisible();
        expect(await animatedWhile(page, '#undo-tabs', () =>
            setExtensionStorage(context, { ilap_creators: { ignored: { 4: 'Valve' }, followed: [] } }), 1600), 'the tab line').toBe(false);
        await expect(page.locator('#undo-tabs')).toBeVisible();
        expect(await animatedWhile(page, '#tab-ai .ai-slash', () =>
            setExtensionStorage(context, { ilap_ai_level: 3 })), "the AI tab's strike").toBe(false);
        await expect(page.locator('#tab-ai')).toHaveAttribute('data-level', '3');
        // Nothing anywhere in the popup runs longer than a frame.
        const long = await page.evaluate((min) => document.getAnimations()
            .filter(a => a.playState === 'running' && a.effect && a.effect.getComputedTiming().duration >= min)
            .map(a => a.animationName || a.transitionProperty || 'script'), ANIMATED_MS);
        expect(long).toEqual([]);
    });
});
