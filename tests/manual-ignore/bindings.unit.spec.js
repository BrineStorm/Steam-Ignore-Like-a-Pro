// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Binding resolution (src/manual-ignore/utils.js): which of the THREE actions —
// ignore, already-played, un-ignore — a click or a swipe resolves to.
//
// The un-ignore binding now draws from the same vocabulary as the two ignore
// ones, so "one binding, one action" is enforced by the popup's cross-guard
// rather than by disjoint value sets. That guard lives in the UI and a
// hand-edited storage key walks straight past it, which makes the resolvers'
// precedence a contract of its own: the ignore bindings are read FIRST, so a
// value bound twice costs the rollback, never the ignore.
//
// utils.js is an IIFE that evals with no chrome/document, so it runs in Node —
// same harness as zigzag.unit.spec.js.
function loadMI() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'manual-ignore', 'utils.js'), 'utf8');
    const sandbox = { window: {}, Math, Set, Array, Object, String };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.ManualIgnore;
}

const APPID = '440';

// The shipped defaults (see boot() in manual-ignore/main.js), overridable.
const configOf = (over) => ({
    get: () => Object.assign({
        defaultKey: 'swipeRight',
        platformKey: 'swipeLeft',
        unignoreKey: 'zigzag',
        enabled: true,
    }, over),
});

// A capsule link, as the resolvers see it: the event target IS the /app/ anchor.
const linkEl = () => ({
    closest: (sel) => (sel.includes('/app/')
        ? { getAttribute: () => `/app/${APPID}/Team_Fortress_2/` }
        : null),
});

const clickEvent = (mods) => Object.assign({ target: linkEl() }, mods);

// Replay a pointer trajectory (x coordinates) as a held right-click gesture.
function gesture(config, xs) {
    const MI = loadMI();
    const detector = new MI.SwipeGestureDetector(configOf(config));
    let fired = null;
    detector.attach({ addEventListener: () => {} }, (data) => { fired = data; });

    const el = linkEl();
    detector.onMouseDown({ isTrusted: true, button: 2, clientX: xs[0], clientY: 0, target: el });
    for (const x of xs.slice(1)) detector.onMouseMove({ isTrusted: true, clientX: x });
    detector.onMouseUp({ isTrusted: true, button: 2, clientX: xs[xs.length - 1], clientY: 0 });
    return fired;
}

// A straight swipe: one intermediate move is all it needs (ZigzagTracker banks
// no reversal from it).
const swipeOutcome = (config, dx) => gesture(config, [0, dx / 2, dx]);

// …and the circle's X trace: out and back, both legs past the 30 px minimum.
const circleOutcome = (config) =>
    gesture(config, [100, 130, 160, 190, 160, 130, 100]);

function clickOutcome(config, mods) {
    const MI = loadMI();
    return new MI.EventParser(configOf(config)).parseClick(clickEvent(mods));
}

test.describe('modifier-click resolution', () => {

    test('a modifier bound to the un-ignore resolves to the rollback', () => {
        const intent = clickOutcome({ unignoreKey: 'ctrlKey' }, { ctrlKey: true });
        expect(intent).toMatchObject({ appid: APPID, action: 'unignore' });
    });

    test('the ignore bindings still resolve to an ignore, with their reason', () => {
        expect(clickOutcome({ defaultKey: 'ctrlKey', unignoreKey: 'altKey' }, { ctrlKey: true }))
            .toMatchObject({ appid: APPID, reason: 0 });
        expect(clickOutcome({ platformKey: 'shiftKey', unignoreKey: 'altKey' }, { shiftKey: true }))
            .toMatchObject({ appid: APPID, reason: 2 });
    });

    test('a modifier bound twice goes to the IGNORE, not the rollback', () => {
        // Unreachable from the popup (the three selects cross-guard each other),
        // so this is the hand-edited-storage case: it must not cost the user the
        // ignore they were trying to perform.
        const intent = clickOutcome({ defaultKey: 'ctrlKey', unignoreKey: 'ctrlKey' }, { ctrlKey: true });
        expect(intent.reason).toBe(0);
        expect(intent.action).toBeUndefined();
    });

    test("un-ignore 'off' leaves modifier clicks alone", () => {
        expect(clickOutcome({ unignoreKey: 'off' }, { ctrlKey: true })).toBeNull();
    });

    test('a gesture value never matches a click (it is not a property of the event)', () => {
        expect(clickOutcome({ unignoreKey: 'zigzag' }, { ctrlKey: true })).toBeNull();
        expect(clickOutcome({ defaultKey: 'zigzag', platformKey: 'off', unignoreKey: 'off' },
            { altKey: true })).toBeNull();
    });

    test('the master toggle switches every binding off', () => {
        expect(clickOutcome({ unignoreKey: 'ctrlKey', enabled: false }, { ctrlKey: true })).toBeNull();
    });
});

test.describe('swipe resolution', () => {

    test('a swipe bound to the un-ignore rolls back instead of ignoring', () => {
        // Already Played switched off, which is what frees the left swipe — the
        // state the popup's cross-guard requires before this binding is offered.
        const fired = swipeOutcome({ platformKey: 'off', unignoreKey: 'swipeLeft' }, -60);
        expect(fired).toMatchObject({ action: 'unignore' });
        expect(fired.reason).toBeUndefined();
    });

    test('the other direction still ignores', () => {
        const fired = swipeOutcome({ platformKey: 'off', unignoreKey: 'swipeLeft' }, 60);
        expect(fired).toMatchObject({ reason: 0 });
        expect(fired.action).toBeUndefined();
    });

    test('a swipe bound twice goes to the IGNORE, not the rollback', () => {
        const fired = swipeOutcome({ unignoreKey: 'swipeLeft' }, -60);   // platformKey is swipeLeft
        expect(fired).toMatchObject({ reason: 2 });
        expect(fired.action).toBeUndefined();
    });

    test('a swipe under the distance threshold fires nothing at all', () => {
        expect(swipeOutcome({ platformKey: 'off', unignoreKey: 'swipeLeft' }, -20)).toBeNull();
    });
});

// A detector that survives several gestures, so the menu-suppression latch can
// be watched ACROSS them. `menu()` reports whether that contextmenu was
// swallowed; the two orderings below are the two platforms.
function detectorHarness(config) {
    const MI = loadMI();
    const detector = new MI.SwipeGestureDetector(configOf(config));
    let fired = null;
    detector.attach({ addEventListener: () => {} }, (data) => { fired = data; });

    const el = linkEl();
    return {
        fired: () => fired,
        down: (x) => detector.onMouseDown(
            { isTrusted: true, button: 2, clientX: x, clientY: 0, target: el }),
        move: (x) => detector.onMouseMove({ isTrusted: true, clientX: x }),
        up: (x) => {
            fired = null;
            detector.onMouseUp({ isTrusted: true, button: 2, clientX: x, clientY: 0 });
        },
        menu: () => {
            let prevented = false;
            detector.onContextMenu({
                preventDefault: () => { prevented = true; },
                stopPropagation: () => {},
            });
            return prevented;
        },
    };
}

test.describe('context-menu suppression latch', () => {

    test('Chromium ordering: a recognised gesture swallows its OWN menu, once', () => {
        // contextmenu arrives after mouse-up, so the latch armed by the gesture
        // is spent by the menu that gesture caused — and by nothing after it.
        const d = detectorHarness({});
        d.down(0); d.move(30); d.up(60);
        expect(d.fired()).toMatchObject({ reason: 0 });
        expect(d.menu()).toBe(true);
        expect(d.menu()).toBe(false);   // spent
    });

    test('Firefox ordering: a stale latch never reaches an unrelated right-click', () => {
        // Regression. Firefox dispatches contextmenu at mouse-DOWN, before
        // onMouseUp arms the latch — so a recognised gesture there leaves it
        // armed with no menu of its own left to spend it, and the NEXT,
        // unrelated right-click had its menu swallowed by a gesture that ended
        // long ago. onMouseDown clearing the latch is what closes that.
        const d = detectorHarness({});

        // Gesture 1, Firefox order: menu at mousedown (nothing armed yet), then
        // the gesture is recognised on mouseup and arms the latch.
        d.down(0);
        expect(d.menu()).toBe(false);
        d.move(30); d.up(60);
        expect(d.fired()).toMatchObject({ reason: 0 });

        // A plain right-click somewhere else: its menu must open.
        d.down(500);
        expect(d.menu()).toBe(false);
        d.up(500);
        expect(d.fired()).toBeNull();
    });

    test('a gesture bound to nothing arms nothing', () => {
        const d = detectorHarness({ defaultKey: 'ctrlKey', platformKey: 'off', unignoreKey: 'off' });
        d.down(0); d.move(30); d.up(60);
        expect(d.fired()).toBeNull();
        expect(d.menu()).toBe(false);
    });

    test('an un-ignore gesture suppresses the menu just like an ignore does', () => {
        // The rollback binding is a right-button gesture too — leaving Steam's
        // own menu to open over the capsule it just acted on would be the same
        // bug for the third action.
        const d = detectorHarness({});
        d.down(100);
        for (const x of [130, 160, 190, 160, 130, 100]) d.move(x);
        d.up(100);
        expect(d.fired()).toMatchObject({ action: 'unignore' });
        expect(d.menu()).toBe(true);
    });
});

test.describe('circle resolution', () => {

    test('the circle carries whichever action it is bound to', () => {
        // The whole point of opening it to the ignore selects: ignore by circle,
        // un-ignore by swipe is as valid a setup as the shipped default.
        expect(circleOutcome({ defaultKey: 'zigzag', unignoreKey: 'swipeRight' }))
            .toMatchObject({ reason: 0 });
        expect(circleOutcome({ platformKey: 'zigzag' })).toMatchObject({ reason: 2 });
        expect(circleOutcome({})).toMatchObject({ action: 'unignore' });   // the default
    });

    test('the circle beats the swipe it necessarily also completes', () => {
        // Its legs clear the 40 px distance threshold on their own, so resolving
        // the swipe as well would fire two bindings from one gesture. The trace
        // ends left of where it started, i.e. it would have read as swipeLeft.
        expect(circleOutcome({ defaultKey: 'zigzag', platformKey: 'swipeLeft' }))
            .toMatchObject({ reason: 0 });
    });

    test('a circle bound to nothing fires nothing', () => {
        expect(circleOutcome({ defaultKey: 'ctrlKey', platformKey: 'off', unignoreKey: 'off' }))
            .toBeNull();
    });
});
