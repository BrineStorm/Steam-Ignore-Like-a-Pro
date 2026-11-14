const { test, expect } = require('../_fixtures.js');
const path = require('path');

// ActionUI badge rendering (src/explore-queue/ui.js _setupMicroBadge): the
// IGNORED / SPARED plate must sit toward the upper-RIGHT of the ignore button
// (~2/3 across), not centred, and must read in the past tense. This is a pure
// DOM concern, so we load ui.js into a blank page (main world, stubbed ILAP) and
// drive applyVisuals directly — no Steam login, no queue, no real ignore.

async function mountUI(page) {
    await page.goto('about:blank');
    await page.evaluate(() => {
        window.ILAP = {
            Sanitizer: { escapeHTML: (s) => String(s == null ? '' : s) },
            t: (k) => k,
            Explore: {}
        };
    });
    await page.addScriptTag({
        path: path.join(__dirname, '..', '..', 'src', 'explore-queue', 'ui.js')
    });
}

test('clearVisuals gives the card back the inline styles Steam gave it', async ({ page }) => {
    // Steam renders #ignoreBtn with an inline `position: relative; display: flex`.
    // Turning the extension off must strip what WE drew and nothing of Steam's:
    // a reset to '' would break Steam's own layout of the button.
    await mountUI(page);
    const styles = await page.evaluate(async () => {
        document.body.innerHTML = '';
        const container = document.createElement('div');
        container.id = 'ignoreBtn';
        container.style.cssText = 'position: sticky; display: flex; box-shadow: none;';
        document.body.appendChild(container);
        const colors = { RED_BG: '#c0392b', BLUE_BG: '#3498db', BADGE_BLUE_BG: '#2980b9' };
        const ui = new window.ILAP.Explore.UI({ getIconUrl: () => 'icon16.png' }, colors, () => container);
        const read = () => ({ position: container.style.position, display: container.style.display,
            boxShadow: container.style.boxShadow, badges: container.querySelectorAll('.ilap-micro-badge').length });
        ui.applyVisuals('IGNORE', 'bad');
        const drawn = read();
        ui.applyVisuals('IGNORE', 'bad');   // a second paint must not record OUR styles as Steam's
        ui.clearVisuals();
        // The micro-badge fades out before it goes.
        await new Promise(r => setTimeout(r, 400));
        return { drawn, cleared: read() };
    });
    expect(styles.drawn.position).toBe('relative');
    expect(styles.drawn.badges).toBe(1);
    expect(styles.cleared).toEqual({ position: 'sticky', display: 'flex', boxShadow: 'none', badges: 0 });
});

// Render a badge of the given decision type and report its placement + label.
async function renderBadge(page, type) {
    return page.evaluate((t) => {
        document.body.innerHTML = '';
        const container = document.createElement('div');
        container.id = 'ignoreBtn';
        container.style.cssText = 'width:140px;height:40px;';
        document.body.appendChild(container);

        const colors = { RED_BG: '#c0392b', BLUE_BG: '#3498db', BADGE_BLUE_BG: '#2980b9' };
        const resources = { getIconUrl: () => 'icon16.png' };
        const ui = new window.ILAP.Explore.UI(resources, colors, () => container);
        ui.applyVisuals(t, 'bad');

        const badge = container.querySelector('.ilap-micro-badge');
        return { left: badge.style.left, transform: badge.style.transform, text: badge.textContent.trim() };
    }, type);
}

test.describe('Explore Queue — badge placement (DOM)', () => {

    test('SPARED plate reads past-tense and sits right-of-centre (~2/3)', async ({ page }) => {
        await mountUI(page);
        const b = await renderBadge(page, 'SPARE');

        expect(b.text).toBe('SPARED');
        // Anchored at 2/3 across, not the old centred 50%.
        expect(b.left).toBe('66%');
        expect(parseFloat(b.left)).toBeGreaterThan(50);
        expect(b.transform).toContain('translateX(-50%)');
    });

    test('IGNORED plate reads past-tense and sits right-of-centre (~2/3)', async ({ page }) => {
        await mountUI(page);
        const b = await renderBadge(page, 'IGNORE');

        expect(b.text).toBe('IGNORED');
        expect(b.left).toBe('66%');
        expect(parseFloat(b.left)).toBeGreaterThan(50);
    });

    // Regression: in German the criterion row ("Ignorier-Kriterium -") wrapped and
    // orphaned the dash on its own line. The label span must not wrap.
    test('tooltip criterion label is no-wrap (dash never orphans)', async ({ page }) => {
        await mountUI(page);
        const criterion = await page.evaluate(() => {
            document.body.innerHTML = '';
            const container = document.createElement('div');
            container.id = 'ignoreBtn';
            container.style.cssText = 'width:140px;height:40px;';
            document.body.appendChild(container);
            const ui = new window.ILAP.Explore.UI(
                { getIconUrl: () => 'icon16.png' },
                { RED_BG: '#c0392b', BLUE_BG: '#3498db', BADGE_BLUE_BG: '#2980b9' },
                () => container
            );
            ui.applyVisuals('NO_REVIEWS', 'bad');
            // The criterion label is the first span inside the tooltip's second row.
            const span = container.querySelector('.ilap-tooltip span[style*="nowrap"]');
            return span ? span.style.whiteSpace : null;
        });
        expect(criterion).toBe('nowrap');
    });
});

// The list frame (src/manual-ignore/list-frame.js) draws with its own ActionUI
// on the same button: a list that ignored the game outranks the Queue Helper's
// verdict, and either one's clear gives Steam's styles back.
test('the list frame outranks the Queue Helper\'s verdict on the same button', async ({ page }) => {
    await mountUI(page);
    const out = await page.evaluate(async () => {
        document.body.innerHTML = '';
        const container = document.createElement('div');
        container.id = 'ignoreBtn';
        container.style.cssText = 'position: relative; display: flex;';
        document.body.appendChild(container);
        const colors = { RED_BG: '#c0392b', BLUE_BG: '#3498db', BADGE_BLUE_BG: '#2980b9' };
        const make = () => new window.ILAP.Explore.UI({ getIconUrl: () => 'icon16.png' }, colors, () => container);
        const helper = make(), frame = make();
        const text = () => Array.from(container.querySelectorAll('.ilap-tooltip span'))
            .map(s => s.textContent.trim()).join(' | ');
        helper.applyVisuals('SPARE', 'bad');
        frame.applyVisuals('LIST', null, { text: 'Ignored by a built-in list', name: 'Denuvo DRM', date: 'Oct 12, 2026' });
        const drawn = text();
        helper.applyVisuals('IGNORE', 'bad');   // the helper's later verdict yields
        const kept = { text: text(), badges: container.querySelectorAll('.ilap-micro-badge').length };
        frame.clearVisuals();
        await new Promise(r => setTimeout(r, 400));
        const cleared = { boxShadow: container.style.boxShadow, position: container.style.position, mark: container.dataset.ilapListFrame };
        helper.applyVisuals('IGNORE', 'bad');   // and draws again once the frame is gone
        return { drawn, kept, cleared, after: container.querySelector('.ilap-micro-badge').textContent };
    });
    expect(out.drawn).toBe('Ignored by a built-in list | Denuvo DRM | Oct 12, 2026');
    expect(out.kept).toEqual({ text: out.drawn, badges: 1 });
    // Steam's own inline styles, though the helper drew first.
    expect(out.cleared).toEqual({ boxShadow: '', position: 'relative', mark: undefined });
    expect(out.after).toBe('IGNORED');
});

test('the plate\'s capitals sit in its middle, on any page\'s line height', async ({ page }) => {
    await mountUI(page);
    const out = await page.evaluate(() => {
        document.body.innerHTML = '';
        document.body.style.lineHeight = '19px';   // a page's own line, which the plate must not take
        const container = document.createElement('div');
        container.id = 'ignoreBtn';
        container.style.cssText = 'position: relative; width: 140px; height: 32px;';
        document.body.appendChild(container);
        const colors = { RED_BG: '#c0392b', BLUE_BG: '#3498db', BADGE_BLUE_BG: '#2980b9' };
        new window.ILAP.Explore.UI({ getIconUrl: () => 'icon16.png' }, colors, () => container).applyVisuals('LIST', null, { text: 'x' });
        const cs = getComputedStyle(container.querySelector('.ilap-micro-badge'));
        return { lineHeight: cs.lineHeight, top: cs.paddingTop, bottom: cs.paddingBottom };
    });
    expect(out).toEqual({ lineHeight: '8px', top: '2px', bottom: '2px' });
});
