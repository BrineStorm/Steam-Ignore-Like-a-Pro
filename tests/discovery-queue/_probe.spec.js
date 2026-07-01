const { test, expect } = require('../_fixtures.js');
const fs = require('fs');
const path = require('path');

// READ-ONLY probe of the Discovery Queue modal DOM. Does NOT click Start, so it
// ignores nothing. Dumps the structure around the active card + all candidate
// anchors (aria/data/role/class/svg-path) so we can pick robuster selectors.
const SEL = {
    queueSection: '.SaleSectionCtn.discoveryqueue',
    queueWidget: '.SaleSectionCtn.discoveryqueue div[role="button"]',
    modal: '.FullModalOverlay div[role="dialog"]',
};

async function openQueueModal(page) {
    await page.goto('/tags/en/Collectathon', { waitUntil: 'domcontentloaded' });
    // The discoveryqueue section is lazy-rendered below the fold — scroll until
    // it attaches, then click its inner clickable carousel card (role=button).
    const section = page.locator(SEL.queueSection).first();
    for (let i = 0; i < 10 && !(await section.count()); i++) {
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(500);
    }
    await section.waitFor({ state: 'attached', timeout: 20000 });
    await section.scrollIntoViewIfNeeded();
    const widget = page.locator(SEL.queueWidget).first();
    await widget.waitFor({ state: 'visible', timeout: 20000 });
    await widget.click();
    const modal = page.locator(SEL.modal).first();
    await modal.waitFor({ state: 'visible', timeout: 20000 });
    return modal;
}

test('PROBE: dump DQ modal anchors', async ({ page }) => {
    test.setTimeout(90_000);
    await openQueueModal(page);
    // Let the carousel settle.
    await page.waitForTimeout(2500);

    const dump = await page.evaluate(() => {
        const dialog = document.querySelector('.FullModalOverlay div[role="dialog"]');
        if (!dialog) return { error: 'no dialog' };

        const attrsOf = (el) => {
            const o = {};
            for (const a of el.attributes) o[a.name] = a.value.slice(0, 120);
            return o;
        };
        const brief = (el) => el ? {
            tag: el.tagName,
            cls: el.className && el.className.toString().slice(0, 200),
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            ariaPressed: el.getAttribute('aria-pressed'),
            data: Object.fromEntries(Object.entries(attrsOf(el)).filter(([k]) => k.startsWith('data-'))),
        } : null;

        // Current getActiveSlide logic, so we can compare.
        const hashed = dialog.querySelector('._3q6eNRFBrPSFSGEn8uRFZ3');
        const genericParent = dialog.querySelector('div[class*="Focusable"][class*="Panel"]')?.parentElement;

        const describeContainer = (c, label) => {
            if (!c) return { label, found: false };
            return {
                label, found: true,
                self: brief(c),
                childCount: c.children.length,
                children: Array.from(c.children).map((ch, i) => ({
                    i, ...brief(ch),
                    hasAppLink: !!ch.querySelector('a[href*="/app/"]'),
                    hasIgnorePath: !!Array.from(ch.querySelectorAll('path')).find(p => (p.getAttribute('d') || '').startsWith('M600,96c')),
                })),
            };
        };

        // All svg path d-prefixes present (first 14 chars), de-duped with counts.
        const pathCounts = {};
        dialog.querySelectorAll('path').forEach(p => {
            const d = (p.getAttribute('d') || '').slice(0, 14);
            if (d) pathCounts[d] = (pathCounts[d] || 0) + 1;
        });

        // Focusable candidates with any aria-label (buttons like Ignore/Next).
        const labelled = Array.from(dialog.querySelectorAll('[aria-label]')).map(brief).slice(0, 40);

        // Elements carrying data-* attributes (potential stable hooks).
        const dataEls = Array.from(dialog.querySelectorAll('[data-ds-appid],[data-panel],[data-featuretarget],[data-tab]'))
            .map(brief).slice(0, 40);

        return {
            dialogClass: dialog.className.toString().slice(0, 200),
            activeByHashed: describeContainer(hashed, 'hashed ._3q6eNRFBrPSFSGEn8uRFZ3'),
            activeByGenericParent: describeContainer(genericParent, 'generic Focusable-Panel parent'),
            pathCounts,
            labelled,
            dataEls,
        };
    });

    const out = path.join(
        process.env.TEMP || '/tmp',
        'dq-probe.json'
    );
    fs.writeFileSync(out, JSON.stringify(dump, null, 2));
    console.log('PROBE written to', out);
    console.log(JSON.stringify(dump, null, 2).slice(0, 6000));
    expect(dump.error).toBeUndefined();
});
