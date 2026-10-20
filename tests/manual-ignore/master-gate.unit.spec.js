// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// IgnoreManager's master gate on the render paths (src/manual-ignore/main.js) as
// a Node unit — no browser. The E2E master-off spec covers a gesture made while
// the extension is already off; what it cannot time is the switch going off
// WHILE a gesture awaits its enqueue. That swipe's badge must not paint, and its
// session entry must survive so a re-enable repaints it.

function loadIgnoreManager() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'manual-ignore', 'main.js'),
        'utf8'
    );
    const sandbox = {
        window: { ILAP: { ManualIgnore: {} }, addEventListener: () => {} },
        // Not 'complete': boot() stays parked on a 'load' that never fires.
        document: { readyState: 'loading', querySelectorAll: () => [] },
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return { IgnoreManager: sandbox.window.ILAP.ManualIgnore.IgnoreManager, sandbox };
}

// `calls` counts the hooks a gesture should or should not reach: the login gate
// (a live /account/ probe whenever the header is not signed in), the rollback
// enqueue and the un-ignore pulse.
function build(sandbox, IgnoreManager, {
    enabled, enqueue, loggedIn = true, cancelIgnore = async () => false,
    sessionState = { get: () => null, set: () => {} }, steamReason = async () => undefined,
}) {
    const calls = { login: 0, enqueueUndo: 0, signalUnignored: 0 };
    const rendered = [];
    const link = { getAttribute: () => '/app/620/', closest: () => null };
    sandbox.document.querySelectorAll = (sel) => (sel.includes('/app/') ? [link] : []);
    const mgr = new IgnoreManager({
        badgeRenderer: { render: (el, appid) => rendered.push(appid), unrender: () => {},
            syncPending: () => {}, syncMasks: () => {},
            steamGreyed: (el) => el.closest('.ds_ignored'), tintSteamFlag: () => {}, untintSteamFlag: () => {} },
        containerStrategies: { findContainer: () => null },
        nameExtractor: { get: async () => 'Portal 2' },
        sessionState,
        enqueue,
        enqueueUndo: async () => { calls.enqueueUndo += 1; return { kind: 'added' }; },
        cancelIgnore,
        signalUnignored: async () => { calls.signalUnignored += 1; },
        steamReason,
        isLoggedIn: async () => { calls.login += 1; return loggedIn; },
        isEnabled: () => enabled.value,
        notifyQueueFull: () => {},
        notifyUndoQueueFull: () => {},
        notifyDropped: () => {},
    });
    return { mgr, rendered, link, calls };
}

test.describe('ManualIgnore — master gate on badge rendering (unit)', () => {
    test('switch turned off mid-enqueue: no badge, session entry kept for the repaint', async () => {
        const { IgnoreManager, sandbox } = loadIgnoreManager();
        const enabled = { value: true };
        const { mgr, rendered, link } = build(sandbox, IgnoreManager, {
            enabled,
            // The flip lands while the storage write is still in flight.
            enqueue: async () => { enabled.value = false; return { kind: 'added' }; },
        });

        await mgr.processIgnoreRequest({ appid: '620', reason: 0, linkElement: link });

        expect(rendered).toEqual([]);
        expect(mgr.sessionMap.has('620')).toBe(true);

        enabled.value = true;
        mgr.refreshAll();
        expect(rendered).toEqual(['620']);
    });

    test('switch on throughout: the enqueued swipe paints its badge', async () => {
        const { IgnoreManager, sandbox } = loadIgnoreManager();
        const enabled = { value: true };
        const { mgr, rendered, link } = build(sandbox, IgnoreManager, {
            enabled,
            enqueue: async () => ({ kind: 'added' }),
        });

        await mgr.processIgnoreRequest({ appid: '620', reason: 0, linkElement: link });

        expect(rendered).toEqual(['620']);
    });
});

test.describe('ManualIgnore — a cancel takes back only the swipe its badge came from (unit)', () => {
    // Another tab may have queued the same game since this tab's swipe landed
    // (a greyed capsule there changes its reason). A cancel by appid alone
    // would take THAT entry back and un-badge here, while the game this tab
    // ignored stays ignored. The swipe's own time names its queue entry.
    function setup(session) {
        const { IgnoreManager, sandbox } = loadIgnoreManager();
        const queued = [];
        const cancels = [];
        const built = build(sandbox, IgnoreManager, {
            enabled: { value: true },
            enqueue: async (appid, name, reason, ts) => { queued.push(ts); return { kind: 'added' }; },
            cancelIgnore: async (appid, ts) => { cancels.push([appid, ts]); return false; },
            sessionState: session,
        });
        return Object.assign(built, { queued, cancels });
    }
    const memorySession = () => {
        const kv = {};
        return { get: (k) => kv[k] || null, set: (k, v) => { kv[k] = v; } };
    };

    test('the cancel names the gesture the badge came from', async () => {
        const s = setup(memorySession());
        await s.mgr.processIgnoreRequest({ appid: '620', reason: 0, linkElement: s.link });
        expect(typeof s.queued[0]).toBe('number');
        await s.mgr.processUnignoreRequest({ appid: '620' });
        expect(s.cancels).toEqual([['620', s.queued[0]]]);
    });

    test('a reload keeps that name with the badge', async () => {
        const session = memorySession();
        const first = setup(session);
        await first.mgr.processIgnoreRequest({ appid: '620', reason: 0, linkElement: first.link });
        const reloaded = setup(session);
        await reloaded.mgr.processUnignoreRequest({ appid: '620' });
        expect(reloaded.cancels).toEqual([['620', first.queued[0]]]);
    });

    test('a session map from an older build still loads; its cancel names nothing', async () => {
        const session = memorySession();
        session.set('ilap_session_map_v2', JSON.stringify([['620', 0]]));
        const s = setup(session);
        expect(s.mgr.sessionMap.get('620')).toBe(0);
        await s.mgr.processUnignoreRequest({ appid: '620' });
        expect(s.cancels).toEqual([['620', undefined]]);
        expect(s.calls.enqueueUndo).toBe(1);   // so it rolls back for real
    });

    test('a swipe time from the future is dropped: the cancel names nothing, the un-ignore goes through', async () => {
        // The session map lives in the page's sessionStorage, which Steam's own
        // script can write.
        const session = memorySession();
        session.set('ilap_session_map_v2', JSON.stringify([['620', 0, Date.now() + 3600000]]));
        const s = setup(session);
        expect(s.mgr.ignoredAt.has('620')).toBe(false);
        await s.mgr.processUnignoreRequest({ appid: '620' });
        expect(s.cancels).toEqual([['620', undefined]]);
        expect(s.calls.enqueueUndo).toBe(1);
    });
});

test.describe('ManualIgnore — IgnoreManager contract (unit)', () => {

    test('a missing or incomplete collaborator refuses construction, naming it', async () => {
        // The collaborators would otherwise fail only at the first gesture.
        const { IgnoreManager, sandbox } = loadIgnoreManager();
        const valid = () => {
            const deps = {};
            build(sandbox, class { constructor(d) { Object.assign(deps, d); } },
                { enabled: { value: true }, enqueue: async () => ({ kind: 'added' }) });
            return deps;
        };
        expect(() => new IgnoreManager(valid())).not.toThrow();
        for (const [name, broken] of [
            ['badgeRenderer', { render: () => {}, unrender: () => {} }],   // no syncPending/syncMasks/steamGreyed/tints
            ['containerStrategies', {}],
            ['nameExtractor', null],
            ['sessionState', { get: () => null }],
            ['isLoggedIn', undefined],
            ['cancelIgnore', undefined],
        ]) {
            const deps = Object.assign(valid(), { [name]: broken });
            expect(() => new IgnoreManager(deps), name).toThrow(new RegExp('deps\\.' + name));
        }
    });

    test('two fast swipes on one capsule cost one enqueue, not two', async () => {
        // The sessionMap check that opens processIgnoreRequest cannot hold across
        // its awaits — the map is written at the END — so a second swipe landing
        // mid-flight used to walk the whole path again: another login check,
        // another name resolution (an appdetails request on a capsule whose DOM
        // carries no name) and another enqueue. The queue deduped, so nothing was
        // ignored twice; the work was simply paid for twice.
        const { IgnoreManager, sandbox } = loadIgnoreManager();
        let release;
        const gate = new Promise((r) => { release = r; });
        let enqueues = 0;
        const { mgr, link } = build(sandbox, IgnoreManager, {
            enabled: { value: true },
            enqueue: async () => { enqueues += 1; await gate; return { kind: 'added' }; },
        });
        let names = 0;
        mgr.nameExtractor = { get: async () => { names += 1; return 'Portal 2'; } };

        const first = mgr.processIgnoreRequest({ appid: '620', reason: 0, linkElement: link });
        const second = mgr.processIgnoreRequest({ appid: '620', reason: 0, linkElement: link });
        release();
        await Promise.all([first, second]);

        expect(enqueues).toBe(1);
        expect(names).toBe(1);
        expect(mgr.sessionMap.get('620')).toBe(0);

        // And the latch is released: a later swipe on the same game is refused by
        // the session map, not stuck behind a flag that was never cleared.
        mgr.sessionMap.delete('620');
        await mgr.processIgnoreRequest({ appid: '620', reason: 2, linkElement: link });
        expect(enqueues).toBe(2);
    });

    test('a badge paints on the links of this game only, not on a longer appid that starts the same', async () => {
        const { IgnoreManager, sandbox } = loadIgnoreManager();
        const { mgr } = build(sandbox, IgnoreManager, {
            enabled: { value: true }, enqueue: async () => ({ kind: 'added' }),
        });
        const hrefs = ['/app/620/Portal_2/', '/app/6200/Other/', '/app/620?snr=1', '/app/620', '/app/62/'];
        const links = hrefs.map(h => ({ getAttribute: () => h }));
        // The page's own selector is a substring match; the exact check is the manager's.
        sandbox.document.querySelectorAll = () => links.filter(l => l.getAttribute().includes('/app/620'));
        const painted = [];
        mgr.renderer.render = (el) => painted.push(el.getAttribute());
        mgr.sessionMap.set('620', 0);

        mgr.refreshBadgesForGame('620');

        expect(painted).toEqual(['/app/620/Portal_2/', '/app/620?snr=1', '/app/620']);
    });
});

test.describe('ManualIgnore — a game this tab badged (unit)', () => {
    test('a second swipe on our badge queues nothing, the other reason included', async () => {
        // Our badge is the extension's own ignore: switching its reason goes
        // through an un-ignore first, which takes the badge off.
        const { IgnoreManager, sandbox } = loadIgnoreManager();
        const queued = [];
        const { mgr, link } = build(sandbox, IgnoreManager, {
            enabled: { value: true },
            enqueue: async (appid, name, reason) => { queued.push([appid, reason]); return { kind: 'added' }; },
        });
        const swipe = (reason) => mgr.processIgnoreRequest({ appid: '620', reason, linkElement: link });
        await swipe(0);
        await swipe(0);
        await swipe(2);
        expect(queued).toEqual([['620', 0]]);
        expect(mgr.sessionMap.get('620')).toBe(0);
    });
});

test.describe('ManualIgnore — a capsule Steam already greys out (unit)', () => {
    // Steam's `ds_ignored` means the game is on the account's list already. A
    // gesture there sets the ignore's reason (the drainer sends nothing when it
    // matches) and tints Steam's own flag instead of painting a badge.
    function greyedSetup({ loggedIn = true, steamReason } = {}) {
        const { IgnoreManager, sandbox } = loadIgnoreManager();
        const queued = [];
        const notified = [];
        const { mgr, rendered, calls } = build(sandbox, IgnoreManager, {
            enabled: { value: true },
            enqueue: async (appid, name, reason) => { queued.push([appid, reason]); return { kind: 'added' }; },
            loggedIn, steamReason,
        });
        const capsule = { id: 'ds_ignored capsule' };
        const link = {
            getAttribute: () => '/app/620/',
            closest: (sel) => (sel === '.ds_ignored' ? capsule : null),
        };
        sandbox.document.querySelectorAll = (sel) => (sel.includes('/app/') ? [link] : []);
        const tints = [];
        const untinted = [];
        mgr.renderer.tintSteamFlag = (el, appid, reason) => tints.push([el, appid, reason]);
        mgr.renderer.untintSteamFlag = (appid) => untinted.push(appid);
        mgr.notifyDropped = () => notified.push('dropped');
        const swipe = (reason) => mgr.processIgnoreRequest({ appid: '620', reason, linkElement: link });
        return { mgr, rendered, calls, capsule, queued, tints, untinted, notified, swipe };
    }

    test('an ignore queues its reason and tints Steam\'s flag: no badge, no session entry', async () => {
        const s = greyedSetup();
        await s.swipe(0);
        expect(s.queued).toEqual([['620', 0]]);
        expect(s.tints).toEqual([[s.capsule, '620', 0]]);
        expect(s.rendered).toEqual([]);
        expect(s.mgr.sessionMap.has('620')).toBe(false);
    });

    test('Already played queues reason 2 and tints the flag blue', async () => {
        const s = greyedSetup();
        await s.swipe(2);
        expect(s.queued).toEqual([['620', 2]]);
        expect(s.tints).toEqual([[s.capsule, '620', 2]]);
    });

    test('the same reason again queues nothing; the other one switches it', async () => {
        const s = greyedSetup();
        await s.swipe(2);
        await s.swipe(2);
        await s.swipe(0);
        expect(s.queued).toEqual([['620', 2], ['620', 0]]);
        expect(s.tints[s.tints.length - 1]).toEqual([s.capsule, '620', 0]);
        expect(s.mgr._enqueueing.size).toBe(0);
    });

    test('the reason Steam already has: nothing queued, nothing tinted', async () => {
        const s = greyedSetup({ steamReason: async () => 0 });
        await s.swipe(0);
        expect(s.queued).toEqual([]);
        expect(s.tints).toEqual([]);
        expect(s.rendered).toEqual([]);
        expect(s.mgr._enqueueing.size).toBe(0);
    });

    test('back to Steam\'s reason after a tint: queued to take it back, the tint goes', async () => {
        const s = greyedSetup({ steamReason: async () => 0 });
        await s.swipe(2);
        expect(s.tints).toEqual([[s.capsule, '620', 2]]);
        await s.swipe(0);
        expect(s.queued).toEqual([['620', 2], ['620', 0]]);
        expect(s.untinted).toEqual(['620']);
        expect(s.mgr.tinted.has('620')).toBe(false);
        await s.swipe(0);                        // Steam's reason again: nothing more
        expect(s.queued).toHaveLength(2);
    });

    test('signed out, a greyed capsule is refused at the gate like any other', async () => {
        const s = greyedSetup({ loggedIn: false });
        await s.swipe(0);
        expect(s.queued).toEqual([]);
        expect(s.tints).toEqual([]);
    });

    test('a refused change of reason untints and says so; the capsule stays greyed', async () => {
        const s = greyedSetup();
        await s.swipe(2);
        s.mgr.handleUnignored(['620'], 'failed');
        expect(s.untinted).toEqual(['620']);
        expect(s.notified).toEqual(['dropped']);
        await s.swipe(2);                        // still Steam's grey: tinted again, no badge
        expect(s.tints).toHaveLength(2);
        expect(s.rendered).toEqual([]);
    });

    test('a game un-ignored since the page loaded keeps a stale grey: it gets a badge', async () => {
        // Our remove=1 does not reach Steam's page, which keeps `ds_ignored`
        // until a reload; the un-ignore pulse is how this tab knows.
        const s = greyedSetup();
        s.mgr.handleUnignored(['620'], 'undo');
        await s.swipe(0);
        expect(s.queued).toEqual([['620', 0]]);
        expect(s.tints).toEqual([]);
        expect(s.mgr.sessionMap.has('620')).toBe(true);
    });

    test('master off strips the tints, on paints them back', async () => {
        const s = greyedSetup();
        await s.swipe(0);
        s.mgr.hideBadges();
        expect(s.untinted).toEqual(['620']);
        s.mgr.refreshAll();
        expect(s.tints).toHaveLength(2);
    });
});

test.describe('ManualIgnore — the session ended in another window (unit)', () => {
    // A store page opened while signed in keeps its header and Steam's grey
    // after the user signs out elsewhere; a page opened after it is anonymous.
    // `loggedIn: false` is the gate's answer in both: the anonymous header, or
    // the live probe a stale one is not asked for (see the E2E twin,
    // session-ends-elsewhere.spec.js).
    function setup({ loggedIn = false, cancelIgnore } = {}) {
        const { IgnoreManager, sandbox } = loadIgnoreManager();
        let enqueues = 0;
        const { mgr, rendered, calls } = build(sandbox, IgnoreManager, {
            enabled: { value: true },
            enqueue: async () => { enqueues += 1; return { kind: 'added' }; },
            loggedIn,
            cancelIgnore,
        });
        const link = { getAttribute: () => '/app/620/', closest: () => null };
        const swipe = (reason = 0) => mgr.processIgnoreRequest({ appid: '620', reason, linkElement: link });
        return { mgr, rendered, calls, swipe, enqueues: () => enqueues };
    }

    test('a capsule Steam does not grey is refused at the gate: nothing queued or painted', async () => {
        const s = setup();
        await s.swipe();
        expect(s.calls.login).toBe(1);
        expect(s.enqueues()).toBe(0);
        expect(s.rendered).toEqual([]);
        expect(s.mgr.sessionMap.has('620')).toBe(false);
        expect(s.mgr._enqueueing.size).toBe(0);   // the next try is not swallowed
    });

    test('an un-ignore of a game badged before the sign-out queues no rollback', async () => {
        const s = setup();
        s.mgr.sessionMap.set('620', 0);           // painted while still signed in
        await s.mgr.processUnignoreRequest({ appid: '620' });
        expect(s.calls.enqueueUndo).toBe(0);
        expect(s.mgr.pending.has('620')).toBe(false);
        expect(s.mgr.sessionMap.has('620')).toBe(true);   // the badge is still true
    });

    test('taking back an ignore that was never sent needs no session', async () => {
        // The queued entry is cancelled locally: no POST, so no gate either.
        const s = setup({ cancelIgnore: async () => true });
        s.mgr.sessionMap.set('620', 0);
        await s.mgr.processUnignoreRequest({ appid: '620' });
        expect(s.calls.signalUnignored).toBe(1);
        expect(s.calls.login).toBe(0);
        expect(s.calls.enqueueUndo).toBe(0);
    });
});
