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
