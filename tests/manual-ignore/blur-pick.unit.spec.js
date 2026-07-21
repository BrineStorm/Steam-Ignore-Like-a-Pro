// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// BadgeRenderer._applyBlur / _pickArts (src/manual-ignore/ui.js) — how an ignored
// capsule's cover art gets blurred. ui.js is a self-contained IIFE, so it loads in
// Node (vm + a window stub) and _applyBlur is driven against a hand-rolled fake
// DOM — no browser, no live Steam. Two paths: the per-element filter blur (an
// <img>/<video> cover) and, when the cover is a CSS background on the badge's own
// element, a backdrop veil laid under the badge. The geometry (clientWidth/Height)
// both gate on is impossible to fake reliably in the heavy tag-page E2E, so the
// guards are asserted here.
function loadBadgeRenderer() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'manual-ignore', 'ui.js'),
        'utf8'
    );
    const sandbox = {
        window: { ILAP: { Sanitizer: { escapeHTML: (s) => s }, ManualIgnore: {} } },
        document: { createElement: () => ({ className: '', dataset: {} }) },
        // _hasOwnCoverBackground reads the host's background via getComputedStyle;
        // the double surfaces the fake element's `bg`, defaulting to 'none'.
        getComputedStyle: (element) => ({ backgroundImage: element.bg || 'none' }),
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.ManualIgnore.BadgeRenderer;
}

// Minimal media double covering only what _pickArts touches: getAttribute('src'),
// closest('.ilap-ignored-overlay'), clientWidth/Height, classList, dataset.
function el(tag, { src = '', w = 0, h = 0, inOverlay = false } = {}) {
    const classes = new Set();
    return {
        tagName: tag.toUpperCase(),
        clientWidth: w,
        clientHeight: h,
        dataset: {},
        getAttribute: (name) => (name === 'src' ? src : null),
        closest: (sel) => (sel === '.ilap-ignored-overlay' && inOverlay ? {} : null),
        classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) },
        get _blurred() { return classes.has('ilap-ignored-blur'); },
    };
}

// The badge target (host). `bg`/`w`/`h` drive _hasOwnCoverBackground; `media` is
// what the 'img, video' query returns; injected backdrop veils land in _children.
function host(media, { bg = 'none', w = 0, h = 0 } = {}) {
    const children = [];
    return {
        bg,
        clientWidth: w,
        clientHeight: h,
        querySelectorAll: (sel) => (sel === 'img, video' ? media : []),
        querySelector: (sel) => (sel.includes('ilap-blur-backdrop')
            ? children.find(c => c.className === 'ilap-blur-backdrop') || null
            : null),
        appendChild: (c) => children.push(c),
        get _veils() { return children.filter(c => c.className === 'ilap-blur-backdrop'); },
    };
}

function applyBlur(media, opts = {}) {
    const BadgeRenderer = loadBadgeRenderer();
    const renderer = new BadgeRenderer(null, null, null, null, null);
    const h = host(media, opts);
    renderer._applyBlur(h, '3354220');
    return h;
}

test('microtrailer capsule: both the resting img and the overlay video get blurred', () => {
    // The reported bug: a daily-deal capsule with a preload="none" microtrailer
    // <video> that overlays the header <img> 1:1. The video won on area but is
    // invisible until hover, so blurring only it left the visible image sharp.
    const img = el('img', { src: 'header.jpg', w: 300, h: 145 });
    const video = el('video', { src: 'microtrailer.webm', w: 300, h: 145 });
    applyBlur([img, video]);
    expect(img._blurred, 'resting cover image must be blurred').toBe(true);
    expect(video._blurred, 'hover microtrailer must also be blurred').toBe(true);
});

test('small decorative media (platform/discount icon) is NOT blurred', () => {
    // Over-blur guard: only cover-sized media get the filter; a tiny icon in the
    // same capsule must stay sharp.
    const cover = el('img', { src: 'header.jpg', w: 300, h: 145 });
    const icon = el('img', { src: 'win.png', w: 16, h: 16 });
    applyBlur([cover, icon]);
    expect(cover._blurred).toBe(true);
    expect(icon._blurred, 'a small decorative icon must not be blurred').toBe(false);
});

test('blank.gif spacer and the badge tooltip icon are skipped', () => {
    const spacer = el('img', { src: 'https://x/blank.gif', w: 300, h: 145 });
    const tooltipIcon = el('img', { src: 'icon16.png', w: 300, h: 145, inOverlay: true });
    const cover = el('img', { src: 'header.jpg', w: 300, h: 145 });
    applyBlur([spacer, tooltipIcon, cover]);
    expect(cover._blurred).toBe(true);
    expect(spacer._blurred, 'transparent blank.gif spacer must not be blurred').toBe(false);
    expect(tooltipIcon._blurred, 'our own badge tooltip icon must not be blurred').toBe(false);
});

test('no layout yet (all zero-area): falls back to a single pick', () => {
    // Pre-render there is no geometry; keep the prior single-element behaviour
    // rather than blurring everything.
    const a = el('img', { src: 'header.jpg', w: 0, h: 0 });
    const b = el('video', { src: 'microtrailer.webm', w: 0, h: 0 });
    applyBlur([a, b]);
    expect(a._blurred).toBe(true);
    expect(b._blurred).toBe(false);
});

test('Featured & Recommended: cover as a CSS background on the badge element → a blur veil is laid under the badge', () => {
    // The reported case: the main capsule paints its resting cover as a
    // background-image on the very element that holds the badge (with only a hover
    // <video> as a real element). filter:blur there would smear the badge, so a
    // backdrop veil is injected instead — it blurs the art in every state.
    const video = el('video', { src: 'microtrailer.webm', w: 840, h: 481 });
    const h = applyBlur([video], { bg: 'url("header.jpg")', w: 756, h: 433 });
    expect(h._veils.length, 'one backdrop veil is injected under the badge').toBe(1);
    expect(video._blurred, 'no per-element class blur on this surface — the veil covers it').toBe(false);
});

test('backdrop path is idempotent: a re-render / syncMasks does not stack veils', () => {
    const video = el('video', { src: 'microtrailer.webm', w: 840, h: 481 });
    const BadgeRenderer = loadBadgeRenderer();
    const renderer = new BadgeRenderer(null, null, null, null, null);
    const h = host([video], { bg: 'url("header.jpg")', w: 756, h: 433 });
    renderer._applyBlur(h, '111');
    renderer._applyBlur(h, '111');
    expect(h._veils.length, 'the second pass finds the existing veil and no-ops').toBe(1);
});

test('a small incidental background does not hijack an <img>-cover capsule', () => {
    // Size gate: a tiny background on the host must not divert a real <img> cover
    // into the backdrop path (100×100 = 10000 < the 20000 gate).
    const img = el('img', { src: 'header.jpg', w: 300, h: 145 });
    const h = applyBlur([img], { bg: 'url("noise.png")', w: 100, h: 100 });
    expect(h._veils.length, 'below the size gate → no veil').toBe(0);
    expect(img._blurred, 'falls through to the normal per-element blur').toBe(true);
});
