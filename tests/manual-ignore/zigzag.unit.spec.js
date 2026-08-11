// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ZigzagTracker (src/manual-ignore/utils.js) — the solo-un-ignore gesture.
// utils.js is an IIFE that evals with no chrome/document, so it runs in Node.
//
// The tracker measures the X axis ONLY, the same rule the swipe uses (see
// decisions.md: direction from dx alone is deliberate). The consequence is
// asserted below: a circle traced clockwise and one traced counter-clockwise are
// indistinguishable here, so the gesture is "a circle either way, or a zigzag".
// What must NOT happen is a normal swipe — or hand jitter during one — being
// read as a zigzag, because that would un-ignore the game the user just ignored.
function loadTracker() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'manual-ignore', 'utils.js'), 'utf8');
    const sandbox = { window: {}, Math, Set, Array, Object, String };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.ManualIgnore.ZigzagTracker;
}

// Replay an x-coordinate trajectory through the tracker.
function trace(xs) {
    const t = new (loadTracker())();
    t.reset(xs[0]);
    for (const x of xs.slice(1)) t.move(x);
    return t.isZigzag();
}

// Sample a circle of `r` px into `steps` points. `dir` +1 = counter-clockwise,
// -1 = clockwise. Only the x coordinates reach the tracker.
function circleXs(cx, r, dir, steps = 24) {
    const xs = [];
    for (let i = 0; i <= steps; i++) {
        const a = dir * (i / steps) * 2 * Math.PI;
        xs.push(Math.round(cx + r * Math.cos(a)));
    }
    return xs;
}

test('a plain right swipe is NOT a zigzag (one leg, no reversal)', () => {
    expect(trace([100, 120, 150, 180, 210])).toBe(false);
});

test('a plain left swipe is NOT a zigzag', () => {
    expect(trace([300, 280, 250, 210, 170])).toBe(false);
});

test('jitter at the end of a swipe does not turn it into a zigzag', () => {
    // The hand drifts back ~8 px on release — under the reversal hysteresis, and
    // nowhere near a full leg. This is the false positive that would silently
    // un-ignore a game the swipe just ignored.
    expect(trace([100, 140, 180, 220, 216, 214, 212])).toBe(false);
});

test('a backtrack past the hysteresis but under a full leg still is NOT a zigzag', () => {
    // 20 px back: decisive enough to count as a turn, too short to be deliberate.
    expect(trace([100, 140, 180, 175, 168, 160])).toBe(false);
});

test('a right-left zigzag fires', () => {
    expect(trace([100, 130, 160, 190, 160, 130, 100])).toBe(true);
});

test('a left-right zigzag fires too (the axis has no preferred order)', () => {
    expect(trace([300, 270, 240, 210, 240, 270, 300])).toBe(true);
});

test('a counter-clockwise circle fires', () => {
    expect(trace(circleXs(200, 45, +1))).toBe(true);
});

test('a clockwise circle fires identically — X alone cannot tell them apart', () => {
    // Documented consequence of the X-only rule, not an oversight: distinguishing
    // the two would need dy, which decisions.md rules out for these gestures.
    expect(trace(circleXs(200, 45, -1))).toBe(true);
});

test('a circle too small to be deliberate does not fire', () => {
    // r=12 → legs of ~24 px, under the 30 px minimum.
    expect(trace(circleXs(200, 12, +1))).toBe(false);
});

test('a stationary right-click is not a gesture', () => {
    expect(trace([150, 150, 150])).toBe(false);
});

test('three legs still count (the first two decide)', () => {
    expect(trace([100, 140, 180, 140, 100, 140, 180])).toBe(true);
});
