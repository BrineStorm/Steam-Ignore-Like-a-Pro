// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ContainerStrategyProvider Fallback strategy (src/manual-ignore/utils.js) —
// where the IGNORED badge anchors on a sale/discount capsule. utils.js is an
// IIFE that evals with no chrome/document at load time, so it runs in Node
// (vm + a window stub). The badge is CSS-anchored bottom:0 of its target; on a
// tall multi-row card (a.sale_capsule: cover art, then tag rows, then a price
// row) targeting the whole link drops the badge on the price. The fallback must
// prefer the cover-art container so the badge sits on the image.
function loadProvider() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'manual-ignore', 'utils.js'),
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
