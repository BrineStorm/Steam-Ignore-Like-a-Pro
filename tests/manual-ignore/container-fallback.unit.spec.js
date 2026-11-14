// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ContainerStrategyProvider Fallback strategy (src/manual-ignore/containers.js) —
// where the IGNORED badge anchors on a sale/discount capsule. containers.js is an
// IIFE that evals with no chrome/document at load time, so it runs in Node
// (vm + a window stub). The badge is CSS-anchored bottom:0 of its target; on a
// tall multi-row card (a.sale_capsule: cover art, then tag rows, then a price
// row) targeting the whole link drops the badge on the price. The fallback must
// prefer the cover-art container so the badge sits on the image.
function loadProvider() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'manual-ignore', 'containers.js'),
        'utf8'
    );
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.ManualIgnore.ContainerStrategyProvider;
}

function fallbackStrategy() {
    const provider = new (loadProvider())();
    return provider.strategies.find((s) => s.name === 'Fallback');
}

// Link double: querySelector returns `imgCtn` for the cover-container selector,
// null otherwise (mirrors a link that does / doesn't wrap a .capsule_image_ctn).
function link(imgCtn) {
    return {
        tagName: 'A',
        querySelector: (sel) => (imgCtn && sel.includes('capsule_image_ctn') ? imgCtn : null),
    };
}

test('sale-capsule link: badge target is the cover-art container, not the tall link', () => {
    const imgCtn = { tagName: 'DIV' };
    const result = fallbackStrategy().resolve(link(imgCtn));
    expect(result.element, 'badge anchors to the image container so it sits on the cover').toBe(imgCtn);
    expect(result.type).toBe('grid');
});

test('plain link with no cover-art container: falls back to the link itself', () => {
    const el = link(null);
    const result = fallbackStrategy().resolve(el);
    expect(result.element, 'no cover container to prefer → unchanged behaviour').toBe(el);
    expect(result.type).toBe('grid');
});

// coverOf: where the AI mark and the shot land on a capsule. A row many times
// wider than tall (a search or bundle row, a home tab row) takes its cover's
// box, so nothing lands over its title or price. Anything else is the host.
test.describe('ContainerStrategyProvider.coverOf (unit)', () => {
    const provider = () => new (loadProvider())();
    const img = (w, h, { src = 'cap.jpg', inBadge = false, parent = null } = {}) => ({
        clientWidth: w, clientHeight: h, parentElement: parent,
        getAttribute: (a) => (a === 'src' ? src : null),
        closest: (sel) => (inBadge && sel.includes('ilap-ignored-overlay') ? {} : null),
    });
    const host = (w, h, imgs) => ({ clientWidth: w, clientHeight: h, querySelectorAll: () => imgs });

    test('a capsule no wider than a row is its own cover', () => {
        const box = { clientWidth: 184 };
        const cap = host(184, 69, [img(184, 69, { parent: box })]);
        expect(provider().coverOf(cap)).toBe(cap);
    });

    test('a wide row takes the box round its cover', () => {
        const box = { clientWidth: 190 };
        const row = host(900, 69, [img(184, 69, { parent: box }), img(16, 16, { parent: {} })]);
        expect(provider().coverOf(row)).toBe(box);
    });

    test('Steam\'s blank.gif spacer and our own badge\'s icon are never the cover', () => {
        const box = { clientWidth: 120 };
        const spacer = img(900, 69, { src: 'https://store.akamai.steamstatic.com/public/images/blank.gif', parent: {} });
        const icon = img(400, 69, { inBadge: true, parent: {} });
        const row = host(900, 69, [spacer, icon, img(120, 45, { parent: box })]);
        expect(provider().coverOf(row)).toBe(box);
    });

    test('a row stays the host when its cover is half the row, its box is far wider than the cover, or it has none', () => {
        const half = host(900, 69, [img(460, 69, { parent: { clientWidth: 460 } })]);
        expect(provider().coverOf(half)).toBe(half);
        const loose = host(900, 69, [img(184, 69, { parent: { clientWidth: 600 } })]);
        expect(provider().coverOf(loose)).toBe(loose);
        const bare = host(900, 69, []);
        expect(provider().coverOf(bare)).toBe(bare);
        const unlaid = host(900, 0, [img(184, 69, { parent: { clientWidth: 190 } })]);
        expect(provider().coverOf(unlaid)).toBe(unlaid);
    });

    test('a cover whose box is the host itself leaves the host', () => {
        const row = host(900, 69, []);
        row.querySelectorAll = () => [img(184, 69, { parent: row })];
        expect(provider().coverOf(row)).toBe(row);
    });
});
