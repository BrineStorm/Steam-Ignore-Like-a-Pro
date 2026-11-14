const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

// The tab line under the gesture card (ui/popup_tabs.js): AI, language and
// settings over one panel that drops down under the line, one tab open or
// none, and the lists button in the line's left corner (ui/popup_presets.js,
// covered by presets.spec.js). The language tab's grid is covered by
// language.spec.js. Popup window only — no Steam login.

async function openPopup(page, context) {
    const extId = await getExtensionId(context);
    await page.goto(popupUrl(extId));
    await page.locator('#popup-root').waitFor({ timeout: 5000 });
}

const shown = (page) => page.evaluate(() =>
    [...document.querySelectorAll('#tab-panel > .tab-pane')].filter(p => !p.hidden).map(p => p.dataset.pane));
const panelHeight = (page) => page.evaluate(() => document.getElementById('tab-panel').getBoundingClientRect().height);

// Holds the boot's read of the stored tab until the test lets it go. The read is
// made on release, so it sees what a pick wrote meanwhile, or with `early` it is
// made at once, and only its answer waits.
const holdTabRead = (page, early) => page.addInitScript(({ key, early }) => {
    const area = chrome.storage.local;
    const get = area.get.bind(area);
    const held = new Promise((resolve) => { window.__releaseTabRead = resolve; });
    area.get = (keys, cb) => {
        if (keys !== key) return get(keys, cb);
        if (early) get(keys, (res) => held.then(() => cb(res)));
        else held.then(() => get(keys, cb));
    };
}, { key: 'ilap_popup_tab', early });

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    // popup.html renders the full UI only in popup surface mode (widget mode
    // shows the signpost stub — covered by surface-stub.spec.js).
    await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Popup — tab line', () => {

    test('opens with no tab open; a tab opens its pane, a second click folds it, another tab switches', async ({ page, context }) => {
        await openPopup(page, context);
        expect(await shown(page)).toEqual([]);
        expect(await panelHeight(page)).toBe(0);

        await page.locator('#tab-settings').click();
        await expect(page.locator('#tab-settings')).toHaveAttribute('aria-selected', 'true');
        await expect.poll(() => shown(page)).toEqual(['settings']);
        await expect(page.locator('#settings-placeholder #surface-row')).toBeVisible();

        await page.locator('#tab-ai').click();
        await expect(page.locator('#tab-settings')).toHaveAttribute('aria-selected', 'false');
        await expect.poll(() => shown(page)).toEqual(['ai']);

        await page.locator('#tab-ai').click();
        await expect(page.locator('#tab-ai')).toHaveAttribute('aria-selected', 'false');
        await expect.poll(() => shown(page)).toEqual([]);
        await expect.poll(() => panelHeight(page)).toBe(0);
    });

    test('opening, closing and switching all move the panel\'s height, and it clips while it moves', async ({ page, context }) => {
        await openPopup(page, context);
        // Sampled in the page every frame around a real click (a click from
        // page script is untrusted, and the tabs take none): never a jump from
        // 0 to the full height in one frame, and no overflow showing mid-way.
        const sample = async (sel) => {
            const frames = page.evaluate(() => new Promise((resolve) => {
                const panel = document.getElementById('tab-panel');
                const out = [];
                const t0 = performance.now();
                const tick = () => {
                    out.push({ h: panel.getBoundingClientRect().height, clip: getComputedStyle(panel).overflow });
                    if (performance.now() - t0 < 900) requestAnimationFrame(tick); else resolve(out);
                };
                requestAnimationFrame(tick);
            }));
            await page.locator(sel).click();
            return frames;
        };

        const open = await sample('#tab-settings');
        const end = open[open.length - 1].h;
        expect(end).toBeGreaterThan(40);
        const mid = open.filter(f => f.h > 0 && f.h < end);
        expect(mid.length, 'the panel grows over several frames').toBeGreaterThan(3);
        expect(mid.every(f => f.clip === 'hidden'), 'the panel clips while it grows').toBe(true);

        const close = await sample('#tab-settings');
        expect(close.filter(f => f.h > 0 && f.h < end).length, 'the panel shrinks over several frames').toBeGreaterThan(3);
        expect(close[close.length - 1].h).toBe(0);
    });

    test('the open tab is stored and comes back on the next open', async ({ page, context }) => {
        await openPopup(page, context);
        await page.locator('#tab-ai').click();
        await expect.poll(async () => (await getExtensionStorage(context, ['ilap_popup_tab'])).ilap_popup_tab).toBe('ai');

        await page.reload();
        await page.locator('#popup-root').waitFor();
        await expect(page.locator('#tab-ai')).toHaveAttribute('aria-selected', 'true');
        await expect.poll(() => shown(page)).toEqual(['ai']);

        await page.locator('#tab-ai').click();
        await expect.poll(async () => (await getExtensionStorage(context, ['ilap_popup_tab'])).ilap_popup_tab).toBe('');
    });

    test('a tab picked during the read of the stored one keeps its pane as the user left it', async ({ page, context }) => {
        await holdTabRead(page, false);
        await openPopup(page, context);
        await page.locator('#tab-settings').click();
        await page.locator('#mi-section summary .section-title').click();
        await expect(page.locator('#mi-section')).toHaveJSProperty('open', true);
        await page.locator('#mi-section').evaluate((el) => { el.dataset.sameNode = '1'; });

        await page.evaluate(() => window.__releaseTabRead());
        await page.waitForTimeout(300);
        await expect(page.locator('#mi-section'), 'the pane must not be rebuilt').toHaveAttribute('data-same-node', '1');
        await expect(page.locator('#mi-section')).toHaveJSProperty('open', true);
    });

    test('a tab picked before the stored one is answered stays open', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_popup_tab: 'lang' });
        await holdTabRead(page, true);
        await openPopup(page, context);
        await page.locator('#tab-settings').click();
        await expect.poll(() => shown(page)).toEqual(['settings']);

        await page.evaluate(() => window.__releaseTabRead());
        await page.waitForTimeout(300);
        expect(await shown(page)).toEqual(['settings']);
        await expect(page.locator('#tab-settings')).toHaveAttribute('aria-selected', 'true');
    });

    test('arrow keys move along the tabs, Enter opens the focused one', async ({ page, context }) => {
        await openPopup(page, context);
        // With none open, the first tab is the line's one tab stop.
        await expect(page.locator('#tab-ai')).toHaveAttribute('tabindex', '0');
        await expect(page.locator('#tab-settings')).toHaveAttribute('tabindex', '-1');

        await page.locator('#tab-ai').focus();
        await page.keyboard.press('ArrowRight');
        await expect(page.locator('#tab-lang')).toBeFocused();
        await page.keyboard.press('End');
        await expect(page.locator('#tab-settings')).toBeFocused();
        await page.keyboard.press('ArrowRight');
        await expect(page.locator('#tab-ai')).toBeFocused();
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Enter');
        await expect(page.locator('#tab-settings')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#tab-settings')).toHaveAttribute('tabindex', '0');
    });

    test('every button of the line is named in the panel\'s language, and its tooltip says the same', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_lang: 'de' });
        await openPopup(page, context);
        const names = await page.evaluate(() =>
            [...document.querySelectorAll('#tabline .tab')].map(b => b.getAttribute('aria-label')));
        expect(names.every(Boolean)).toBe(true);
        // "EINSTELLUNGEN" in the old bar, a name in sentence case here; the
        // language's trailing colon is dropped.
        expect(names).toContain('Einstellungen');
        expect(names.some(n => /[:：]$/.test(n))).toBe(false);

        await page.locator('#tab-settings').hover();
        const tip = page.locator('#tab-tip');
        await expect(tip).toHaveClass(/show/);
        await expect(tip).toHaveText('Einstellungen');
        await expect.poll(() => tip.evaluate(el => getComputedStyle(el).opacity)).toBe('1');
        // Kept inside the line.
        const box = await tip.boundingBox();
        const line = await page.locator('#tabline').boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(line.x);
        expect(box.x + box.width).toBeLessThanOrEqual(line.x + line.width);
    });

    test('the line reads lists, AI, language, settings in four equal cells, each drawn in its middle, ruled off by lines that take no width', async ({ page, context }) => {
        await openPopup(page, context);
        await expect(page.locator('#tab-ai')).toHaveAttribute('aria-label', 'AI-generated content filtration settings');
        await expect(page.locator('#tab-lang')).toHaveAttribute('aria-label', 'Language');
        const line = await page.locator('#tabline').boundingBox();
        // What a cell shows: its children, less the text kept out of sight and
        // the lists' «, which shows only while the drawer is out.
        const cells = await page.evaluate(() => [...document.querySelectorAll('#tabline .tab')].map((b) => {
            const r = b.getBoundingClientRect();
            const ink = [...b.children].filter(c => !c.matches('.tab-word, .lists-back')).map(c => c.getBoundingClientRect());
            const left = Math.min(...ink.map(i => i.left)), right = Math.max(...ink.map(i => i.right));
            return { id: b.id, x: r.x, w: r.width, mid: r.x + r.width / 2, inkMid: (left + right) / 2, rule: getComputedStyle(b).boxShadow };
        }));
        expect(cells.map(c => c.id)).toEqual(['lists-btn', 'tab-ai', 'tab-lang', 'tab-settings']);
        for (const c of cells) {
            expect(Math.abs(c.w - line.width / 4), c.id).toBeLessThan(0.5);
            expect(Math.abs(c.inkMid - c.mid), c.id).toBeLessThan(1);
        }
        expect(Math.abs(cells[0].x - line.x)).toBeLessThan(0.5);
        expect(Math.abs(cells[3].x + cells[3].w - (line.x + line.width))).toBeLessThan(0.5);
        expect(cells.map(c => /inset/.test(c.rule))).toEqual([true, true, true, false]);
    });

    test('the AI tab: the word first and the funnel right of it, clear of the frame and the strike; the word stays as text out of sight', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await openPopup(page, context);
        const glyph = await page.locator('#tab-ai > .ai-ico').evaluate((el) => {
            const svg = el.firstElementChild;
            const box = (sel) => svg.querySelector(sel).getBoundingClientRect().toJSON();
            return { svg: svg.matches('svg.ai-glyph'), f: box('.ai-funnel'), w: box('.ai-letters'), frame: box('.ai-frame'), slash: box('.ai-slash') };
        });
        expect(glyph.svg).toBe(true);
        expect(glyph.frame.right).toBeLessThan(glyph.f.left);
        expect(glyph.slash.right).toBeLessThan(glyph.f.left);
        expect(glyph.f.left - glyph.w.right).toBeLessThan(6);
        // The word stays as text for what reads the page, out of sight.
        await expect(page.locator('#tab-ai .tab-word')).toHaveText('AI');
        const word = await page.locator('#tab-ai .tab-word').evaluate(el => {
            const r = el.getBoundingClientRect();
            return { size: getComputedStyle(el).fontSize, w: r.width, h: r.height };
        });
        expect(word.size).toBe('0px');
        expect(word.w).toBeLessThanOrEqual(1);
        expect(word.h).toBeLessThanOrEqual(1);
    });

    test('the language: a globe, the code in the AI tab\'s letters and in their white, and a caret that turns down while the grid is out; the code follows the language', async ({ page, context }) => {
        await openPopup(page, context);
        const look = () => page.evaluate(() => {
            const box = (el) => el.getBoundingClientRect().toJSON();
            const tab = document.getElementById('tab-lang');
            const glyph = document.getElementById('lang-glyph');
            const paths = [...glyph.querySelectorAll('path')];
            const ink = paths.map(box);
            const ai = document.querySelector('#tab-ai .ai-letters');
            return {
                order: [...tab.children].filter(c => !c.matches('.tab-word')).map(c => c.getAttribute('class')),
                globe: box(tab.querySelector('.globe-ico')), glyph: box(glyph), caret: box(tab.querySelector('.lang-caret')),
                letters: paths.length, d: paths.map(p => p.getAttribute('d')).join(' '),
                top: Math.min(...ink.map(i => i.top)), bottom: Math.max(...ink.map(i => i.bottom)),
                ai: box(ai), fill: paths.length ? getComputedStyle(paths[0]).fill : null, aiFill: getComputedStyle(ai).fill,
                turn: getComputedStyle(tab.querySelector('.lang-caret')).transform,
            };
        });
        const en = await look();
        expect(en.order).toEqual(['tab-ico globe-ico', 'lang-glyph', 'lang-caret']);
        expect(en.globe.right).toBeLessThanOrEqual(en.glyph.left);
        expect(en.glyph.right).toBeLessThanOrEqual(en.caret.left);
        // E and N stand as tall as A and I, on their line, in their white.
        expect(en.letters).toBe(2);
        expect(Math.abs(en.top - en.ai.top)).toBeLessThan(0.5);
        expect(Math.abs(en.bottom - en.ai.bottom)).toBeLessThan(0.5);
        expect(en.fill).toBe('rgb(255, 255, 255)');
        expect(en.aiFill).toBe('rgb(255, 255, 255)');
        // The code stays as text for what reads the page, out of sight.
        await expect(page.locator('#lang-code')).toHaveText('EN');
        expect(await page.locator('#lang-code').evaluate(el => getComputedStyle(el).fontSize)).toBe('0px');
        expect(en.turn).toBe('none');
        await page.locator('#tab-lang').click();
        await expect.poll(async () => (await look()).turn).toMatch(/^matrix\([-\de.]+, 1, -1, [-\de.]+, 0, 0\)$/);
        await page.locator('#tab-lang').click();
        await expect.poll(async () => (await look()).turn).toBe('none');
        for (const [lang, code] of [['ru', 'RU'], ['es-419', 'LA']]) {
            await setExtensionStorage(context, { ilap_lang: lang });
            await expect(page.locator('#lang-code')).toHaveText(code);
            const now = await look();
            expect(now.letters, lang).toBe(2);
            expect(now.d, lang).not.toBe(en.d);
        }
    });

    test('the open tab, the lists button with its drawer out and the queue\'s icon with the queue out have one mark, as wide in every cell, fading in and out', async ({ page, context }) => {
        await openPopup(page, context);
        // The panel opens with its transitions off for a moment (initPopup).
        await expect(page.locator('#popup-root')).not.toHaveClass(/no-transition/);
        const mark = (sel, pseudo = '::after') => page.locator(sel).evaluate((el, p) => {
            const s = getComputedStyle(el, p);
            return { w: parseFloat(s.width), h: s.height, bg: s.backgroundColor, radius: s.borderRadius, opacity: s.opacity, fade: s.transitionProperty + ' ' + s.transitionDuration };
        }, pseudo);
        const look = { h: '2px', bg: 'rgb(69, 161, 250)', radius: '2px', opacity: '0', fade: 'opacity 0.2s' };
        const cells = ['#lists-btn', '#tab-ai', '#tab-lang', '#tab-settings'];
        const marks = [];
        for (const id of cells) marks.push(await mark(id));
        for (const [i, m] of marks.entries()) {
            expect(m, cells[i]).toMatchObject(look);
            expect(Math.abs(m.w - marks[0].w), cells[i]).toBeLessThan(0.5);
        }
        await page.locator('#lists-btn').click();
        await expect.poll(async () => (await mark('#lists-btn')).opacity).toBe('1');
        // A tab's pane takes the lists' place under the line: its mark comes, theirs goes.
        for (const id of cells.slice(1)) {
            await page.locator(id).click();
            await expect.poll(async () => (await mark(id)).opacity, id).toBe('1');
        }
        await expect.poll(async () => (await mark('#lists-btn')).opacity).toBe('0');
        await expect.poll(async () => (await mark('#tab-ai')).opacity).toBe('0');
        // The queue's icon: the same mark, as wide as the icon, on the header's lower edge.
        const queue = await mark('#queue-btn', '::before');
        expect(queue).toMatchObject(look);
        const [icon, btn, head] = await page.evaluate(() => ['#queue-btn img', '#queue-btn', '#popup-root > h3']
            .map(s => document.querySelector(s).getBoundingClientRect().toJSON()));
        expect(Math.abs(queue.w - icon.width)).toBeLessThan(0.5);
        const below = await page.locator('#queue-btn').evaluate(el => parseFloat(getComputedStyle(el, '::before').bottom));
        expect(Math.abs(btn.bottom - below - (head.bottom - 1))).toBeLessThan(0.5);
        await page.locator('#queue-btn').click();
        await expect.poll(async () => (await mark('#queue-btn', '::before')).opacity).toBe('1');
        await page.locator('#queue-btn').click();
        await expect.poll(async () => (await mark('#queue-btn', '::before')).opacity).toBe('0');
    });

    test('reduced motion: the marks and the language caret change at once', async ({ page, context }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await openPopup(page, context);
        await expect(page.locator('#popup-root')).not.toHaveClass(/no-transition/);
        // In seconds: none, or popup.css's catch-all .01 ms.
        const fade = (sel, pseudo) => page.locator(sel).evaluate((el, p) => parseFloat(getComputedStyle(el, p).transitionDuration), pseudo);
        for (const sel of ['#lists-btn', '#tab-ai', '#tab-lang', '#tab-settings']) expect(await fade(sel, '::after'), sel).toBeLessThan(0.001);
        expect(await fade('#queue-btn', '::before')).toBeLessThan(0.001);
        expect(await fade('#tab-lang .lang-caret', null)).toBeLessThan(0.001);
    });

    test('the AI glyph moves on hover: the funnel and the word grow, and the strike or frame is drawn again', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ai_level: 3 });
        await openPopup(page, context);
        const tab = page.locator('#tab-ai');
        await expect(tab).toHaveAttribute('data-level', '3');
        const look = () => tab.evaluate((el) => {
            const cs = (sel) => getComputedStyle(el.querySelector(sel));
            return {
                funnel: cs('.ai-funnel').transform, word: cs('.ai-letters').transform,
                strike: cs('.ai-slash').animationName, frame: cs('.ai-frame').animationName,
            };
        });
        expect(await look()).toEqual({ funnel: 'none', word: 'none', strike: 'none', frame: 'none' });
        await tab.hover();
        await expect.poll(async () => (await look()).funnel).toMatch(/^matrix\(1\.12, 0, 0, 1\.12,/);
        await expect.poll(async () => (await look()).word).toMatch(/^matrix\(1\.06, 0, 0, 1\.06,/);
        // The strike is drawn again from the left.
        expect((await look()).strike).toBe('ilap-ai-strike');
        expect((await look()).frame).toBe('none');

        // At Low the frame is drawn again in its place.
        await page.mouse.move(0, 0);
        await setExtensionStorage(context, { ilap_ai_level: 1 });
        await expect(tab).toHaveAttribute('data-level', '1');
        await tab.hover();
        await expect.poll(async () => (await look()).frame).toBe('ilap-ai-frame');
        expect((await look()).strike).toBe('none');

        // At Off the word stands alone, and only the funnel and the word move.
        await page.mouse.move(0, 0);
        await setExtensionStorage(context, { ilap_ai_level: 0 });
        await expect(tab).toHaveAttribute('data-level', '0');
        await tab.hover();
        await expect.poll(async () => (await look()).word).toMatch(/^matrix\(1\.06, 0, 0, 1\.06,/);
        expect((await look()).strike).toBe('none');
        expect((await look()).frame).toBe('none');
    });

    test('a gear has eight teeth that narrow to flat tips: a turn by one tooth (45°) looks the same', async ({ page, context }) => {
        await openPopup(page, context);
        const d = await page.locator('#tab-settings .gear-ico path').first().getAttribute('d');
        // Eight teeth, each with a flat tip between two corners on the outer radius.
        const pts = [...d.matchAll(/L([\d.]+) ([\d.]+)/g)].map(m => [+m[1] - 12, +m[2] - 12]);
        const outer = pts.filter(([x, y]) => Math.hypot(x, y) > 10.5);
        expect(outer).toHaveLength(16);
        // The tip is narrower than the tooth's root: the sides slope in.
        const tip = Math.hypot(outer[0][0] - outer[1][0], outer[0][1] - outer[1][1]);
        expect(tip).toBeLessThan(3.2);
        expect(tip).toBeGreaterThan(2);
    });
});
