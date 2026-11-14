// Reduced motion (prefers-reduced-motion: reduce) on a Steam page: in the
// on-page widget nothing runs longer than a frame, the gold halo and the
// pulses included, whichever state it is in. On the page itself the same
// holds for any element of ours (an ilap- id or class, styles/styles.css), and
// Steam's own elements keep their motion. The widget's states are walked as
// a user opens them, and each is checked a frame after it settles.
//
// Playwright CSS selectors pierce the open shadow root.

const { test, expect, AUTH_FILE } = require('../_fixtures.js');
const { setExtensionStorage } = require('../_extension.js');
const fs = require('fs');

const { searchUrl } = require('../_search.js'); // random search term per navigation

test.describe.configure({ retries: 2 }); // hover/corner-driven, like the rest of the widget suite

const MOVING_MS = 1;

// The widget's motions longer than MOVING_MS, running or still to run, a
// frame after now, by name and target.
const moving = (page) => page.evaluate((min) => new Promise((resolve) => requestAnimationFrame(() => {
    const root = document.getElementById('ilap-widget-host').shadowRoot;
    resolve(root.getAnimations()
        .filter(a => a.playState !== 'finished' && a.effect && a.effect.getComputedTiming().duration > min)
        .map(a => {
            const el = a.effect.target;
            return (a.animationName || a.transitionProperty || 'script') + ' on '
                + (el ? el.id || String(el.className).split(' ')[0] : '?') + (a.effect.pseudoElement || '');
        }));
})), MOVING_MS);

test.describe('reduced motion', () => {

    test.beforeEach(async ({ page }) => {
        test.skip(!fs.existsSync(AUTH_FILE), 'no saved Steam session — run: npm run test:auth'); // panel is login-gated
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.setViewportSize({ width: 1366, height: 768 });
    });

    test('the widget runs no motion in any state', async ({ context, page }) => {
        const job = (n) => ({
            id: 'job_' + n, type: 'curator', curatorId: String(n), curatorName: 'Curator ' + n,
            filter: 'not_recommended', appids: ['1', '2'], total: 2, status: 'paused',
        });
        await setExtensionStorage(context, { ilap_curator_queue: [job(1)] });
        await page.goto(searchUrl());
        await page.locator('.ilap-chevron').click();
        await expect(page.locator('.ilap-launcher')).not.toHaveClass(/stashed/);
        expect(await moving(page), 'the launcher slid out').toEqual([]);

        // The gold halo (an infinite radiate) and the one-shot pulses.
        await page.locator('.ilap-chevron').evaluate(el => el.classList.add('restored', 'gold', 'pulse'));
        await page.locator('.ilap-launcher').evaluate(el => el.classList.add('pulse'));
        expect(await moving(page), 'the halo and the pulses').toEqual([]);
        await page.locator('.ilap-chevron').evaluate(el => el.classList.remove('restored', 'gold'));

        await page.locator('.ilap-launcher').click();
        await expect(page.locator('.ilap-panel')).toHaveClass(/open/);
        expect(await moving(page), 'the panel opened').toEqual([]);
        for (const tab of ['ai', 'lang', 'settings']) {
            await page.locator('#tab-' + tab).click();
            expect(await moving(page), `the ${tab} tab`).toEqual([]);
        }
        await page.locator('#tab-settings').click();
        await page.locator('#lists-btn').click();
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        expect(await moving(page), 'the lists').toEqual([]);
        await page.locator('#ai-pane .ai-year').click();
        expect(await moving(page), 'the year list').toEqual([]);
        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer')).toHaveClass(/open/);
        expect(await moving(page), 'the queue').toEqual([]);
        await page.locator('.queue-job').first().hover();
        expect(await moving(page), 'a strip under the pointer').toEqual([]);
        // A page click shuts the panel with no fade.
        await page.mouse.click(10, 400);
        await expect(page.locator('.ilap-panel')).not.toHaveClass(/open/);
        expect(await moving(page), 'the panel closed').toEqual([]);
        await expect(page.locator('.ilap-panel')).toBeHidden();
    });

    test("on Steam's page our elements run no motion, and Steam's own keep theirs", async ({ page }) => {
        await page.goto(searchUrl());
        await expect(page.locator('#ilap-widget-host')).toBeAttached();
        const longest = await page.evaluate(() => new Promise((resolve) => {
            const sheet = document.createElement('style');
            sheet.textContent = '@keyframes ilap-test-spin { to { transform: rotate(1turn); } }';
            document.head.appendChild(sheet);
            // Inline motion, as the Classic DQ toast sets it, on an element of
            // ours by class, one held in a box of ours by id, and one of Steam's.
            const make = (attrs) => {
                const el = document.createElement('div');
                Object.assign(el, attrs);
                el.style.cssText = 'animation: ilap-test-spin 2s linear infinite; transition: opacity 2s; opacity: 1;';
                return el;
            };
            const byClass = make({ className: 'ilap-test-mark' });
            const box = document.createElement('div');
            box.id = 'ilap-test-box';
            const inBox = make({});
            box.appendChild(inBox);
            const steams = make({ className: 'search_result_row' });
            document.body.append(byClass, box, steams);
            requestAnimationFrame(() => {
                for (const el of [byClass, inBox, steams]) el.style.opacity = '0.5';
                requestAnimationFrame(() => {
                    const longestOf = (el) => Math.max(0, ...el.getAnimations().map(a => a.effect.getComputedTiming().duration));
                    resolve({ byClass: longestOf(byClass), inBox: longestOf(inBox), steams: longestOf(steams) });
                    sheet.remove(); byClass.remove(); box.remove(); steams.remove();
                });
            });
        }));
        expect(longest.byClass, 'an element with an ilap- class').toBeLessThanOrEqual(MOVING_MS);
        expect(longest.inBox, 'an element in an ilap- box').toBeLessThanOrEqual(MOVING_MS);
        expect(longest.steams, "Steam's element").toBe(2000);
    });
});
