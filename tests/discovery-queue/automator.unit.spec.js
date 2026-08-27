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
    const src = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', ...p), 'utf8');
    const sandbox = {
        window: {},
        console: { warn: (...a) => (warns || []).push(a) },
        document: { querySelector: () => ({}) },   // _loop's dialog probe
        setTimeout: setTimeoutImpl || setTimeout, clearTimeout,
        Date, Math, Promise, Object, Array, String,
    };
    vm.createContext(sandbox);
    // logic.js reads the shared review palette at load time (window.ILAP.SteamPalette),
    // so the table goes into the sandbox first — without it SlideScanner would
    // find no bad shades and fail safe on every slide.
    vm.runInContext(src('steam-palette.js'), sandbox);
    vm.runInContext(src('discovery-queue', 'logic.js'), sandbox);
    // sandbox is exposed so a test can swap the globals logic.js reads at call
    // time — _loop probes `document` for the dialog on every iteration.
    return { Automator: sandbox.window.ILAP.Discovery.Automator, window: sandbox.window, sandbox };
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

// The end-of-queue branch, which the E2E cannot drive on demand: it needs a tag
// whose pool is spent, and that is account state that changes under us (probed
// live — a queue serves exactly 12 games, then a "Done / Continue" interstitial,
// and on a healthy pool Continue keeps handing back fresh queues). What must
// hold when the pool IS spent is that the loop ends instead of spinning on the
// interstitial forever, and that is pure logic — so it lives here.
//
// Two shapes, handled differently on purpose:
//   - Continue hands back ANOTHER interstitial (no card in the centred slot) —
//     bounded by MAX_CONTINUE_STREAK (3 clicks, the 4th refused), with a
//     confirmed ignore in between clearing the streak, or a long run would die
//     at its fourth queue boundary;
//   - a card sits in the centred slot but there is no Next arrow — nowhere to
//     advance to and no interstitial either, so the loop stops WITHOUT clicking.
//     A card is never a Continue surface (probed live), and the rightmost thing
//     on one is its own "Install Demo" / "Undo" / review link.
test.describe('DQ end-of-queue / exhausted pool (unit)', () => {

    // The DOM surface SlideScanner actually touches — nothing more.
    //   'interstitial' — the centred slot holds the stats panel: a "Done" +
    //                    "Continue" leaf-button pair (Continue sits right, which
    //                    is how it is identified), no game card.
    //   'final-slide'  — an active slide with NO Next arrow anywhere.
    //   'game'         — a normal ignorable slide: app link, ignore icon, Next.
    function fakeDialog(kind) {
        const leaf = (text, left) => ({
            textContent: text,
            querySelector: () => null,          // no svg / app link / nested Focusable
            offsetParent: {},                   // visible
            getBoundingClientRect: () => ({ left }),
            click() { this.clicked = (this.clicked || 0) + 1; },
        });
        const done = leaf('Done', 10);
        const cont = leaf('Continue', 100);     // rightmost in the panel → Continue
        // A card's own leaf button, further right than anything in the panel and
        // reachable ONLY by a dialog-wide search. Live probes found exactly this
        // shape ("Install Demo", "Undo", the review-score link) sitting right of
        // everything else, so a de-scoped getContinueButton picks it and these
        // tests redden instead of silently passing.
        const junk = leaf('Install Demo', 9000);

        const link = {
            querySelector: () => null,          // neither img nor video → usable as a name
            textContent: 'Test Game',
            getAttribute: () => '/app/123/test',
        };
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
            querySelectorAll: (sel) => (sel === 'path' ? (kind === 'game' ? [ignorePath] : [])
                : sel.includes('/app/') ? [link] : []),
        };
        // The carousel container is present in ALL of these — including on the
        // interstitial, where it has rendered (probed live: five children) but
        // its centred child is the stats panel rather than a game card. Modelling
        // it as absent there would quietly bypass the primary/fallback decision
        // this suite exists to pin down.
        const panel = {
            querySelector: () => null,          // no game link → not a slide
            querySelectorAll: (sel) => (sel.includes('Focusable') ? [done, cont] : []),
        };
        const blank = { querySelector: () => null, querySelectorAll: () => [] };
        const carousel = kind === 'interstitial'
            ? { children: [blank, blank, panel, blank, blank] }
            : { children: [blank, blank, slide] };
        const dialog = {
            querySelector: (sel) => (sel.includes('_3q6eNRFBrPSFSGEn8uRFZ3') ? carousel : null),
            querySelectorAll: (sel) => {
                // A Next arrow exists only on a normal game slide: on the
                // final slide there is nothing to advance to. (The stale-card
                // regression below overrides this — the real interstitial does
                // keep its arrow.)
                if (sel === 'path') return kind === 'game' ? [nextPath] : [];
                if (sel.includes('Focusable')) return [done, cont, junk];
                return [];   // [role=button] fallback: fewer than 2 → no Next
            },
        };
        return { dialog, cont, done, junk, ignoreBtn, nextBtn };
    }

    // Instant timers: the automator's real waits here are 2.5 s per Continue.
    const instant = (fn) => setTimeout(fn, 0);

    test('exhausted pool: exactly MAX_CONTINUE_STREAK clicks, then the loop stops', async () => {
        const { Automator } = loadAutomator([], instant);
        const a = new Automator(...noopAdapters());
        const states = [];
        a.setUiObserver((isRunning) => states.push(isRunning));

        const { dialog, cont, done, junk } = fakeDialog('interstitial');
        const clicks = [];
        a._clickWithDelay = (el) => { clicks.push(el); return Promise.resolve(); };

        a.isRunning = true;
        const results = [];
        for (let i = 0; i < 5; i++) results.push(await a._processCurrentSlide(dialog));

        // Three Continues, then refused — never an endless interstitial spin.
        expect(results).toEqual([true, true, true, false, false]);
        expect(clicks).toEqual([cont, cont, cont]);
        expect(done.clicked).toBeUndefined();   // "Done" would CLOSE the modal
        expect(junk.clicked).toBeUndefined();   // …and a card button is not a Continue
        expect(a.processedCount).toBe(0);       // nothing was ignorable
    });

    // The Continue guard. A card in the centred slot with no Next arrow is a dead
    // end, not an interstitial: there is no Continue to press, and the rightmost
    // leaf button on that surface belongs to the game ("Install Demo" — clicking
    // it would start a download). Stop, and touch nothing.
    test('a final slide with no Next arrow stops the loop without clicking anything', async () => {
        const { Automator } = loadAutomator([], instant);
        const a = new Automator(...noopAdapters());

        const { dialog, cont, done, junk } = fakeDialog('final-slide');
        const clicks = [];
        a._clickWithDelay = (el) => { clicks.push(el); return Promise.resolve(); };

        a.isRunning = true;
        expect(await a._processCurrentSlide(dialog)).toBe(false);
        expect(clicks).toEqual([]);
        expect(junk.clicked).toBeUndefined();
        expect(cont.clicked).toBeUndefined();
        expect(done.clicked).toBeUndefined();
        expect(a.processedCount).toBe(0);
    });

    // The live shape this guard really exists for: a game card IS on screen and
    // advanceable, but our Ignore-icon lookup missed it (Steam renaming the SVG
    // path is enough). The old dialog-wide search answered that with the card's
    // own rightmost leaf button — a real store action on a real game.
    test('a card whose Ignore control is unfindable stops the loop, clicking nothing', async () => {
        const { Automator } = loadAutomator([], instant);
        const a = new Automator(...noopAdapters());

        // 'final-slide' is a card with no ignore icon; give it a Next arrow so the
        // loop gets all the way past the end-of-queue branch to the ignore path.
        const { dialog, cont, junk } = fakeDialog('final-slide');
        const nextPath = {
            getAttribute: (n) => (n === 'd' ? 'M16.0855 0' : null),
            closest: () => ({}),
        };
        const advanceable = {
            ...dialog,
            querySelectorAll: (sel) => (sel === 'path' ? [nextPath] : dialog.querySelectorAll(sel)),
        };

        const clicks = [];
        a._clickWithDelay = (el) => { clicks.push(el); return Promise.resolve(); };
        a.isRunning = true;

        expect(await a._processCurrentSlide(advanceable)).toBe(false);
        expect(clicks).toEqual([]);             // never advance past a game we didn't act on
        expect(junk.clicked).toBeUndefined();   // "Install Demo" would start a download
        expect(cont.clicked).toBeUndefined();
    });

    // Regression, reproduced live before the fix: at the interstitial the primary
    // container is present and says "no active card", but a leftover Ignore icon
    // from an already-passed card let the FALLBACK hand that stale card back as
    // the active slide. The loop then read its button as already-ignored, clicked
    // Next (a no-op there) and spun forever on the same appid — the Continue
    // branch was never reached, so MAX_CONTINUE_STREAK never got to fire.
    test('interstitial with a stale card still in the DOM: Continue, never the stale card', async () => {
        const { Automator } = loadAutomator([], instant);
        const a = new Automator(...noopAdapters());

        const { dialog, cont } = fakeDialog('interstitial');
        const link = {
            querySelector: () => null,
            textContent: 'Already Passed',
            getAttribute: () => '/app/999/passed',
        };
        const staleIgnoreBtn = { getAttribute: () => null, classList: [] };
        const staleIgnorePath = {
            getAttribute: (n) => (n === 'd' ? 'M600,96c0-1' : null),
            closest: () => staleIgnoreBtn,
        };
        const staleSlide = {
            querySelector: (sel) => (sel.includes('#app_reviews_hash') ? null
                : sel.includes('/app/') ? link : null),
            querySelectorAll: (sel) => (sel === 'path' ? [staleIgnorePath]
                : sel.includes('/app/') ? [link] : []),
        };
        // A carousel _findCarousel would accept (>2 children, ≥2 carrying a game
        // link), with the stale card dead centre — exactly the shape that used to
        // be mistaken for the active slide.
        const sibling = () => ({ querySelector: (s) => (s.includes('/app/') ? link : null) });
        staleIgnorePath.parentElement = { children: [sibling(), staleSlide, sibling()] };

        // The interstitial dialog, but now with that leftover icon reachable AND
        // the carousel's Next arrow still present — which is what the real
        // interstitial looks like (probed live: hasNextArrow true). The arrow is
        // load-bearing for this regression: without it the missing Next button
        // alone would route the loop to Continue and hide the stale-card bug.
        const nextBtn = {};
        const nextPath = {
            getAttribute: (n) => (n === 'd' ? 'M16.0855 0' : null),
            closest: () => nextBtn,
        };
        const stale = {
            ...dialog,
            querySelectorAll: (sel) => (sel === 'path' ? [staleIgnorePath, nextPath]
                : dialog.querySelectorAll(sel)),
        };

        const clicks = [];
        a._clickWithDelay = (el) => { clicks.push(el); return Promise.resolve(); };
        a._confirmIgnored = async () => true;   // so a regression fails on the assert, not a throw
        a.isRunning = true;

        expect(await a._processCurrentSlide(stale)).toBe(true);
        expect(clicks).toEqual([cont]);              // Continue — not the stale card
        expect(clicks).not.toContain(staleIgnoreBtn);
        expect(a.processedCount).toBe(0);            // nothing was re-ignored
    });

    test('the loop ends on an exhausted pool (isRunning false, UI notified)', async () => {
        const { Automator, sandbox } = loadAutomator([], instant);
        const a = new Automator(...noopAdapters());
        const states = [];
        a.setUiObserver((isRunning) => states.push(isRunning));

        const { dialog, cont } = fakeDialog('interstitial');
        sandbox.document.querySelector = () => dialog;   // _loop's dialog probe
        const clicks = [];
        a._clickWithDelay = (el) => { clicks.push(el); return Promise.resolve(); };

        await a.start();   // must RESOLVE, not spin

        expect(clicks).toEqual([cont, cont, cont]);
        expect(a.isRunning).toBe(false);
        expect(states[states.length - 1]).toBe(false); // frees the registry slot
    });

    test('a confirmed ignore clears the streak — a long run survives repeated boundaries', async () => {
        const { Automator } = loadAutomator([], instant);
        const a = new Automator(...noopAdapters());
        a._clickWithDelay = () => Promise.resolve();
        a._confirmIgnored = async () => true;
        a.isRunning = true;

        const spent = fakeDialog('interstitial').dialog;
        const game = fakeDialog('game').dialog;

        // Two boundaries, an ignore, then two more: without the reset the third
        // and fourth Continue would exhaust the streak and stop the run.
        expect(await a._processCurrentSlide(spent)).toBe(true);
        expect(await a._processCurrentSlide(spent)).toBe(true);
        expect(await a._processCurrentSlide(game)).toBe(true);
        expect(a.processedCount).toBe(1);
        expect(await a._processCurrentSlide(spent)).toBe(true);
        expect(await a._processCurrentSlide(spent)).toBe(true);
        expect(await a._processCurrentSlide(spent)).toBe(true);
        expect(await a._processCurrentSlide(spent)).toBe(false); // 4th since the reset
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
