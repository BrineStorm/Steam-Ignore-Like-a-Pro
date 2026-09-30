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

function build(sandbox, IgnoreManager, { enabled, enqueue }) {
    const rendered = [];
    const link = { getAttribute: () => '/app/620/' };
    sandbox.document.querySelectorAll = (sel) => (sel.includes('/app/') ? [link] : []);
    const mgr = new IgnoreManager({
        badgeRenderer: { render: (el, appid) => rendered.push(appid), unrender: () => {},
            syncPending: () => {}, syncMasks: () => {} },
        containerStrategies: { findContainer: () => null },
        nameExtractor: { get: async () => 'Portal 2' },
        sessionState: { get: () => null, set: () => {} },
        enqueue,
        enqueueUndo: async () => ({ kind: 'added' }),
        cancelIgnore: async () => false,
        signalUnignored: async () => {},
        isLoggedIn: async () => true,
        isEnabled: () => enabled.value,
        notifyQueueFull: () => {},
        notifyUndoQueueFull: () => {},
        notifyDropped: () => {},
    });
    return { mgr, rendered, link };
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
            ['badgeRenderer', { render: () => {}, unrender: () => {} }],   // no syncPending/syncMasks
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
