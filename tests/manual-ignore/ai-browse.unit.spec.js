// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadEscape } = require('../_escape.js');

// The rule the extension runs for which AI games count (presets.js ILAP.aiGames).
const presets = { window: {} };
vm.createContext(presets);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'presets.js'), 'utf8'), presets);
const aiGames = presets.window.ILAP.aiGames;
const aiKinds = presets.window.ILAP.aiKinds;

// The AI tab's level (src/manual-ignore/ai-browse.js) as a Node unit: which
// games a page scan marks, blurs and queues, with what, and when it holds back. The page,
// storage and Steam are stubs, so every hook is counted. The shot and the badge
// are the E2E spec's (ai-browse.spec.js).

// `clock`: { now } in place of the real time (only Date.now is read).
function loadModule(clock) {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'manual-ignore', 'ai-browse.js'), 'utf8');
    const sandbox = { window: { ILAP: { ManualIgnore: {} } }, URLSearchParams };
    if (clock) sandbox.Date = { now: () => clock.now };
    vm.createContext(sandbox);
    loadEscape(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.ManualIgnore;
}
const loadAiBrowse = (clock) => loadModule(clock).AiBrowse;

const DATA = {
    ai: { 2025: [10, 20, 30], tba: [40, 50] },
    aikeep: { translation: [20], ingame: [30] },
};

// A capsule link. `dialog`: it sits in the Discovery Queue's modal. `href`:
// another link that names the app.
const link = (appid, { dialog = false, href } = {}) => ({
    appid,
    getAttribute: () => href || `https://store.steampowered.com/app/${appid}/Some_Game/?snr=1`,
    closest: (sel) => (sel === 'dialog' && dialog ? {} : null),
});

function account({ ignored = [], owned = [], wishlist = [] } = {}) {
    const map = new Map(ignored.map(a => [String(a), 0]));
    map.owned = new Set(owned.map(String));
    map.wishlist = new Set(wishlist.map(String));
    return map;
}

function build(opts = {}) {
    const AiBrowse = loadAiBrowse(opts.clock);
    const calls = { enqueued: [], queued: [], account: 0, spared: 0, sparedAt: [], login: 0, watched: [], tagged: [], flagged: [], untag: 0 };
    const state = {
        hidden: new Set((opts.hidden || []).map(String)),
        links: opts.links || [10, 20, 30, 40, 99].map(a => link(a)),
        enabled: opts.enabled !== undefined ? opts.enabled : true,
        loggedIn: opts.loggedIn !== undefined ? opts.loggedIn : true,
        account: opts.account !== undefined ? opts.account : account(),
        outcome: opts.outcome || { kind: 'added' },
    };
    const ai = new AiBrowse({
        links: () => state.links,
        pageAppid: opts.pageAppid || null,
        ready: (l) => !state.hidden.has(String(l.appid)),
        watch: (l) => calls.watched.push(String(l.appid)),
        isEnabled: () => state.enabled,
        isLoggedIn: async () => { calls.login += 1; return state.loggedIn; },
        aiGames: async (keep) => aiGames(DATA, keep),
        aiKinds: async () => aiKinds(DATA),
        readAccount: async () => { calls.account += 1; return state.account; },
        readSpared: async (readAt) => {
            calls.spared += 1;
            calls.sparedAt.push(readAt);
            return {
                hand: new Set((opts.spared || []).map(String)),
                refused: new Set((opts.refused || []).map(String)),
                own: new Set((opts.own || []).map(String)),
            };
        },
        skip: (l, appid) => (opts.skip || []).includes(Number(appid)),
        nameOf: (appid) => 'Game ' + appid,
        enqueue: async (entries) => {
            calls.enqueued.push(entries);
            if (opts.onEnqueue) opts.onEnqueue(state, calls.enqueued.length);
            return state.outcome;
        },
        onQueued: (appid, links, index, ts, landed) => calls.queued.push({ appid, links: links.length, index, ts, landed }),
        tag: (l, appid, blur, kind, flag) => {
            calls.tagged.push([appid, blur]);
            if (flag) calls.flagged.push(appid);
            calls.kinds = Object.assign(calls.kinds || {}, { [appid]: kind });
        },
        untag: () => { calls.untag += 1; },
    });
    ai.setOptions({ level: opts.level !== undefined ? opts.level : HIGH, keep: opts.keep || {} });
    return { ai, calls, state };
}

const queuedIds = (calls) => calls.enqueued.flat().map(e => e.appid);
// Settings.AI_LEVELS
const [OFF, LOW, MEDIUM, HIGH] = [0, 1, 2, 3];

test.describe('ManualIgnore — AI games while browsing (unit)', () => {
    test('queues the AI games of the page as auto entries, one batch, the shots in page order', async () => {
        const { ai, calls } = build();
        await ai.scan();
        expect(calls.enqueued).toHaveLength(1);
        const [batch] = calls.enqueued;
        expect(batch.map(e => e.appid)).toEqual(['10', '20', '30', '40']);
        const ts = batch[0].ts;
        for (const e of batch) {
            expect(e).toMatchObject({ reason: 0, auto: true, ts });
            expect(e.name).toBe('Game ' + e.appid);
        }
        expect(calls.queued.map(q => [q.appid, q.index, q.ts])).toEqual([['10', 0, ts], ['20', 1, ts], ['30', 2, ts], ['40', 3, ts]]);
    });

    test('nothing queued at OFF, LOW or MEDIUM, with the master off, or signed out', async () => {
        for (const opts of [{ level: OFF }, { level: LOW }, { level: MEDIUM }, { enabled: false }, { loggedIn: false }]) {
            const { ai, calls } = build(opts);
            await ai.scan();
            expect(calls.enqueued).toEqual([]);
            expect(calls.account).toBe(0);
        }
    });

    test('LOW marks every AI game of the page, MEDIUM blurs them too, and neither reads Steam', async () => {
        for (const [level, blur] of [[LOW, false], [MEDIUM, true]]) {
            const { ai, calls } = build({
                level,
                pageAppid: '50',
                links: [link(10), link(20, { dialog: true }), link(30), link(50), link(99)],
            });
            await ai.scan();
            expect(calls.tagged).toEqual([['10', blur], ['30', blur]]);
            expect(calls.flagged).toEqual(['10', '30']);
            expect(calls.login + calls.account + calls.spared).toBe(0);
        }
    });

    test('each flag names the AI use the lists know: translation, in the game, or AI alone', async () => {
        // DATA: 20 translation, 30 in game, 10 and 40 neither. LOW keeps no box.
        const { ai, calls } = build({ level: LOW });
        await ai.scan();
        expect(calls.kinds).toEqual({ 10: 'ai', 20: 'translation', 30: 'ingame', 40: 'ai' });
    });

    test('HIGH blurs every AI game, the owned and wishlisted ones too, flags none of them, and queues the rest', async () => {
        const { ai, calls } = build({
            account: account({ owned: [20], wishlist: [30] }),
            skip: [40],
        });
        await ai.scan();
        // The owned and wishlisted ones are blurred once the account read
        // leaves them out, the queued one only when its shot lands.
        expect(calls.tagged).toEqual([['10', false], ['20', false], ['30', false], ['40', true], ['20', true], ['30', true]]);
        expect(queuedIds(calls)).toEqual(['10']);
        // A rescan during the flight keeps its cover sharp, and so does the
        // account read now known: the owned one is blurred at once.
        calls.tagged.length = 0;
        await ai.scan();
        expect(calls.tagged).toEqual([['10', false], ['20', true], ['30', true], ['40', true]]);
        calls.tagged.length = 0;
        calls.queued[0].landed();
        expect(calls.tagged).toEqual([['10', true]]);
        calls.tagged.length = 0;
        await ai.scan();
        expect(calls.tagged[0]).toEqual(['10', true]);
        expect(calls.flagged).toEqual([]);
    });

    test('HIGH flags a game un-ignored by hand, read by the scan or from storage, and no game Steam refused', async () => {
        const { ai, calls, state } = build({ spared: [20], refused: [30], links: [10, 20, 30].map(a => link(a)) });
        await ai.scan();
        expect(queuedIds(calls)).toEqual(['10']);
        expect(calls.flagged).toEqual(['20']);
        // The shot's landing blurs with no flag, and a rescan flags nothing new.
        calls.flagged.length = 0;
        calls.queued[0].landed();
        await ai.scan();
        expect(calls.flagged).toEqual(['20']);
        // Its badge un-ignored in this tab or another: the next scan flags it.
        ai.spared(['20', 10]);
        calls.flagged.length = 0;
        state.links = [10, 20, 30].map(a => link(a));
        await ai.scan();
        expect(calls.flagged).toEqual(['10', '20']);
    });

    test('HIGH leaves a game the user ignored elsewhere unshot, though the account read does not have it', async () => {
        // Queued by a swipe in another tab, or logged since the read.
        const { ai, calls } = build({ own: [20], links: [10, 20].map(a => link(a)) });
        await ai.scan();
        expect(queuedIds(calls)).toEqual(['10']);
        // Blurred at once with no flag, as an ignored game is, and left for good.
        expect(calls.tagged).toContainEqual(['20', true]);
        expect(calls.flagged).toEqual([]);
        await ai.scan();
        expect(calls.enqueued).toHaveLength(1);
    });

    test('every scan asks what to leave unshot by the time of the page\'s one account read', async () => {
        const clock = { now: 100000 };
        const { ai, calls, state } = build({ clock, hidden: [20], links: [10, 20].map(a => link(a)) });
        await ai.scan();
        clock.now = 900000;
        state.hidden.clear();
        await ai.scan();
        expect(queuedIds(calls)).toEqual(['10', '20']);
        expect(calls.account).toBe(1);
        expect(calls.sparedAt).toEqual([100000, 100000]);
    });

    test('a game whose entry left the queue before its shot landed gets no badge and no blur', async () => {
        // The job removed, the entry dropped by the drainer or taken back in
        // another tab: the pulse can come while the shot still flies.
        const { ai, calls } = build();
        await ai.scan();
        expect(queuedIds(calls)).toEqual(['10', '20', '30', '40']);
        ai.dropped(['20', 30]);
        calls.tagged.length = 0;
        expect(calls.queued.map(q => q.landed())).toEqual([true, false, false, true]);
        expect(calls.tagged).toEqual([['10', true], ['40', true]]);
        // Landed once: a second call says no more.
        expect(calls.queued[0].landed()).toBe(false);
        // Not queued again on this page.
        await ai.scan();
        expect(calls.enqueued).toHaveLength(1);
    });

    test('HIGH leaves an AI game out of view sharp until its shot lands', async () => {
        const { ai, calls, state } = build({ hidden: [10], links: [link(10)] });
        await ai.scan();
        expect(calls.tagged).toEqual([['10', false]]);
        state.hidden.delete('10');
        await ai.scan();
        expect(calls.tagged).toEqual([['10', false], ['10', false]]);
        calls.queued[0].landed();
        expect(calls.tagged.at(-1)).toEqual(['10', true]);
    });

    test('the boxes keep their games unmarked, and nothing is marked at OFF or with the master off', async () => {
        const kept = build({ level: LOW, keep: { translation: true } });
        await kept.ai.scan();
        expect(kept.calls.tagged.map(([a]) => a)).toEqual(['10', '30', '40']);
        for (const opts of [{ level: OFF }, { level: LOW, enabled: false }]) {
            const { ai, calls } = build(opts);
            await ai.scan();
            expect(calls.tagged).toEqual([]);
        }
    });

    test('a new level or box takes the marks off for the next scan, and a lower level leaves the queued games queued', async () => {
        const { ai, calls } = build();
        await ai.scan();
        expect(queuedIds(calls)).toEqual(['10', '20', '30', '40']);
        calls.queued.forEach(q => q.landed());
        const before = calls.untag;
        ai.setOptions({ level: HIGH, keep: {} });
        expect(calls.untag).toBe(before);
        ai.setOptions({ level: MEDIUM, keep: {} });
        expect(calls.untag).toBe(before + 1);
        ai.setOptions({ level: MEDIUM, keep: { ingame: true } });
        expect(calls.untag).toBe(before + 2);
        calls.tagged.length = 0;
        await ai.scan();
        expect(calls.tagged).toEqual([['10', true], ['20', true], ['40', true]]);
        expect(calls.enqueued).toHaveLength(1);
    });

    test('a page with no AI game reads nothing from Steam', async () => {
        const { ai, calls } = build({ links: [link(99), link(98)] });
        await ai.scan();
        expect(calls.login + calls.account + calls.spared).toBe(0);
        expect(calls.enqueued).toEqual([]);
    });

    test('leaves the open game page\'s own game, games in a dialog and games the tab already marked', async () => {
        const { ai, calls } = build({
            pageAppid: '10',
            links: [link(10), link(20, { dialog: true }), link(30), link(40)],
            skip: [30],
        });
        await ai.scan();
        expect(queuedIds(calls)).toEqual(['40']);
    });

    test('the AI tab\'s boxes keep their games, and a box moved looks at the page again', async () => {
        const { ai, calls } = build({ keep: { translation: true, ingame: true } });
        await ai.scan();
        expect(queuedIds(calls)).toEqual(['10', '40']);
        ai.setOptions({ level: HIGH, keep: { translation: false, ingame: true } });
        await ai.scan();
        expect(calls.enqueued[1].map(e => e.appid)).toEqual(['20']);
    });

    test('skips games already ignored, owned, wishlisted or un-ignored by hand', async () => {
        const { ai, calls } = build({
            account: account({ ignored: [10], owned: [20], wishlist: [30] }),
            spared: [40],
            links: [10, 20, 30, 40, 50].map(a => link(a)),
        });
        await ai.scan();
        expect(queuedIds(calls)).toEqual(['50']);
    });

    test('a failed read of the spared games shoots nothing, and the next scan tries again', async () => {
        let fail = true;
        const { ai, calls, state } = build({ links: [link(10)] });
        ai.d.readSpared = async () => {
            calls.spared += 1;
            if (fail) throw new Error('gone');
            return { hand: new Set(), refused: new Set(), own: new Set() };
        };
        await ai.scan();
        expect(calls.enqueued).toEqual([]);
        fail = false;
        state.links = [link(10)];
        await ai.scan();
        expect(queuedIds(calls)).toEqual(['10']);
    });

    test('one game in several capsules is one entry with all its links', async () => {
        const { ai, calls } = build({ links: [link(10), link(10), link(40)] });
        await ai.scan();
        expect(queuedIds(calls)).toEqual(['10', '40']);
        expect(calls.queued.map(q => q.links)).toEqual([2, 1]);
    });

    test('a capsule not ready (out of view, art loading) is only watched, and is queued once it is', async () => {
        const { ai, calls, state } = build({ hidden: [30, 40] });
        await ai.scan();
        expect(queuedIds(calls)).toEqual(['10', '20']);
        expect(calls.watched).toEqual(['30', '40']);
        state.hidden.delete('40');
        await ai.scan();
        expect(calls.enqueued.map(b => b.map(e => e.appid))).toEqual([['10', '20'], ['40']]);
    });

    test('a page whose AI games are all out of view reads nothing from Steam', async () => {
        const { ai, calls } = build({ hidden: [10, 20, 30, 40] });
        await ai.scan();
        expect(calls.login + calls.account + calls.spared).toBe(0);
    });

    test('only store game links count: news, community and "more like" links name an app too', async () => {
        const { ai, calls } = build({ links: [
            link(10, { href: 'https://store.steampowered.com/news/app/10/view/1' }),
            link(20, { href: 'https://steamcommunity.com/app/20' }),
            link(30, { href: '/recommended/morelike/app/30/' }),
            link(40, { href: '/app/40/Some_Game/' }),
        ] });
        await ai.scan();
        expect(queuedIds(calls)).toEqual(['40']);
    });

    test('a game is looked at once per page: a later scan queues only what the page added', async () => {
        const { ai, calls, state } = build({ links: [link(10)] });
        await ai.scan();
        state.links = [link(10), link(40)];
        await ai.scan();
        expect(calls.enqueued.map(b => b.map(e => e.appid))).toEqual([['10'], ['40']]);
        // Steam is read once for the page, the spared games on every scan:
        // another tab may have spared one since.
        expect(calls.account).toBe(1);
        expect(calls.spared).toBe(2);
    });

    test('an account read without the library or the wishlist queues nothing and is not retried at once', async () => {
        const noLib = account();
        noLib.owned = null;
        for (const read of [null, noLib]) {
            const { ai, calls } = build({ account: read });
            await ai.scan();
            await ai.scan();
            expect(calls.enqueued).toEqual([]);
            expect(calls.account).toBe(1);
        }
    });

    test('a signed-out scan leaves the games for a later one', async () => {
        const { ai, calls, state } = build({ loggedIn: false, links: [link(10)] });
        await ai.scan();
        state.loggedIn = true;
        await ai.scan();
        expect(queuedIds(calls)).toEqual(['10']);
    });

    test('a batch the queue has no room for shoots nothing, says nothing, and is tried again after a wait', async () => {
        const clock = { now: 1e6 };
        const { ai, calls, state } = build({ clock, outcome: { kind: 'full' } });
        await ai.scan();
        expect(calls.enqueued).toHaveLength(1);
        expect(calls.queued).toEqual([]);
        // The hook is gone: no card for a page the user only scrolled.
        expect(Object.keys(calls)).not.toContain('full');
        state.outcome = { kind: 'added' };
        clock.now += 29000;
        await ai.scan();
        expect(calls.enqueued).toHaveLength(1);
        clock.now += 2000;
        await ai.scan();
        expect(calls.enqueued).toHaveLength(2);
        expect(calls.queued.map(q => q.appid)).toEqual(['10', '20', '30', '40']);
    });

    test('a scan asked for during a scan runs once after it', async () => {
        const asked = [];
        // The page grows while the first batch is being queued, and asks twice.
        const { ai, calls } = build({
            links: [link(10)],
            onEnqueue: (state, n) => {
                if (n !== 1) return;
                state.links = [link(10), link(40)];
                asked.push(ai.scan(), ai.scan());
            },
        });
        await ai.scan();
        await Promise.all(asked);
        expect(calls.enqueued.map(b => b.map(e => e.appid))).toEqual([['10'], ['40']]);
    });

    test('a missing hook fails at construction', () => {
        const AiBrowse = loadAiBrowse();
        const fns = ['links', 'ready', 'watch', 'isEnabled', 'isLoggedIn', 'aiGames', 'aiKinds', 'readAccount',
            'readSpared', 'skip', 'nameOf', 'enqueue', 'onQueued', 'tag', 'untag'];
        const deps = Object.fromEntries(fns.map(fn => [fn, () => {}]));
        expect(() => new AiBrowse(deps)).not.toThrow();
        for (const fn of fns) {
            expect(() => new AiBrowse({ ...deps, [fn]: undefined }), fn).toThrow('AiBrowse needs deps.' + fn);
        }
    });
});

test.describe('ManualIgnore — where the browsing switch looks (unit)', () => {
    test('the whole page, the strip under a Classic Discovery Queue game, nothing on the queue\'s start page', () => {
        const { aiLinkScope } = loadModule();
        expect(aiLinkScope('/search/', '?term=x')).toBe('all');
        expect(aiLinkScope('/app/620/Portal_2/', '')).toBe('all');
        expect(aiLinkScope('/app/620/Portal_2/', '?snr=1&queue=1')).toBe('strip');
        expect(aiLinkScope('/explore/', '')).toBe('none');
        expect(aiLinkScope('/explore/new/', '')).toBe('all');
    });

    // A capsule 200×100 whose shot needs a box of it in view, with its images.
    // `top.shown` false: a carousel slide stacked under another.
    function viewport({ need = { left: 0, top: 0, right: 200, bottom: 100 }, imgs = [], top = { shown: true } } = {}) {
        const { AiViewport } = loadModule();
        let fire = null;
        const observed = [];
        class FakeIO {
            constructor(cb) { fire = cb; }
            observe(el) { observed.push(el); }
        }
        let ready = 0;
        const el = { tagName: 'A', querySelectorAll: () => imgs };
        const vp = new AiViewport({ target: (l) => l.el, need: () => need, onTop: () => top.shown,
            onReady: () => { ready += 1; }, IO: FakeIO });
        const l = { el };
        // The capsule at y `top` in a window 800 tall.
        const at = (top) => fire([{ target: el, isIntersecting: top < 800 && top + 100 > 0,
            boundingClientRect: { left: 0, top, width: 200, height: 100 },
            intersectionRect: { left: 0, top: Math.max(0, top), right: 200, bottom: Math.min(800, top + 100) } }]);
        return { vp, l, el, at, observed, readyCount: () => ready };
    }
    // `decoded` settles the decode() asked for last.
    const img = (complete, naturalWidth = complete ? 1 : 0, shown = true) => {
        const im = { complete, naturalWidth, decodes: 0, getClientRects: () => (shown ? [{}] : []) };
        im.decode = () => { im.decodes += 1; return new Promise((ok, fail) => { im.decoded = (good) => (good ? ok() : fail(new Error('broken'))); }); };
        return im;
    };

    test('a capsule is ready once the box its shot needs is all in view, and asks for a scan then', () => {
        const { vp, l, el, at, observed, readyCount } = viewport({ need: { left: 0, top: 30, right: 200, bottom: 70 } });
        vp.watch(l);
        vp.watch(l);
        expect(observed).toEqual([el]);
        expect(vp.ready(l)).toBe(false);
        // Its top edge just in from the window's bottom: the box is not.
        at(780);
        expect(vp.ready(l)).toBe(false);
        expect(readyCount()).toBe(0);
        at(720);
        expect(vp.ready(l)).toBe(true);
        expect(readyCount()).toBe(1);
        at(700);
        expect(readyCount()).toBe(1);
        at(900);
        expect(vp.ready(l)).toBe(false);
    });

    test('a carousel slide stacked under another is in view but not ready until it is shown on top', () => {
        const top = { shown: false };
        const { vp, l, at } = viewport({ top });
        at(100);
        expect(vp.ready(l)).toBe(false);
        top.shown = true;
        expect(vp.ready(l)).toBe(true);
    });

    test('a shot that needs the whole capsule waits for all of it', () => {
        const { vp, l, at } = viewport();
        at(750);
        expect(vp.ready(l)).toBe(false);
        at(699);
        expect(vp.ready(l)).toBe(true);
    });

    test('a capsule whose art is still loading waits for it; a hidden image and a broken one do not count as loaded', async () => {
        const loading = img(false);
        const hidden = img(false, 0, false);
        const { vp, l, at, readyCount } = viewport({ imgs: [img(true), loading, hidden] });
        at(100);
        expect(vp.ready(l)).toBe(false);
        vp.watch(l);
        vp.watch(l);
        // One wait, on the image the capsule shows.
        expect([loading.decodes, hidden.decodes]).toEqual([1, 0]);
        const before = readyCount();
        loading.complete = true;
        loading.naturalWidth = 184;
        loading.decoded(true);
        await new Promise(r => setTimeout(r, 0));
        expect(readyCount()).toBe(before + 1);
        expect(vp.ready(l)).toBe(true);

        // A decode that fails (the src changed) is waited for again.
        const swapped = img(false);
        const again = viewport({ imgs: [swapped] });
        again.vp.watch(again.l);
        swapped.decoded(false);
        await new Promise(r => setTimeout(r, 0));
        again.vp.watch(again.l);
        expect(swapped.decodes).toBe(2);

        const broken = viewport({ imgs: [img(true, 0)] });
        broken.at(100);
        expect(broken.vp.ready(broken.l)).toBe(false);
    });

    test('a missing hook fails at construction', () => {
        const { AiViewport } = loadModule();
        const deps = { target: () => null, need: () => null, onTop: () => true, onReady: () => {}, IO: class { observe() {} } };
        expect(() => new AiViewport(deps)).not.toThrow();
        for (const fn of Object.keys(deps)) {
            expect(() => new AiViewport({ ...deps, [fn]: undefined }), fn).toThrow('AiViewport needs deps.' + fn);
        }
    });
});

// The games un-ignored by hand: one list, one write at a time.
test.describe('AiSpared (unit)', () => {
    function load(initial) {
        const data = { ...initial };
        const sandbox = {
            window: { ILAP: { ManualIgnore: {} } },
            URLSearchParams,
            chrome: { storage: { local: {
                get: (k, cb) => setTimeout(() => cb({ [k]: data[k] }), 0),
                set: (o, cb) => setTimeout(() => { Object.assign(data, o); cb(); }, 0),
            } } },
        };
        vm.createContext(sandbox);
        loadEscape(sandbox);
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'manual-ignore', 'ai-browse.js'), 'utf8'), sandbox);
        return { Spared: sandbox.window.ILAP.ManualIgnore.AiSpared, data };
    }

    test('two un-ignores in one moment both stay on the list', async () => {
        const { Spared, data } = load({});
        await Promise.all([Spared.add('10'), Spared.add(20)]);
        expect(data[Spared.KEY]).toEqual(['10', '20']);
    });

    test('a game already there is not written again, and a read gives strings', async () => {
        const { Spared, data } = load({ ilap_ai_spared: [10] });
        expect(await Spared.read()).toEqual(['10']);
        await Spared.add('10');
        expect(data[Spared.KEY]).toEqual([10]);
    });

    test('something else under the key reads as nothing', async () => {
        const { Spared } = load({ ilap_ai_spared: 'x' });
        expect(await Spared.read()).toEqual([]);
    });
});

test.describe('ManualIgnore — wiring the AI switch (unit)', () => {
    test('a missing collaborator refuses construction, by name', () => {
        const { wireAiBrowsing } = loadModule();
        expect(() => wireAiBrowsing({})).toThrow('needs deps.strategies');
        expect(() => wireAiBrowsing({ strategies: {}, marks: {}, tags: {} })).toThrow('needs deps.settings');
    });
});
