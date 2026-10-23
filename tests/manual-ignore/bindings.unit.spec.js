// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadSettingsSchema } = require('../_settings-schema.js');

// Binding resolution (src/manual-ignore/gestures.js): which of the THREE actions —
// ignore, already-played, un-ignore — a click or a swipe resolves to.
//
// The un-ignore binding now draws from the same vocabulary as the two ignore
// ones, so "one binding, one action" is enforced by the popup's cross-guard
// rather than by disjoint value sets. That guard lives in the UI and a
// hand-edited storage key walks straight past it, which makes the resolvers'
// precedence a contract of its own: the ignore bindings are read FIRST, so a
// value bound twice costs the rollback, never the ignore.
//
// gestures.js is an IIFE that evals with no document, so it runs in Node — same
// harness as zigzag.unit.spec.js. `chrome` carries only what the menu-at-press
// cancel reads: a live extension id, or none for a tab orphaned by an update.
function loadMI(chrome = { runtime: { id: 'ilap-test' } }) {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'manual-ignore', 'gestures.js'), 'utf8');
    const sandbox = { window: {}, chrome, Math, Set, Array, Object, String };
    vm.createContext(sandbox);
    loadSettingsSchema(sandbox);
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

    test("'off' is checked for all three bindings, not just the two", () => {
        // `event['off']` is undefined, so a missing OFF check went unnoticed —
        // until some event carries an `off` property and the binding the user
        // switched off starts firing. Each one is asked the same question.
        const offEvent = { off: true };
        expect(clickOutcome({ defaultKey: 'off' }, offEvent)).toBeNull();
        expect(clickOutcome({ platformKey: 'off' }, offEvent)).toBeNull();
        expect(clickOutcome({ unignoreKey: 'off' }, offEvent)).toBeNull();
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

// Anything on the page that is not a capsule.
const plainEl = () => ({ closest: () => null });
// A bundle link: a capsule with its art inside, or a text link with none.
const bundleEl = (withArt) => ({
    closest: (sel) => (sel.includes('/bundle/')
        ? { getAttribute: () => '/bundle/232/', querySelector: () => (withArt ? {} : null) }
        : null),
});

// A detector that survives several gestures, so the menu-suppression latch can
// be watched ACROSS them. `menu()` reports whether that contextmenu was
// swallowed; the two orderings below are the two platforms.
function detectorHarness(config, chrome) {
    const MI = loadMI(chrome);
    const detector = new MI.SwipeGestureDetector(configOf(config));
    let fired = null;
    let hints = 0;
    detector.attach({ addEventListener: () => {} }, (data) => { fired = data; }, () => { hints += 1; });

    const el = linkEl();
    return {
        fired: () => fired,
        hints: () => hints,
        down: (x, target = el) => detector.onMouseDown(
            { isTrusted: true, button: 2, clientX: x, clientY: 0, target }),
        move: (x) => detector.onMouseMove({ isTrusted: true, clientX: x }),
        up: (x) => {
            fired = null;
            detector.onMouseUp({ isTrusted: true, button: 2, clientX: x, clientY: 0 });
        },
        menu: (isTrusted = true) => {
            let prevented = false;
            detector.onContextMenu({
                isTrusted,
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

    test('menu-at-press ordering: a stale latch never reaches an unrelated right-click', () => {
        // Regression. Off Windows (and for Playwright's input on Firefox)
        // contextmenu arrives at mouse-DOWN, before onMouseUp arms the latch —
        // so a recognised gesture there leaves it armed with no menu of its own
        // left to spend it, and the NEXT, unrelated right-click had its menu
        // swallowed by a gesture that ended long ago. onMouseDown clearing the
        // latch is what closes that.
        const d = detectorHarness({});

        // Gesture 1, menu-at-press order: the menu on the capsule is cancelled
        // at press (see the describe below), then the gesture is recognised on
        // mouseup and arms the latch.
        d.down(0);
        expect(d.menu()).toBe(true);
        d.move(30); d.up(60);
        expect(d.fired()).toMatchObject({ reason: 0 });

        // A plain right-click somewhere else, off any capsule: its menu must open.
        d.down(500, plainEl());
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

test.describe('a context menu that opens at press (macOS, Linux)', () => {
    // There the menu arrives while the right button is still down, grabs the
    // pointer, and the page never sees the moves or the release: no gesture
    // can finish. On a capsule, with a gesture bound, it is cancelled.

    test('on a capsule with a gesture bound: cancelled, the gesture completes, the hint is told', () => {
        const d = detectorHarness({});
        d.down(0);
        expect(d.menu()).toBe(true);
        expect(d.hints()).toBe(1);
        d.move(30); d.up(60);
        expect(d.fired()).toMatchObject({ reason: 0 });
    });

    test('off a capsule it stays', () => {
        const d = detectorHarness({});
        d.down(0, plainEl());
        expect(d.menu()).toBe(false);
        expect(d.hints()).toBe(0);
    });

    test('on a bundle capsule it goes, on a bundle text link it stays', () => {
        // Only a link with art in it takes the gesture (_bundleIntent), so the
        // "Bundle info" button and the text links keep their menu.
        const d = detectorHarness({});
        d.down(0, bundleEl(true));
        expect(d.menu()).toBe(true);
        d.up(0);
        d.down(0, bundleEl(false));
        expect(d.menu()).toBe(false);
    });

    test('with every action on a click or off it stays: nothing needs the button held', () => {
        const d = detectorHarness({ defaultKey: 'shiftKey', platformKey: 'altKey', unignoreKey: 'off' });
        d.down(0);
        expect(d.menu()).toBe(false);
    });

    test('one gesture bound is enough, whichever action holds it', () => {
        const d = detectorHarness({ defaultKey: 'shiftKey', platformKey: 'altKey', unignoreKey: 'zigzag' });
        d.down(0);
        expect(d.menu()).toBe(true);
    });

    test('with the master switch off it stays', () => {
        const d = detectorHarness({ enabled: false });
        d.down(0);
        expect(d.menu()).toBe(false);
    });

    test('a synthetic contextmenu is left alone', () => {
        const d = detectorHarness({});
        d.down(0);
        expect(d.menu(false)).toBe(false);
    });

    test('a tab orphaned by an extension update leaves the menu alone', () => {
        // Its gesture could not be queued: cancelling the menu would cost the
        // user both. chrome.runtime.id is what such a script loses.
        const d = detectorHarness({}, { runtime: {} });
        d.down(0);
        expect(d.menu()).toBe(false);
        expect(d.hints()).toBe(0);
    });

    test('Windows ordering: a plain right-click on a capsule keeps its menu', () => {
        // The menu comes after mouse-up there: the press is over, so only the
        // latch of a recognised gesture can cancel it — and a click arms none.
        const d = detectorHarness({});
        d.down(0); d.up(0);
        expect(d.menu()).toBe(false);
        expect(d.hints()).toBe(0);
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

// ConfigService: how Manual Ignore reads its settings out of storage. Every value
// passes the schema's rules on the way in.
test.describe('ManualIgnore — ConfigService (unit)', () => {
    // `opts` models the three ways a read can go wrong: the callback lands with
    // chrome.runtime.lastError set (and, on Chrome, an undefined result), the
    // callback lands with a result _updateInternal cannot read, and get() itself
    // throws — the invalidated-extension-context case.
    function loadConfig(stored, opts) {
        opts = opts || {};
        const code = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'manual-ignore', 'config.js'), 'utf8');
        const listeners = [];
        const warned = [];
        let reads = 0;
        const sandbox = {
            window: {}, Math, Set, Array, Object, String, Promise,
            console: { warn: (...a) => warned.push(a.join(' ')) },
            chrome: {
                runtime: { lastError: opts.lastError },
                storage: {
                    local: { get: (keys, cb) => {
                        reads++;
                        if (opts.getThrows) throw new Error('Extension context invalidated.');
                        cb(opts.result ? opts.result() : Object.assign({}, stored));
                    } },
                    onChanged: { addListener: (l) => listeners.push(l) },
                },
            },
        };
        vm.createContext(sandbox);
        loadSettingsSchema(sandbox);
        vm.runInContext(code, sandbox);
        const defaults = { defaultKey: 'swipeRight', platformKey: 'swipeLeft', unignoreKey: 'zigzag',
            enabled: true, maskEnabled: true };
        const service = new sandbox.window.ILAP.ManualIgnore.ConfigService(defaults);
        return { service, listeners, reads: () => reads, warned };
    }

    // A promise that never settles is the failure under test, so it needs a
    // deadline of its own — an `await` on it would otherwise hang the runner
    // until the suite timeout and report nothing useful.
    const settles = (p, ms) => Promise.race([
        p,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('refresh() never settled')), ms || 2000)),
    ]);

    test('stored values are normalized; absent keys keep the defaults (a missing switch is ON)', async () => {
        const { service } = loadConfig({
            ilap_shortcut_key: 'swipeRightRight',   // a legacy value
            ilap_platform_key: 'off',
            ilap_unignore_key: 'bogus',             // hand-edited: keeps the current binding
            ilap_mask_enabled: false,
        });
        const config = await service.init();
        expect(config.defaultKey).toBe('swipeRight');
        expect(config.platformKey).toBe('off');
        expect(config.unignoreKey).toBe('zigzag');
        expect(config.maskEnabled).toBe(false);
        expect(config.enabled).toBe(true);          // ilap_master_enabled never written
    });

    test('only a change to a key it reads triggers a re-read', async () => {
        // Without the filter every Steam tab re-read its config and swept the DOM
        // on each cursor advance of a bulk drain.
        const { service, listeners, reads } = loadConfig({});
        await service.init();
        let notified = 0;
        service.onChange(() => { notified++; });
        service.listen();
        const before = reads();

        listeners[0]({ ilap_curator_cursor_job_1: { newValue: 3 } }, 'local');
        listeners[0]({ ilap_ignore_gate: { newValue: 1 } }, 'local');
        listeners[0]({ ilap_mask_enabled: { newValue: false } }, 'sync');
        await new Promise(r => setTimeout(r, 0));
        expect(reads()).toBe(before);

        listeners[0]({ ilap_mask_enabled: { newValue: false } }, 'local');
        await new Promise(r => setTimeout(r, 0));
        expect(reads()).toBe(before + 1);
        expect(notified).toBe(1);
    });

    test('a read that errors resolves with the config we have — it must never hang', async () => {
        // App.init() AWAITS this call, so a pending promise here is not a slow
        // start, it is no start: setupInteractions() never runs, no gesture is
        // ever wired, and boot()'s .catch has no rejection to report. Silent.
        const { service } = loadConfig({}, {
            lastError: { message: 'storage unavailable' },
            result: () => undefined,          // what Chrome hands the callback on an error
        });
        const config = await settles(service.init());
        expect(config.defaultKey).toBe('swipeRight');   // defaults, intact
        expect(config.unignoreKey).toBe('zigzag');
        expect(config.enabled).toBe(true);
    });

    test('...and so does a callback that throws with no lastError set', async () => {
        // The belt to the lastError brace: whatever makes _updateInternal throw,
        // the promise still settles and the page still boots on its defaults.
        const { service, warned } = loadConfig({}, { result: () => undefined });
        const config = await settles(service.init());
        expect(config.platformKey).toBe('swipeLeft');
        expect(warned.join(' ')).toContain('config read failed');
    });

    test('an invalidated context still REJECTS, so boot() reports it', async () => {
        // Deliberately NOT swallowed: that page has no storage behind it any
        // more, and marching on would wire listeners against a dead context
        // instead of saying so once. The rejection is boot()'s to log.
        const { service } = loadConfig({}, { getThrows: true });
        await expect(service.init()).rejects.toThrow(/invalidated/i);
    });
});
