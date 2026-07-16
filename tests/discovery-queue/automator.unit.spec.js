const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// DiscoveryQueueAutomator stop-discipline as Node units — no browser. The E2E
// ui.spec covers live start/stop cycles; these two are races the E2E can't
// drive deterministically. Audit findings #6/#7:
//   #6 — a throw mid-iteration (Steam DOM change) must still land in stop(),
//        or isRunning stays true and the controller's heartbeat keeps renewing
//        this tab's registry slot forever (zombie eats half the CAP=2);
//   #7 — a Stop landing during the multi-second confirm poll must not be
//        followed by one more queue advance (Next click).

function loadAutomator(warns, setTimeoutImpl) {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'discovery-queue', 'logic.js'), 'utf8');
    const sandbox = {
        window: {},
        console: { warn: (...a) => (warns || []).push(a) },
        document: { querySelector: () => ({}) },   // _loop's dialog probe
        setTimeout: setTimeoutImpl || setTimeout, clearTimeout,
        Date, Math, Promise, Object, Array, String,
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return { Automator: sandbox.window.ILAP.Discovery.Automator, window: sandbox.window };
}

const noopAdapters = () => [
    { ignore: async () => true },
    { save: () => {} },
    { get: () => 'Unknown Game' },
];

test.describe('DiscoveryQueueAutomator (unit)', () => {

    test('a throw mid-iteration still lands in stop() — no zombie isRunning/slot', async () => {
        const warns = [];
        const { Automator } = loadAutomator(warns);
        const a = new Automator(...noopAdapters());
        const states = [];
        a.setUiObserver((isRunning) => states.push(isRunning));
        a._processCurrentSlide = () => { throw new Error('steam dom changed'); };

        await a.start();   // must RESOLVE (the controller never awaits/catches it)

        expect(a.isRunning).toBe(false);
        // The observer saw the stop transition — that's what frees the
        // controller's registry slot and stops its heartbeat.
        expect(states[states.length - 1]).toBe(false);
        expect(warns.length).toBe(1); // aborted loudly, not silently
    });

    test('a Stop landing during the confirm poll refuses the Next advance', async () => {
        const { Automator } = loadAutomator();
        const saved = [];
        const a = new Automator(
            { ignore: async () => true },
            { save: (name, source) => saved.push([name, source]) },
            { get: () => 'Unknown Game' },
        );

        // Minimal DOM slice satisfying the SlideScanner path: an active slide
        // with a game link + ignore icon, and a Next arrow on the dialog.
        const link = {
            querySelector: () => null,
            textContent: 'Test Game',
            getAttribute: () => '/app/123/test',
        };
        const clicks = [];
        const ignoreBtn = { getAttribute: () => null, classList: [] };
        const nextBtn = {};
        const ignorePath = {
            getAttribute: (n) => (n === 'd' ? 'M600,96c0-1' : null),
            closest: () => ignoreBtn,
        };
        const nextPath = {
            getAttribute: (n) => (n === 'd' ? 'M16.0855 0' : null),
            closest: () => nextBtn,
        };
        const slide = {
            querySelector: (sel) => (sel.includes('#app_reviews_hash') ? null
                : sel.includes('/app/') ? link : null),
            querySelectorAll: (sel) => (sel === 'path' ? [ignorePath]
                : sel.includes('/app/') ? [link] : []),
        };
        const dialog = {
            querySelector: (sel) => (sel.includes('_3q6eNRFBrPSFSGEn8uRFZ3')
                ? { children: [{}, {}, slide] } : null),
            querySelectorAll: (sel) => (sel === 'path' ? [nextPath] : []),
        };

        a._clickWithDelay = (el) => { clicks.push(el); return Promise.resolve(); };
        // The Stop lands while the confirm poll is in flight; the ignore itself
        // still confirms (it already happened on Steam's side).
        a._confirmIgnored = async () => { a.isRunning = false; return true; };

        a.isRunning = true;
        const result = await a._processCurrentSlide(dialog);

        expect(result).toBe(false);        // loop ends, no further iteration
        expect(clicks).toEqual([ignoreBtn]); // the ignore click only — NO Next click
        expect(a.processedCount).toBe(1);  // the confirmed ignore is still counted
        expect(saved).toEqual([['Test Game', 'Queue']]); // …and recorded in stats
    });
});

// Audit #9: the userdata fallback used to fire a cache-busted full
// GET immediately and then every 600 ms up to a 4 s deadline (~7 GETs worst
// case). Contract now: a settle delay BEFORE the first read, doubling backoff
// per miss, hard cap of CONFIRM_MAX_GETS (3) reads per unconfirmed ignore.
test.describe('DQ userdata confirm fallback pacing (unit)', () => {

    // Instant fake timer that records each requested delay.
    function makeHarness(fetchResults) {
        const delays = [];
        const fakeTimeout = (fn, ms) => { delays.push(ms); return setTimeout(fn, 0); };
        const { Automator, window } = loadAutomator([], fakeTimeout);
        let reads = 0;
        window.ILAP.fetchIgnoredApps = async () =>
            new Set(fetchResults[Math.min(reads++, fetchResults.length - 1)] || []);
        const a = new Automator(...noopAdapters());
        return { a, delays, readCount: () => reads };
    }

    test('confirmed on the first read: one settle delay, exactly one GET', async () => {
        const { a, delays, readCount } = makeHarness([['123']]);
        expect(await a._verifyIgnoredViaUserdata('123')).toBe(true);
        expect(readCount()).toBe(1);
        expect(delays).toEqual([600]); // settle BEFORE the first read
    });

    test('a miss backs off (600 → 1200 → 2400), never past the 3-GET cap', async () => {
        const { a, delays, readCount } = makeHarness([[], [], []]);
        expect(await a._verifyIgnoredViaUserdata('123')).toBe(false);
        expect(readCount()).toBe(3);   // hard cap — no fixed-rate poll hammer
        expect(delays).toEqual([600, 1200, 2400]);
    });

    test('confirmed on the second read stops spending the cap', async () => {
        const { a, delays, readCount } = makeHarness([[], ['123']]);
        expect(await a._verifyIgnoredViaUserdata('123')).toBe(true);
        expect(readCount()).toBe(2);
        expect(delays).toEqual([600, 1200]);
    });
});
