const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

// Section 508 (WCAG 2.0 AA) on the toolbar popup: the document's language and
// title, a name for every control, text contrast, a visible keyboard focus and
// keyboard reach for everything a mouse can do. Our own checks, no axe: the
// only dev dependency is Playwright. The widget mounts the same markup, so
// what holds here holds there. Popup window only — no Steam login.

async function openPopup(page, context) {
    const extId = await getExtensionId(context);
    await page.goto(popupUrl(extId));
    await page.locator('#popup-root').waitFor({ timeout: 5000 });
}

const history = ['Portal 2', 'Half-Life', 'Dota 2'].map((name, i) => ({ name, source: 'Default Ignore', appid: String(620 + i) }));

// Tab until `sel` has the focus (a keyboard focus, so :focus-visible holds).
async function tabTo(page, sel, max = 60) {
    for (let i = 0; i < max; i++) {
        await page.keyboard.press('Tab');
        if (await page.evaluate((s) => !!document.activeElement && document.activeElement.matches(s), sel)) return;
    }
    throw new Error('Tab never reached ' + sel);
}

// The accessible name, roughly as a browser computes it: aria-labelledby,
// aria-label, a <label>, an image's alt, then the text (tooltips left out).
function unnamedControls() {
    const nameOf = (el) => {
        const by = el.getAttribute('aria-labelledby');
        if (by) return by.split(/\s+/).map(id => (document.getElementById(id) || {}).textContent || '').join(' ').trim();
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
        if (el.labels && el.labels.length) return [...el.labels].map(l => l.textContent).join(' ').trim();
        if (el.tagName === 'SELECT') return '';
        const copy = el.cloneNode(true);
        copy.querySelectorAll('[aria-hidden="true"], [role="tooltip"]').forEach(x => x.remove());
        return copy.textContent.replace(/\s+/g, ' ').trim();
    };
    const sel = 'a[href], button, input, select, summary, [tabindex]:not([tabindex="-1"]), [role="tab"], [role="option"], [role="radio"], [role="link"]';
    return [...document.querySelectorAll(sel)].filter(el => !nameOf(el)).map(el => el.id || el.className || el.tagName);
}

// Every visible text against the background it is drawn on, opacity included:
// 4.5:1, or 3:1 for large text. Disabled controls are exempt.
function lowContrastText() {
    const parse = (c) => { const p = c.match(/[\d.]+/g).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
    const lum = (c) => ['r', 'g', 'b'].map(k => { const v = c[k] / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); })
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const shown = (el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        for (let e = el; e; e = e.parentElement) {
            const s = getComputedStyle(e);
            if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return false;
        }
        return true;
    };
    const out = [];
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const el = walker.currentNode.parentElement;
        if (!walker.currentNode.textContent.trim() || seen.has(el) || !shown(el)) continue;
        seen.add(el);
        if (el.closest('[disabled], [aria-disabled="true"]')) continue;
        const layers = [];
        let alpha = 1;
        for (let e = el; e; e = e.parentElement) {
            alpha *= +getComputedStyle(e).opacity;
            const c = parse(getComputedStyle(e).backgroundColor);
            if (c.a > 0 && layers[layers.length - 1] !== 'opaque') { layers.push(c); if (c.a >= 1) layers.push('opaque'); }
        }
        let bg = { r: 255, g: 255, b: 255, a: 1 };
        layers.filter(l => l !== 'opaque').reverse().forEach(l => { bg = over(l, bg); });
        const s = getComputedStyle(el);
        const fg = parse(s.color);
        const text = over({ ...fg, a: fg.a * alpha }, bg);
        const [hi, lo] = [lum(text), lum(bg)].sort((a, b) => b - a);
        const ratio = (hi + 0.05) / (lo + 0.05);
        const size = parseFloat(s.fontSize);
        const large = size >= 24 || (+s.fontWeight >= 700 && size >= 18.66);
        if (ratio < (large ? 3 : 4.5)) out.push(`${el.id || el.className}: "${walker.currentNode.textContent.trim()}" ${ratio.toFixed(2)}`);
    }
    return out;
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    // popup.html renders the full UI only in popup surface mode.
    await setExtensionStorage(context, {
        ilap_surface_mode: 'popup',
        ilap_ignored_history: history,
        ilap_last_ignored_name: 'Portal 2',
    });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Popup — Section 508', () => {

    test('the page has a title, and its language follows the interface language', async ({ page, context }) => {
        await openPopup(page, context);
        await expect(page).toHaveTitle('Steam Ignore Like a Pro');
        await expect(page.locator('html')).toHaveAttribute('lang', 'en');
        await expect(page.locator('#ilap-shell')).toHaveAttribute('lang', 'en');

        await setExtensionStorage(context, { ilap_lang: 'pt-BR' });
        await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
        // The shell has it too: in the widget it sits in a Steam page of its own language.
        await expect(page.locator('#ilap-shell')).toHaveAttribute('lang', 'pt-BR');
    });

    test('every control has a name, in every tab and in both drawers', async ({ page, context }) => {
        await openPopup(page, context);
        await expect(page.locator('#ilap-header-icon')).toHaveAttribute('alt', '');
        expect(await page.evaluate(unnamedControls)).toEqual([]);

        await page.locator('#tab-settings').click();
        await expect(page.locator('#settings-placeholder #mi-section')).toBeVisible();
        await page.evaluate(() => document.querySelectorAll('#settings-placeholder details').forEach(d => { d.open = true; }));
        expect(await page.evaluate(unnamedControls)).toEqual([]);
        await expect(page.locator('#default-key')).toHaveAccessibleName('Default Ignore:');
        await expect(page.locator('#mask-toggle')).toHaveAccessibleName('Blur ignored covers');
        await expect(page.locator('#master-toggle')).toHaveAccessibleName('Steam Ignore Like a Pro');
        await expect(page.locator('#count-link')).toHaveAccessibleName('Total Ignored: 0');
        await expect(page.locator('#tab-lang')).toHaveAccessibleName('Language');
        await expect(page.locator('#queue-btn')).toHaveAccessibleName('Ignore Tasks Queue');

        await page.locator('#tab-lang').click();
        await expect(page.locator('#lang-pane .lang-opt').first()).toBeVisible();
        expect(await page.evaluate(unnamedControls)).toEqual([]);

        await page.locator('#lists-btn').click();
        await expect(page.locator('#lists-drawer .list-add').first()).toBeVisible();
        expect(await page.evaluate(unnamedControls)).toEqual([]);

        await setExtensionStorage(context, { ilap_curator_queue: [{
            id: 'job_1', type: 'curator', curatorId: '1', curatorName: 'C1', filter: 'not_recommended',
            appids: ['1'], total: 1, status: 'paused',
        }] });
        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer .queue-act').first()).toBeVisible();
        expect(await page.evaluate(unnamedControls)).toEqual([]);
    });

    test('all text meets the contrast minimum', async ({ page, context }) => {
        await openPopup(page, context);
        // Let the entrance transitions settle before reading colours.
        await page.waitForTimeout(500);
        expect(await page.evaluate(lowContrastText)).toEqual([]);
        for (const tab of ['ai', 'lang', 'settings']) {
            await page.locator('#tab-' + tab).click();
            await page.waitForTimeout(500);
            expect(await page.evaluate(lowContrastText), tab).toEqual([]);
        }
        await page.locator('#lists-btn').click();
        await page.waitForTimeout(500);
        expect(await page.evaluate(lowContrastText), 'lists drawer').toEqual([]);
        await page.locator('#queue-btn').click();
        await page.waitForTimeout(500);
        expect(await page.evaluate(lowContrastText), 'queue drawer').toEqual([]);
    });

    test('the hidden inputs behind switches and droplists show their keyboard focus', async ({ page, context }) => {
        await openPopup(page, context);
        const ring = (sel) => page.locator(sel).evaluate(el => getComputedStyle(el).outlineStyle);

        await tabTo(page, '#master-toggle');
        expect(await ring('#popup-root h3 .slider')).toBe('solid');

        await page.locator('#tab-settings').click();
        await page.evaluate(() => document.querySelectorAll('#settings-placeholder details').forEach(d => { d.open = true; }));
        await tabTo(page, '#q-mode-toggle');
        expect(await ring('#q-mode-toggle >> xpath=..')).toBe('solid');
        await tabTo(page, '#mask-toggle');
        expect(await ring('#mask-toggle + .slider')).toBe('solid');
        await tabTo(page, '#default-key');
        expect(await ring('#default-key-display')).toBe('solid');

        // The real <select> is the keyboard's way in: an arrow picks the next
        // binding, and the drawn display follows.
        const before = await page.locator('#default-key-display').textContent();
        await page.keyboard.press('ArrowDown');
        await expect(page.locator('#default-key-display')).not.toHaveText(before);
    });

    test('the tab line names a focused glyph in its tooltip, and the panel is named by its tab', async ({ page, context }) => {
        await openPopup(page, context);
        await tabTo(page, '#lists-btn');
        await expect(page.locator('#tab-tip')).toHaveClass(/show/);
        await expect(page.locator('#tab-tip')).toHaveText('Built-in ignore lists');
        await page.keyboard.press('Tab');
        await expect(page.locator('#tab-tip')).toHaveText('AI-generated content filtration settings');
        await expect(page.locator('#tab-tip')).toHaveCSS('transition-delay', /^1s/);

        await page.keyboard.press('Enter');
        await expect(page.locator('#tab-panel')).toHaveAttribute('aria-labelledby', 'tab-ai');
    });

    test('the queue icon is named by its aria-label alone, with no tooltip', async ({ page, context }) => {
        await openPopup(page, context);
        await expect(page.locator('#queue-btn')).toHaveAttribute('aria-label', 'Ignore Tasks Queue');
        await expect(page.locator('.queue-tip')).toHaveCount(0);
    });

    test('the count tip shows on keyboard focus', async ({ page, context }) => {
        await openPopup(page, context);
        await tabTo(page, '#count-link');
        await expect(page.locator('#count-tip')).toBeVisible();
    });

    test('keyboard focus on Recent shows the history, and Enter opens an entry', async ({ page, context }) => {
        await context.route('https://store.steampowered.com/app/**', (route) => route.fulfill({ body: '<html></html>', contentType: 'text/html' }));
        await openPopup(page, context);
        await tabTo(page, '#last-ignored-row');
        await expect(page.locator('#last-ignored-row')).toHaveAttribute('role', 'link');
        await expect(page.locator('#history-list')).toBeVisible();

        await page.keyboard.press('Tab');
        const entry = page.locator('#history-list .history-entry').first();
        await expect(entry).toBeFocused();
        await expect(page.locator('#history-list')).toBeVisible();
        const opened = context.waitForEvent('page');
        await page.keyboard.press('Enter');
        expect((await opened).url()).toContain('/app/621/');
    });

    test('the language tab opens from the keyboard onto a grid with one tab stop: arrows move, Enter picks, Escape folds', async ({ page, context }) => {
        await openPopup(page, context);
        await tabTo(page, '#tab-ai');
        await page.keyboard.press('ArrowRight');
        await expect(page.locator('#tab-lang')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.locator('#tab-lang')).toHaveAttribute('aria-selected', 'true');
        // The grid comes next in the Tab order, on the current language.
        await page.keyboard.press('Tab');
        await expect(page.locator('.lang-opt[data-lang="en"]')).toBeFocused();
        await expect(page.locator('.lang-opt[tabindex="0"]')).toHaveCount(1);

        await page.keyboard.press('Escape');
        await expect(page.locator('#tab-lang')).toHaveAttribute('aria-selected', 'false');
        await expect(page.locator('#tab-lang')).toBeFocused();

        await page.keyboard.press('Enter');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Home');
        const first = await page.locator('.lang-opt').first().getAttribute('data-lang');
        await expect(page.locator('.lang-opt').first()).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(page.locator('.lang-opt').nth(2)).toBeFocused();
        // Focus alone switches nothing.
        await expect(page.locator('html')).toHaveAttribute('lang', 'en');
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('Enter');
        await expect(page.locator('html')).toHaveAttribute('lang', first);
        // The pick folds the tab and gives the focus back to it.
        await expect(page.locator('#tab-lang')).toBeFocused();
        await expect(page.locator('#tab-lang')).toHaveAttribute('aria-selected', 'false');
    });

    test('Escape shuts the undo menu and gives the focus back to its button', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ignore_log: [1, 2].map(a => ({ appid: String(a), ts: Date.now(), source: 'mi' })) });
        await openPopup(page, context);
        await expect(page.locator('#undo-btn')).toBeEnabled();
        await page.locator('#undo-btn').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#undo-menu')).toHaveClass(/open/);
        await expect(page.locator('#undo-time')).toHaveAccessibleName(/./);
        await page.locator('#undo-unit-d').click();
        await expect(page.locator('#undo-unit-d')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#undo-unit-h')).toHaveAttribute('aria-pressed', 'false');

        await page.locator('#undo-count').focus();
        await page.keyboard.press('Escape');
        await expect(page.locator('#undo-menu')).not.toHaveClass(/open/);
        await expect(page.locator('#undo-btn')).toBeFocused();
    });

    test('the lists drawer opened from the keyboard takes the focus, and its year list walks by arrows', async ({ page, context }) => {
        await openPopup(page, context);
        await tabTo(page, '#lists-btn');
        await page.keyboard.press('Enter');
        await expect(page.locator('#lists-drawer .ai-year')).toBeFocused();

        await page.keyboard.press('Enter');
        await expect(page.locator('.ai-years')).toHaveClass(/open/);
        const opts = page.locator('.ai-opt');
        const at = await opts.evaluateAll(els => els.indexOf(document.activeElement));
        await page.keyboard.press('Home');
        await expect(opts.first()).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(opts.nth(1)).toBeFocused();
        expect(at).toBeGreaterThanOrEqual(0);
        // The list is one Tab stop: Tab leaves it at once.
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.activeElement.classList.contains('ai-opt'))).toBe(false);
        await page.keyboard.press('Shift+Tab');

        await page.keyboard.press('Escape');
        await expect(page.locator('.ai-years')).not.toHaveClass(/open/);
        await page.keyboard.press('Escape');
        await expect(page.locator('#lists-btn')).toBeFocused();
        await expect(page.locator('#lists-btn')).toHaveAttribute('aria-expanded', 'false');
    });

    test('with the queue over the panel, Tab keeps to the header and the queue, and each strip button names its job', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [
            { id: 'job_1', type: 'curator', curatorId: '1', curatorName: 'C1', filter: 'not_recommended', appids: ['1'], total: 1, status: 'pending' },
            { id: 'job_2', type: 'curator', curatorId: '2', curatorName: 'C2', filter: 'not_recommended', appids: ['2'], total: 1, status: 'paused' },
        ] });
        await openPopup(page, context);
        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer')).toHaveClass(/open/);
        await expect(page.locator('.queue-act.is-pause')).toHaveAccessibleName('Pause: C1');
        await expect(page.locator('.queue-act.is-play')).toHaveAccessibleName('Resume: C2');
        await expect(page.locator('.queue-act-del').nth(1)).toHaveAccessibleName('Remove: C2');
        // The dimmed panel is out of reach: twenty presses never land in it.
        const stops = new Set();
        for (let i = 0; i < 20; i++) {
            await page.keyboard.press('Tab');
            stops.add(await page.evaluate(() => document.activeElement.id || document.activeElement.className));
        }
        for (const id of ['count-link', 'last-ignored-row', 'lists-btn']) expect(stops).not.toContain(id);
        expect(stops).toContain('queue-btn');
        // Shut, the panel is back in reach.
        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer')).not.toHaveClass(/open/);
        await tabTo(page, '#count-link');
    });
});
