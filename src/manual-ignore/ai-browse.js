// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.ManualIgnore = window.ILAP.ManualIgnore || {};

    // The AI tab's level (Settings.KEYS.AI_LEVEL) on a store page, for every
    // AI game of the built-in lists (data/presets.json → ai, less the games
    // the AI tab's boxes keep). LOW flags each capsule as Steam flags IN
    // LIBRARY, naming the kind of AI use when the lists know it (translation,
    // in the game), MEDIUM also blurs its cover, at once and with no shot.
    // HIGH queues the game instead of flagging it: a capsule that comes into view joins the MI
    // job and is shot (shot.js). It waits until enough of it is in view for
    // its whole shot and its art has loaded, until it scrolls or slides in,
    // and so does one the page loads later (Viewport). Its cover stays sharp
    // until the shot lands, then blurs along with the badge. Full auto, and every
    // POST goes through the drainer and IgnoreGate like a swipe's. At HIGH the
    // flag goes only on a game the user un-ignored by hand (below), so a game
    // about to be shot shows no flag before its crossed mark.
    //
    // Left alone at every level: the game whose own page is open, and games
    // in a <dialog> (the Discovery Queue's modal), since the user opened those
    // on purpose. On a Classic Discovery Queue page only the strip under the
    // game counts (linkScope): the queue's own game is the Queue Helper's
    // (explore-queue/utils.js AiVerdict). Marked but left unqueued: games already
    // ignored, owned or wishlisted (one userdata read per page), games the user un-ignored by hand on a badge
    // (AiSpared below; an Undo rollback is no such word, so those
    // games may be shot again), games Steam refused lately (DoneMarks.aiRefusedNow),
    // games a swipe queued in any tab, games the log has as ignored too lately for
    // that read to show, and games this tab already marked or saw. An ignore by Steam's
    // own button is in no queue or log, so an old tab may still shoot it: the
    // drainer's own read then sends no POST. The drainer checks the library
    // and the wishlist again before the POST: an auto entry is an automated
    // ignore there.

    // A store game link, absolute or from the root. News, community and
    // "more like" links name an app too, and are no game capsule.
    const APP_RE = /^(?:https?:\/\/store\.steampowered\.com)?\/app\/(\d+)([/?#]|$)/;
    // A failed account read is tried again on a later scan, no sooner than this.
    const READ_RETRY_MS = 60000;
    // A batch the ignore queue had no room for is tried again on a later scan,
    // no sooner than this.
    const ENQUEUE_RETRY_MS = 30000;
    // How finely the capsule's part in view is followed, as IO thresholds.
    const THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);
    // Rounding between the observer's boxes and the shot's, in pixels.
    const SLACK = 1;
    // The strip under the game on a Classic Discovery Queue page ("More like this").
    const QUEUE_STRIP = '.related_items_ctn';
    // The games the user un-ignored by hand (a badge click or the solo un-ignore
    // gesture), as appid strings: the switch never shoots them again. An Undo
    // rollback writes nothing here. One write at a time in a tab. Across tabs a
    // lost update only lets a game be shot once more.
    const SPARED_KEY = 'ilap_ai_spared';
    const spareWrites = window.ILAP.serialChain();
    const AiSpared = {
        KEY: SPARED_KEY,
        read: () => new Promise(r => chrome.storage.local.get(SPARED_KEY, r))
            .then(d => (Array.isArray(d[SPARED_KEY]) ? d[SPARED_KEY].map(String) : [])),
        add: (appid) => spareWrites(async () => {
            const list = await AiSpared.read();
            if (list.includes(String(appid))) return;
            await new Promise(r => chrome.storage.local.set({ [SPARED_KEY]: list.concat(String(appid)) }, r));
        }),
    };

    // Settings.AI_LEVELS, which the unit suite loads no Settings for.
    const LOW = 1;
    const MEDIUM = 2;
    const HIGH = 3;

    // Where the browsing switch looks on a page: the whole page, only the strip
    // under the game on a Classic Discovery Queue page, or nowhere on the
    // queue's own start page, whose capsules are the queue.
    //   'all' | 'strip' | 'none'
    function linkScope(pathname, search) {
        if (/^\/explore\/?$/.test(pathname)) return 'none';
        if (/^\/app\//.test(pathname) && new URLSearchParams(search).has('queue')) return 'strip';
        return 'all';
    }

    // Which capsules are ready to be shot: an IntersectionObserver over the
    // capsules a scan met, which keeps the part of each in view (clipped by
    // a carousel's frame too), and their art. One is ready once the part its
    // shot draws on is all in view (`need(el, w, h)`, a box in the capsule's
    // pixels) and every image it shows has loaded, and `onTop(el)` says it is
    // shown on top: a carousel keeps its other slides stacked at the same
    // spot, each of them in view to the observer. `target(link)` is the
    // capsule, `onReady()` runs when one may have become ready.
    class Viewport {
        constructor(deps) {
            for (const fn of ['target', 'need', 'onTop', 'onReady', 'IO']) {
                if (typeof deps[fn] !== 'function') throw new TypeError('[ILAP] AiViewport needs deps.' + fn);
            }
            const { target, need, onTop, onReady, IO } = deps;
            this.target = target;
            this.need = need;
            this.onTop = onTop;
            this.onReady = onReady;
            this.watched = new WeakSet();
            this.waiting = new WeakSet();
            // capsule → { box, clip }: its box and the part in view, from the
            // observer's last entry.
            this.seen = new WeakMap();
            this.io = new IO((entries) => {
                let ready = false;
                for (const e of entries) {
                    const was = this._inView(e.target);
                    if (e.isIntersecting) this.seen.set(e.target, { box: e.boundingClientRect, clip: e.intersectionRect });
                    else this.seen.delete(e.target);
                    if (!was && this._inView(e.target)) ready = true;
                }
                if (ready) onReady();
            }, { threshold: THRESHOLDS });
        }

        // Tell when the capsule comes into view or its art loads.
        watch(link) {
            const el = this.target(link);
            if (!el) return;
            if (!this.watched.has(el)) {
                this.watched.add(el);
                this.io.observe(el);
            }
            // decode() settles once the image is loaded and ready to paint. It
            // rejects on a broken image or one whose src changed: a later
            // watch then waits again.
            for (const img of this._images(el)) {
                if (loaded(img) || this.waiting.has(img)) continue;
                this.waiting.add(img);
                img.decode().then(() => this.onReady(), () => this.waiting.delete(img));
            }
        }

        ready(link) {
            const el = this.target(link);
            return !!el && this._inView(el) && this._images(el).every(loaded) && this.onTop(el);
        }

        _inView(el) {
            const s = this.seen.get(el);
            if (!s) return false;
            const { box, clip } = s;
            const r = this.need(el, box.width, box.height);
            return box.left + r.left >= clip.left - SLACK && box.top + r.top >= clip.top - SLACK
                && box.left + r.right <= clip.right + SLACK && box.top + r.bottom <= clip.bottom + SLACK;
        }

        // The images the capsule shows: one it hides (a hover screenshot,
        // display:none) may never load.
        _images(el) {
            const all = el.tagName === 'IMG' ? [el] : Array.from(el.querySelectorAll('img'));
            return all.filter(img => img.getClientRects().length > 0);
        }
    }

    // A broken image counts as not loaded: its capsule is left.
    const loaded = (img) => img.complete && img.naturalWidth > 0;

    class AiBrowse {
        // deps:
        //   links() → the page's `a[href*="/app/"]` (in linkScope)
        //   pageAppid: the appid of the game page open, or null
        //   ready(link) → its capsule is in view and loaded; watch(link): tell when it is
        //   isEnabled() → the master switch
        //   isLoggedIn() → Promise<bool>
        //   aiGames(keep) → Promise<Set of appid numbers> (ILAP.aiGames over the
        //     built-in lists)
        //   aiKinds() → Promise<Map appid number → 'translation' | 'ingame'>
        //     (ILAP.aiKinds), the AI use a game's flag names
        //   readAccount() → Promise<userdata map with .owned and .wishlist, or null>
        //   readSpared(readAt) → Promise<{ hand, refused, own }>, the Sets of appids
        //     to leave unshot: un-ignored by hand, refused by Steam lately, and queued
        //     by a swipe or ignored too lately for an account read made at `readAt`
        //   skip(link, appid) → true for a game this tab already marked, or a
        //     capsule Steam already greys out
        //   nameOf(appid, link) → the name the page shows
        //   enqueue(entries) → Promise<{ kind }> (Store.enqueueMiMany)
        //   onQueued(appid, links, index, ts, landed): the badge and the shot,
        //     landed() just before the badge, false when the badge must not go on
        //   tag(link, appid, blur, kind, flag): the AI flag on its capsule when
        //     `flag`, and the blur
        //   untag(): every AI mark and blur of tag() off the page
        constructor(deps) {
            // Every hook is required, as for IgnoreManager: this one queues
            // ignores with no gesture, so a slip in its wiring fails here.
            for (const fn of ['links', 'ready', 'watch', 'isEnabled', 'isLoggedIn', 'aiGames', 'aiKinds', 'readAccount',
                'readSpared', 'skip', 'nameOf', 'enqueue', 'onQueued', 'tag', 'untag']) {
                if (typeof deps[fn] !== 'function') throw new TypeError('[ILAP] AiBrowse needs deps.' + fn);
            }
            this.d = deps;
            this.level = 0;
            this.keep = { translation: false, ingame: false };
            // Games looked at on this page, and those of them this tab queued.
            this.seen = new Set();
            this.queued = new Set();
            // Games queued whose shot has not landed yet: their covers stay sharp.
            this.landing = new Set();
            // The games un-ignored by hand, from the last read (readSpared, spared()).
            this.hand = new Set();
            this._account = null;
            this._accountAt = 0;
            this._readFailedAt = 0;
            this._refusedAt = 0;
            this._running = false;
            this._again = false;
        }

        // The level (normalized) and the AI tab's boxes, from storage.
        setOptions({ level, keep }) {
            const next = { translation: keep.translation === true, ingame: keep.ingame === true };
            const keepChanged = next.translation !== this.keep.translation || next.ingame !== this.keep.ingame;
            const levelChanged = level !== this.level;
            this.level = level;
            this.keep = next;
            // A box ticked or cleared changes which games count, so the games
            // this tab passed over are looked at again.
            if (keepChanged) this.seen = new Set(this.queued);
            // The next scan marks the page anew. The games already queued
            // stay queued at a lower level.
            if (keepChanged || levelChanged) this.d.untag();
        }

        // One scan at a time: a scan asked for while one runs runs once after it.
        async scan() {
            if (this._running) { this._again = true; return; }
            this._running = true;
            try {
                do {
                    this._again = false;
                    await this._scanOnce();
                } while (this._again);
            } finally {
                this._running = false;
            }
        }

        async _scanOnce() {
            if (this.level < LOW || !this.d.isEnabled()) return;
            const [ai, kinds] = await Promise.all([this.d.aiGames(this.keep), this.d.aiKinds()]);
            if (this.level < LOW || !this.d.isEnabled()) return;
            const blur = this.level >= MEDIUM;
            const kindOf = (appid) => kinds.get(Number(appid)) || 'ai';
            const found = new Map();
            for (const link of this.d.links()) {
                const m = APP_RE.exec(link.getAttribute('href') || '');
                if (!m) continue;
                const appid = m[1];
                if (appid === this.d.pageAppid || !ai.has(Number(appid))) continue;
                if (link.closest && link.closest('dialog')) continue;
                // A game still to be shot is blurred once its shot lands (_landed).
                const shootable = this.level === HIGH && !this.seen.has(appid)
                    && !this.d.skip(link, appid) && !this._spent(appid);
                this.d.tag(link, appid, blur && !shootable && !this.landing.has(appid), kindOf(appid), this._flags(appid));
                if (!shootable) continue;
                if (!this.d.ready(link)) {
                    this.d.watch(link);
                    continue;
                }
                if (!found.has(appid)) found.set(appid, []);
                found.get(appid).push(link);
            }
            if (!found.size || Date.now() - this._refusedAt < ENQUEUE_RETRY_MS) return;
            if (!(await this.d.isLoggedIn())) return;
            const account = await this._readAccount();
            if (!account) return;
            // Read on every scan: another tab may have spared or ignored a game
            // since. A failed read shoots nothing: it could be one of them.
            const spared = await this.d.readSpared(this._accountAt).catch(() => null);
            if (!spared || !this._active()) return;
            this.hand = spared.hand;

            const shoot = [];
            for (const [appid, links] of found) {
                if (this._spent(appid) || spared.hand.has(appid) || spared.refused.has(appid) || spared.own.has(appid)) {
                    this.seen.add(appid);
                    // Left unshot, so blurred now.
                    for (const l of links) this.d.tag(l, appid, true, kindOf(appid), this._flags(appid));
                    continue;
                }
                shoot.push({ appid, links, name: this.d.nameOf(appid, links[0]), kind: kindOf(appid) });
            }
            if (!shoot.length) return;

            const ts = Date.now();
            const outcome = await this.d.enqueue(shoot.map(s => ({ appid: s.appid, name: s.name, reason: 0, ts, auto: true })));
            if (!outcome || outcome.kind !== 'added') {
                // No room: the queue waits (a 429 penalty, a halted route) and
                // the switch has its share of it (Store.AUTO_SHARE). Nothing is
                // said, the user did nothing, and the games are tried again.
                this._refusedAt = Date.now();
                return;
            }
            shoot.forEach((s, i) => {
                this.seen.add(s.appid);
                this.queued.add(s.appid);
                this.landing.add(s.appid);
                this.d.onQueued(s.appid, s.links, i, ts, () => this._landed(s.appid, s.links, s.kind));
            });
        }

        // The games un-ignored by hand, as storage has them now (another tab
        // or this one spared one): their flags go on with the next scan.
        spared(appids) {
            this.hand = new Set([].concat(appids || []).map(String));
        }

        // Whether the game's capsule takes the AI flag: at every level below
        // HIGH, and at HIGH once the user un-ignored it by hand.
        _flags(appid) {
            return this.level < HIGH || this.hand.has(appid);
        }

        // Games whose entry left the queue before their shot landed (the
        // ilap_unignored pulse: the job removed, the entry dropped or taken
        // back). Their shots land with no badge.
        dropped(appids) {
            for (const appid of [].concat(appids)) this.landing.delete(String(appid));
        }

        // The game's shot has landed: its cover blurs as its badge goes on,
        // with the crossed mark in place of a flag. False for a game dropped
        // meanwhile, which gets no badge.
        _landed(appid, links, kind) {
            if (!this.landing.delete(appid)) return false;
            if (this.level >= MEDIUM && this.d.isEnabled()) {
                for (const l of links) this.d.tag(l, appid, true, kind, false);
            }
            return true;
        }

        // Already ignored, owned or wishlisted, by the page's userdata read.
        _spent(appid) {
            const a = this._account;
            return !!a && (a.has(appid) || a.owned.has(appid) || a.wishlist.has(appid));
        }

        _active() {
            return this.level === HIGH && this.d.isEnabled();
        }

        // One userdata read per page. One with no library or wishlist is no
        // read: the scan waits for a later one.
        async _readAccount() {
            if (this._account) return this._account;
            if (Date.now() - this._readFailedAt < READ_RETRY_MS) return null;
            const at = Date.now();
            const map = await this.d.readAccount().catch(() => null);
            if (!map || !map.owned || !map.wishlist) {
                this._readFailedAt = Date.now();
                return null;
            }
            this._account = map;
            this._accountAt = at;
            return map;
        }
    }

    // The switch as a store page runs it: the capsule a link stands for (the
    // element a badge would go on), its shot (shot.js), the viewport and the
    // scan, wired together. `deps`:
    //   strategies   ContainerStrategyProvider (containers.js)
    //   marks        { isMarked(link, appid), markAuto(appid, ts) } (IgnoreManager)
    //   tags         { tag(link, appid, blur, kind, flag), untag() } (ai-marks.js)
    //   isEnabled, isLoggedIn, aiGames, aiKinds, readAccount, readSpared, enqueue: AiBrowse's
    //   nameOf(appid, el) → the name the page shows around `el`
    //   countShot() → counts a game shot and answers its number (ShotAnimator)
    //   requestScan() → a scan, fire-and-forget
    //   settings     src/settings-schema.js
    //   ShotAnimator the class (shot.js)
    // Returns { browse, setShot(style), setAnim(on), untag() }: the scan, the
    // shot's style and animation setters, and the AI marks off the page (the
    // master switch went off).
    function wire(deps) {
        // These would only fail at the first scan or shot: check them at boot.
        for (const dep of ['strategies', 'marks', 'tags', 'settings', 'ShotAnimator', 'nameOf', 'countShot', 'requestScan']) {
            if (!deps || !deps[dep]) throw new TypeError('[ILAP] wireAiBrowsing needs deps.' + dep);
        }
        const capsule = (link) => {
            const c = deps.strategies.findContainer(link);
            if (!c) return link;
            return c.element.tagName === 'IMG' ? c.element.parentElement : c.element;
        };
        // What a shot draws on: the capsule, or a wide row's cover.
        const cover = (link) => deps.strategies.coverOf(capsule(link));
        const { DEFAULTS, SHOT_EMOJI } = deps.settings;
        let style = DEFAULTS.AI_SHOT;
        let emoji = DEFAULTS.AI_SHOT_EMOJI;
        let anim = true;
        const shots = new deps.ShotAnimator({
            style: () => style,
            emoji: () => emoji,
            emojiPool: () => SHOT_EMOJI,
            countShot: deps.countShot,
            // The animation turned off in the AI tab works as reduced motion.
            reduceMotion: () => !anim || window.matchMedia('(prefers-reduced-motion: reduce)').matches,
            target: cover,
        });
        const pageApp = /^\/app\/(\d+)/.exec(location.pathname);
        const scope = linkScope(location.pathname, location.search);
        const viewport = new Viewport({
            target: cover,
            need: (el, w, h) => shots.need(el, w, h),
            // Shown, and what the window shows at the middle of the shot's
            // part: a slide stacked under another is neither.
            onTop: (el) => {
                if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
                const b = el.getBoundingClientRect();
                const r = shots.need(el, b.width, b.height);
                const hit = document.elementFromPoint(b.left + (r.left + r.right) / 2, b.top + (r.top + r.bottom) / 2);
                if (!hit) return false;
                const link = hit.closest('a[href]');
                return el.contains(hit) || (!!link && link.contains(el));
            },
            onReady: deps.requestScan,
            IO: window.IntersectionObserver,
        });
        const browse = new AiBrowse({
            links: () => {
                if (scope === 'none') return [];
                const root = scope === 'strip' ? document.querySelector(QUEUE_STRIP) : document;
                return root ? root.querySelectorAll('a[href*="/app/"]') : [];
            },
            pageAppid: pageApp ? pageApp[1] : null,
            ready: (link) => viewport.ready(link),
            watch: (link) => viewport.watch(link),
            isEnabled: deps.isEnabled,
            isLoggedIn: deps.isLoggedIn,
            aiGames: deps.aiGames,
            aiKinds: deps.aiKinds,
            readAccount: deps.readAccount,
            readSpared: deps.readSpared,
            skip: (link, appid) => deps.marks.isMarked(link, appid),
            nameOf: (appid, link) => deps.nameOf(appid, capsule(link)),
            enqueue: deps.enqueue,
            // The AI blur first, so a badge's own blur or veil comes in under it softly.
            onQueued: (appid, links, index, ts, landed) =>
                shots.shoot(links, index, () => { if (landed()) deps.marks.markAuto(appid, ts); }),
            tag: deps.tags.tag,
            untag: deps.tags.untag,
        });
        return {
            browse, setShot: (s) => { style = s; }, setEmoji: (e) => { emoji = e; }, setAnim: (on) => { anim = on; },
            untag: deps.tags.untag,
        };
    }

    window.ILAP.ManualIgnore.AiBrowse = AiBrowse;
    window.ILAP.ManualIgnore.AiSpared = AiSpared;
    window.ILAP.ManualIgnore.wireAiBrowsing = wire;
    window.ILAP.ManualIgnore.AiViewport = Viewport;
    window.ILAP.ManualIgnore.aiLinkScope = linkScope;
})();
