// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The IGNORE-side login gate, as a Node unit — no browser.
//
// Two files, one policy: steam-net.js `probeLoginCached` owns the CACHING (how
// long each verdict is reused, what is never cached, how a burst collapses to
// one GET) and utils.js `SteamAuth.hasLiveSession` owns the DOM SHORT-CUT that
// sits in front of it. Both are asked on hot paths — the rate governor once per
// reserved slot, every Manual-Ignore gesture once per swipe — so "how often does
// this really hit the network" is the contract, not an implementation detail.
//
// tests/cross-cutting/gate.unit.spec.js stubs probeLoginCached outright and says
// in so many words that the caching is exercised by this module's own units.
// These are those units.

// Load the pair in vm with a controllable clock and a counting fetch stub.
// escape.js / stats.js load first, exactly as they do in the content world (see
// fetch-timeout.unit.spec.js, same harness).
function loadAuth(opts) {
    const o = opts || {};
    let clock = 1_700_000_000_000;
    const calls = [];
    // A /account/ response in the shape probeLogin reads: `ok` plus the final
    // `url`, which is what carries the login redirect.
    const respond = () => {
        const verdict = o.verdict();       // true | false | null (null = the fetch itself fails)
        if (verdict === null) return Promise.reject(new Error('offline'));
        return Promise.resolve({
            ok: true,
            url: verdict ? 'https://store.steampowered.com/account/'
                : 'https://store.steampowered.com/login/?redir=account',
        });
    };
    const fetchImpl = (url) => { calls.push(url); return respond(); };

    // A real Date subclass so `new Date()` elsewhere in the loaded files keeps
    // working; only the static now() is under the test's control.
    class FakeDate extends Date {
        static now() { return clock; }
    }

    const sandbox = {
        window: {}, console,
        fetch: fetchImpl,
        AbortController, setTimeout, clearTimeout,
        document: o.document || { querySelector: () => null, getElementById: () => null },
        Date: FakeDate, Math, Object, Promise, Set, String, RegExp, JSON,
    };
    vm.createContext(sandbox);
    for (const f of ['escape.js', 'stats.js', 'steam-net.js', 'utils.js']) {
        vm.runInContext(fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', f), 'utf8'), sandbox);
    }
    return {
        Net: sandbox.window.ILAP.SteamNet,
        Auth: sandbox.window.ILAP.SteamAuth,
        calls,
        advance: (ms) => { clock += ms; },
    };
}

// The two windows in src/steam-net.js. Mirrored, not imported: the constants are
// module-private, and pinning them here is the point — a change to either has to
// be a deliberate edit in two places.
const OK_TTL = 60000;
const NEG_TTL = 10000;

// The store header, as SteamAuth.isLoggedInDom reads it: the avatar/pulldown
// means signed IN, a bare #global_action_menu means signed OUT, neither means
// "no header on this surface at all".
const headerDom = (state) => ({
    querySelector: (sel) =>
        (state === 'in' && /account_pulldown|user_avatar/.test(sel) ? {} : null),
    getElementById: (id) =>
        (state !== 'none' && id === 'global_action_menu' ? {} : null),
});

test.describe('probeLoginCached — verdict caching (unit)', () => {

    test('a confirmed session is reused, not re-probed', async () => {
        const { Net, calls } = loadAuth({ verdict: () => true });
        expect(await Net.probeLoginCached()).toBe(true);
        expect(await Net.probeLoginCached()).toBe(true);
        expect(await Net.probeLoginCached()).toBe(true);
        expect(calls).toHaveLength(1);
    });

    test('the confirmed verdict expires after OK_TTL, not before', async () => {
        let live = true;
        const { Net, calls, advance } = loadAuth({ verdict: () => live });
        expect(await Net.probeLoginCached()).toBe(true);

        // One millisecond short of the window: still the cached answer, even
        // though the session died in the meantime.
        live = false;
        advance(OK_TTL - 1);
        expect(await Net.probeLoginCached()).toBe(true);
        expect(calls).toHaveLength(1);

        // Past it: asked again, and the sign-out is seen.
        advance(2);
        expect(await Net.probeLoginCached()).toBe(false);
        expect(calls).toHaveLength(2);
    });

    test('a signed-OUT verdict expires far sooner (NEG_TTL)', async () => {
        // The asymmetry is the whole reason there are two constants: a page
        // opened BEFORE the user signed in elsewhere must recover on the next
        // gesture instead of swallowing them for a minute.
        let live = false;
        const { Net, calls, advance } = loadAuth({ verdict: () => live });
        expect(await Net.probeLoginCached()).toBe(false);

        advance(NEG_TTL - 1);
        expect(await Net.probeLoginCached()).toBe(false);
        expect(calls).toHaveLength(1);   // still inside the short window

        live = true;
        advance(2);
        expect(await Net.probeLoginCached()).toBe(true);
        expect(calls).toHaveLength(2);

        // …and the fresh positive answer now holds for the LONG window, which is
        // what proves the TTL is picked per verdict and not per cache entry.
        live = false;
        advance(NEG_TTL + 1);
        expect(await Net.probeLoginCached()).toBe(true);
        expect(calls).toHaveLength(2);
    });

    test('a FAILED probe is never cached — the next call asks again', async () => {
        // null is "couldn't ask", not an answer. Caching it would turn a
        // ten-second outage into a ten-second refusal window for every gesture.
        let verdict = null;
        const { Net, calls } = loadAuth({ verdict: () => verdict });
        expect(await Net.probeLoginCached()).toBe(null);
        expect(await Net.probeLoginCached()).toBe(null);
        expect(calls).toHaveLength(2);   // asked both times, no clock movement

        verdict = true;
        expect(await Net.probeLoginCached()).toBe(true);
        expect(calls).toHaveLength(3);
    });

    test('a failed probe does not evict a still-valid cached verdict', async () => {
        let verdict = true;
        const { Net, calls, advance } = loadAuth({ verdict: () => verdict });
        expect(await Net.probeLoginCached()).toBe(true);

        verdict = null;              // the connection drops
        advance(OK_TTL + 1);         // …just as the window lapses
        expect(await Net.probeLoginCached()).toBe(null);
        expect(calls).toHaveLength(2);

        // The blip passes: the next call gets a real answer rather than being
        // stuck on the null.
        verdict = true;
        expect(await Net.probeLoginCached()).toBe(true);
        expect(calls).toHaveLength(3);
    });

    test('a burst of concurrent callers costs exactly one GET', async () => {
        // The reason the in-flight latch replaced a stamp-before-await: several
        // sources reach the gate at once (a drain pass plus a swipe), and the
        // ones alongside the probe must get THIS verdict, not the previous one.
        let release;
        const gate = new Promise((r) => { release = r; });
        const calls = [];
        const sandbox = {
            window: {}, console,
            fetch: (url) => { calls.push(url); return gate; },
            AbortController, setTimeout, clearTimeout,
            document: { querySelector: () => null, getElementById: () => null },
            Date, Math, Object, Promise, Set, String, RegExp, JSON,
        };
        vm.createContext(sandbox);
        for (const f of ['escape.js', 'stats.js', 'steam-net.js', 'utils.js']) {
            vm.runInContext(fs.readFileSync(
                path.join(__dirname, '..', '..', 'src', f), 'utf8'), sandbox);
        }
        const Net = sandbox.window.ILAP.SteamNet;

        const all = Promise.all([0, 1, 2, 3, 4].map(() => Net.probeLoginCached()));
        release({ ok: true, url: 'https://store.steampowered.com/account/' });
        expect(await all).toEqual([true, true, true, true, true]);
        expect(calls).toHaveLength(1);
    });

    test('the latch is released after a failed probe (a burst cannot strand it)', async () => {
        let verdict = null;
        const { Net, calls } = loadAuth({ verdict: () => verdict });
        await Promise.all([Net.probeLoginCached(), Net.probeLoginCached()]);
        expect(calls).toHaveLength(1);   // shared, even though it resolved null

        verdict = true;
        expect(await Net.probeLoginCached()).toBe(true);   // …and not wedged
        expect(calls).toHaveLength(2);
    });

    test('probeLogin itself stays UNcached — the fresh-answer callers keep theirs', async () => {
        // The widget lock and the drainer's dead-session check exist precisely to
        // notice a session that just died; they must not be served from a cache.
        const { Net, calls } = loadAuth({ verdict: () => true });
        await Net.probeLogin();
        await Net.probeLogin();
        expect(calls).toHaveLength(2);
    });
});

test.describe('SteamAuth.hasLiveSession — the DOM short-cut (unit)', () => {

    test('a signed-IN header settles it for free — no probe at all', async () => {
        const { Auth, calls } = loadAuth({
            verdict: () => false, document: headerDom('in'),
        });
        expect(await Auth.hasLiveSession()).toBe(true);
        expect(calls).toHaveLength(0);
    });

    test('a signed-OUT header is NOT trusted — the live probe overrules it', async () => {
        // The difference from resolveLogin, and the reason there are two
        // policies: a page opened before the user signed in elsewhere reads
        // logged-out forever, and would swallow every gesture until a reload.
        const { Auth, calls } = loadAuth({
            verdict: () => true, document: headerDom('out'),
        });
        expect(await Auth.hasLiveSession()).toBe(true);
        expect(calls).toHaveLength(1);
        // resolveLogin, on the same DOM, answers from the header and never asks.
        expect(await Auth.resolveLogin()).toBe(false);
        expect(calls).toHaveLength(1);
    });

    test('no header at all falls through to the probe', async () => {
        const { Auth, calls } = loadAuth({
            verdict: () => false, document: headerDom('none'),
        });
        expect(await Auth.hasLiveSession()).toBe(false);
        expect(calls).toHaveLength(1);
    });

    test('the probe\'s tri-state passes straight through (null stays null)', async () => {
        // gate.js turns this null into 'offline' rather than 'no-session', so
        // collapsing it to false here would silently merge two stops that do not
        // recover the same way.
        const { Auth } = loadAuth({ verdict: () => null, document: headerDom('none') });
        expect(await Auth.hasLiveSession()).toBe(null);
    });

    test('a gesture burst behind a signed-out header still costs one GET', async () => {
        const { Auth, calls } = loadAuth({
            verdict: () => true, document: headerDom('out'),
        });
        const all = await Promise.all([0, 1, 2, 3].map(() => Auth.hasLiveSession()));
        expect(all).toEqual([true, true, true, true]);
        expect(calls).toHaveLength(1);
    });
});
