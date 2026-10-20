// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    const TOAST_COOLDOWN_MS = 10000;

    // How long after ignoring a game its solo un-ignore stays inert: a brake on
    // ignore→rollback POST ping-pong, short enough that nobody notices it.
    const UNIGNORE_COOLDOWN_MS = 2000;

    // How long a gesture on a greyed capsule waits for the gate before it
    // decides without Steam's reason (buildAdapters, steamReason). Past the
    // longest ordinary wait: the swipe marks the user active, so a curator
    // drain reserves at ACTIVE_GAP (3 s), and the read queues one GAP (650 ms)
    // behind it. Only a 429 penalty goes further.
    const STEAM_REASON_WAIT_MS = 4000;

    // true once the menu-at-press hint has been shown (App._hintMenuAtPress).
    const PRESS_MENU_HINT_KEY = 'ilap_press_menu_hint';

    class IgnoreManager {
        constructor(deps) {
            // Every hook is required: a missing login gate or master check would
            // not fail, it would quietly let a gesture through.
            for (const name of ['enqueue', 'enqueueUndo', 'cancelIgnore', 'signalUnignored', 'steamReason',
                'isLoggedIn', 'isEnabled', 'notifyQueueFull', 'notifyUndoQueueFull', 'notifyDropped']) {
                if (typeof deps[name] !== 'function') {
                    throw new TypeError(`[ILAP] IgnoreManager needs deps.${name}`);
                }
            }
            // The collaborators would only fail at the first gesture: check them
            // at boot too.
            const adapters = {
                badgeRenderer: ['render', 'unrender', 'syncPending', 'syncMasks',
                    'steamGreyed', 'tintSteamFlag', 'untintSteamFlag'],
                containerStrategies: ['findContainer'],
                nameExtractor: ['get'],
                sessionState: ['get', 'set'],
            };
            for (const [name, fns] of Object.entries(adapters)) {
                if (!deps[name] || !fns.every(fn => typeof deps[name][fn] === 'function')) {
                    throw new TypeError(`[ILAP] IgnoreManager needs deps.${name}`);
                }
            }
            this.renderer = deps.badgeRenderer;
            this.strategies = deps.containerStrategies;
            this.enqueue = deps.enqueue;            // (appid, name, reason, ts) => Promise<{ kind }>
            this.enqueueUndo = deps.enqueueUndo;    // (appid) => Promise<{ kind }>
            this.cancelIgnore = deps.cancelIgnore;  // (appid, ts) => Promise<boolean>
            this.signalUnignored = deps.signalUnignored;  // (appid) => Promise<void>
            // (appid) => Promise<reason | undefined>: the reason Steam's list has
            // for the game, undefined when it is not there or the read failed.
            this.steamReason = deps.steamReason;
            this.nameExtractor = deps.nameExtractor;
            this.session = deps.sessionState;
            this.isLoggedIn = deps.isLoggedIn;      // () => Promise<bool> (logged-out gate)
            // Master toggle, read live (() => bool). A disabled extension paints
            // nothing on the page — see refreshAll, refreshBadgesForGame, hideBadges.
            this.isEnabled = deps.isEnabled;
            // () => void each, throttled by the adapter. The un-ignore queue has
            // its own "full" card: the MI one names the ignore job.
            this.notifyQueueFull = deps.notifyQueueFull;
            this.notifyUndoQueueFull = deps.notifyUndoQueueFull;
            this.notifyDropped = deps.notifyDropped;

            this.sessionMap = new Map();
            // Appids whose solo un-ignore is queued but not confirmed. Per tab, like
            // the badges it marks.
            this.pending = new Set();
            // When this tab swiped each badged game: the cooldown, and what a
            // cancel asks the queue for — an entry queued by then contains this
            // tab's swipe, a later one is somebody else's. Persisted with the
            // session map for that.
            this.ignoredAt = new Map();
            // Swipes whose enqueue is still in flight. The sessionMap check that
            // opens processIgnoreRequest cannot hold across its awaits — the map
            // is written at the END — so two fast swipes on one capsule both pass
            // it. The queue dedupes, so nothing is ignored twice; what this saves
            // is the second resolve, which on a capsule with no readable name is
            // an appdetails request.
            this._enqueueing = new Set();
            // Games un-ignored since this page loaded, in any tab (the
            // ilap_unignored pulse, reason 'undo'). Steam keeps its grey on them
            // until a reload, so its `ds_ignored` is stale for exactly these.
            this.unignoredHere = new Set();
            // Greyed capsules this tab gestured on: appid -> the reason queued.
            // Their mark is Steam's own flag, tinted, not a badge of ours, so they
            // stay out of the session map (no badge click, no solo un-ignore).
            this.tinted = new Map();
            this.SESSION_KEY = 'ilap_session_map_v2';

            this._loadSession();
        }

        _loadSession() {
            try {
                const stored = this.session.get(this.SESSION_KEY);
                if (!stored) return;
                // sessionStorage is the Steam page's origin, so this is untrusted
                // input, not our own state read back. These appids go straight
                // into querySelectorAll and new RegExp (refreshBadgesForGame,
                // ui.js render/unrender/syncMasks), where a `"` or a `(` is not a
                // wrong badge but a thrown DOMException that kills the whole
                // badge pass. A digit string is the only thing this tab ever
                // wrote (EventParser takes it from an /app/ href match).
                const rows = JSON.parse(stored)
                    .filter(([appid]) => typeof appid === 'string' && /^\d+$/.test(appid));
                this.sessionMap = new Map(rows.map(([appid, reason]) => [appid, reason]));
                // A swipe time from the future is no time of ours: it would hold
                // the cooldown shut for good and let a cancel claim another tab's
                // entry. Without one the cancel errs safe (a real rollback).
                const now = Date.now();
                for (const [appid, , ts] of rows) {
                    if (Number.isFinite(ts) && ts <= now) this.ignoredAt.set(appid, ts);
                }
            } catch (e) { /* ignore */ }
        }

        _saveSession() {
            try {
                this.session.set(this.SESSION_KEY, JSON.stringify(Array.from(this.sessionMap,
                    ([appid, reason]) => [appid, reason, this.ignoredAt.get(appid)])));
            } catch(e) { /* ignore */ }
        }

        async processIgnoreRequest(intent) {
            const { appid, reason, linkElement } = intent;

            if (this.sessionMap.has(appid) || this._enqueueing.has(appid)) return;

            // Steam already greys this capsule out: the game is on the account's
            // list. The gesture then sets its reason, and Steam's flag takes the
            // gesture's colour instead of a badge of ours.
            const greyed = !this.unignoredHere.has(appid) && this.renderer.steamGreyed(linkElement);
            if (greyed && this.tinted.get(appid) === reason) return;

            this._enqueueing.add(appid);
            try {
                // A logged-out swipe does nothing: its POST could only be refused,
                // and the drainer parks on a dead session rather than dropping the
                // job, so the badge would never be corrected.
                if (!(await this.isLoggedIn())) return;

                // The reason Steam already has changes nothing: no POST, and no
                // mark either. Unless this tab tinted the other reason since:
                // then it is queued to take that back, and the tint goes. A
                // failed read leaves it to the drainer's own check.
                const asSteam = greyed && (await this.steamReason(appid)) === reason;
                if (asSteam && !this.tinted.has(appid)) return;

                // The name now, while the DOM is live: the drainer stamps Last
                // Ignored with it when the POST lands.
                const containerObj = this.strategies.findContainer(linkElement);
                const contextEl = containerObj ? containerObj.element : linkElement;
                const name = await this.nameExtractor.get(appid, contextEl);

                // Enqueue before badging: a swipe past MI_MAX is refused, and the
                // badge must only paint for one that landed.
                const ts = Date.now();
                const outcome = await this.enqueue(appid, name, reason, ts);
                if (!outcome || outcome.kind !== 'added') {
                    // The cap is only reached when the queue is not draining at
                    // all, so say so rather than paint nothing.
                    if (outcome && outcome.kind === 'full') this.notifyQueueFull();
                    return;
                }
                if (asSteam) {
                    this.tinted.delete(appid);
                    this.renderer.untintSteamFlag(appid);
                } else if (greyed) {
                    this.tinted.set(appid, reason);
                    // Through refreshAll's pass rather than `greyed` alone: the
                    // same game may sit in several capsules on the page.
                    this.refreshAll();
                } else {
                    this._onEnqueued(intent, ts);
                }
            } finally {
                this._enqueueing.delete(appid);
            }
        }

        _onEnqueued(intent, ts) {
            const { appid, reason } = intent;

            this.sessionMap.set(appid, reason);
            this.ignoredAt.set(appid, ts);
            this._saveSession();

            this.refreshBadgesForGame(appid);
        }

        // Un-ignore one game, through the same queue and gate. Only what this tab
        // badged: the session map is the badge model.
        async processUnignoreRequest(intent) {
            const { appid } = intent;

            if (!this.sessionMap.has(appid)) return;   // nothing badged → nothing to undo
            if (this.pending.has(appid)) return;       // already queued; re-gesturing is a no-op

            // Regret before the ignore was sent: cancel the queued entry instead
            // of queueing a rollback. Ahead of both gates below: the cooldown
            // brakes POST ping-pong and a cancel sends no POST, and cancelling
            // needs no session.
            if (await this.cancelIgnore(appid, this.ignoredAt.get(appid))) {
                // Through the pulse, not in place: another tab may have badged the
                // same game, and this tab's own listener handles it on the way back.
                await this.signalUnignored(appid);
                return;
            }

            // From here it is a real remove=1 POST: the cooldown applies, silently.
            const at = this.ignoredAt.get(appid);
            if (at && Date.now() - at < UNIGNORE_COOLDOWN_MS) return;

            // Same logged-out gate as the ignore path.
            if (!(await this.isLoggedIn())) return;

            const outcome = await this.enqueueUndo(appid);
            if (!outcome || outcome.kind !== 'added') {
                if (outcome && outcome.kind === 'full') this.notifyUndoQueueFull();
                return;
            }
            this.pending.add(appid);
            this.syncPending();
        }

        // A rollback was refused or its job removed: the badges are still true,
        // only the pending marks come off. All of them, since the pulse carries no
        // appid; at worst a still-queued gesture loses its mark.
        clearPending() {
            if (!this.pending.size) return;
            this.pending.clear();
            this.syncPending();
        }

        syncPending() {
            this.renderer.syncPending(Array.from(this.pending));
        }

        // The ilap_unignored pulse: drop the marks this tab painted for these
        // games. 'undo' took them off the list; 'removed' and 'failed' left
        // Steam's list as it was. 'failed' is the one the user did
        // not ask for, so only then — and only in a tab that marked one — is it said.
        handleUnignored(appids, reason) {
            let dropped = 0;
            for (const raw of (Array.isArray(appids) ? appids : [appids])) {
                const appid = String(raw);
                if (reason === 'undo') this.unignoredHere.add(appid);
                if (this.tinted.delete(appid)) {
                    this.renderer.untintSteamFlag(appid);
                    dropped += 1;
                }
                if (!this.sessionMap.has(appid)) continue;  // only clear what THIS tab badged
                this.sessionMap.delete(appid);
                this.pending.delete(appid);   // the badge is going — its mark goes with it
                this.ignoredAt.delete(appid);
                this.renderer.unrender(appid);
                dropped += 1;
            }
            if (!dropped) return;
            this._saveSession();
            if (reason === 'failed') this.notifyDropped();
        }

        refreshBadgesForGame(appid) {
            // A gesture mid-enqueue when the switch went off must not paint; its
            // session entry stays for the re-enable.
            if (!this.isEnabled()) return;
            const reason = this.sessionMap.get(appid) || 0;
            
            const exact = new RegExp(`/app/${appid}(/|\\?|$)`);
            const candidates = document.querySelectorAll(`a[href*="/app/${appid}"]`);
            candidates.forEach(link => {
                if (!exact.test(link.getAttribute('href'))) return;
                this.renderer.render(link, appid, reason);
            });
        }

        refreshAll() {
            // Guarded here rather than at the three call sites.
            if (!this.isEnabled()) return;
            if (this.sessionMap.size === 0 && this.tinted.size === 0) return;
            // One document pass against the session map and the tints, not one
            // per appid: this runs on every mutation batch of the storefront.
            const links = document.querySelectorAll('a[href*="/app/"]');
            for (const link of links) {
                const m = (link.getAttribute('href') || '').match(/\/app\/(\d+)([/?]|$)/);
                if (!m) continue;
                if (this.tinted.has(m[1])) {
                    const greyed = this.renderer.steamGreyed(link);
                    if (greyed) this.renderer.tintSteamFlag(greyed, m[1], this.tinted.get(m[1]));
                }
                if (!this.sessionMap.has(m[1])) continue;
                this.renderer.render(link, m[1], this.sessionMap.get(m[1]) || 0);
            }
            // Badges Steam just rebuilt come back without their pending mark.
            if (this.pending.size) this.syncPending();
        }

        syncMasks() {
            this.renderer.syncMasks(Array.from(this.sessionMap.keys()));
        }

        // Master toggle off: unrender every mark this tab painted (badge, blur,
        // veil). The session map stays — it is the model a re-enable repaints from.
        hideBadges() {
            for (const appid of this.sessionMap.keys()) this.renderer.unrender(appid);
            for (const appid of this.tinted.keys()) this.renderer.untintSteamFlag(appid);
        }
    }

    // Exported for the Node unit suite only; boot() below is the one construction site.
    window.ILAP.ManualIgnore.IgnoreManager = IgnoreManager;

    // One push card per burst (src/toast.js), however many times it fires.
    function throttledToast(key) {
        let lastAt = 0;
        return () => {
            const now = Date.now();
            if (now - lastAt < TOAST_COOLDOWN_MS) return;
            lastAt = now;
            // showToast escapes; this caller passes plain text.
            window.ILAP.showToast(window.ILAP.t(key), 5000);
        };
    }

    // What the IgnoreManager needs from outside: the queue store, name
    // resolution, the login gate, the push cards.
    //
    // A swipe never POSTs: it paints the badge and enqueues a type:'mi' job, and
    // the drainer sends it through the rate gate. Stats and the undo log are
    // written by the drainer when the POST lands.
    function buildAdapters() {
        const Store = window.ILAP.Curator.Store;
        return {
            enqueue: (appid, name, reason, ts) => Store.enqueueMi({ appid, name, reason, ts }),
            enqueueUndo: (appid) => Store.enqueueMiUndo({ appid }),
            cancelIgnore: (appid, ts) => Store.cancelMiEntry(appid, ts),
            // A cancelled swipe un-badges like a rollback: the silent 'undo' reason.
            signalUnignored: (appid) => Store.signalUnignored([appid], 'undo'),
            // A userdata GET, paced in the ignores' stream: swiping greyed covers
            // during a curator drain shares it. A slot further off than
            // STEAM_REASON_WAIT_MS (a 429 penalty) skips the read, and the
            // drainer's own check decides instead. The skipped read keeps its
            // slot: one GAP more for the drain, during a penalty only.
            steamReason: async (appid) => {
                const paced = window.ILAP.IgnoreGate.paceRead().then(() => true);
                const late = new Promise(resolve => setTimeout(() => resolve(false), STEAM_REASON_WAIT_MS));
                if (!(await Promise.race([paced, late]))) return undefined;
                const ignored = await window.ILAP.fetchIgnoredAppsStrict();
                return ignored ? ignored.get(String(appid)) : undefined;
            },
            nameExtractor: { get: (appid, el) => window.ILAP.resolveGameName(appid, el) },
            // Not the sessionid cookie: Steam gives one to anonymous visitors too.
            // Fails closed: a probe that could not be made is not a session.
            isLoggedIn: async () => (await window.ILAP.SteamAuth.hasLiveSession()) === true,
            // The swipe was refused outright (queue at MI_MAX)…
            notifyQueueFull: throttledToast('mi_queue_stuck'),
            // …the same, for the un-ignore job at MIUNDO_MAX (its own card: the
            // one above names the ignore job)…
            notifyUndoQueueFull: throttledToast('miundo_queue_stuck'),
            // …and: the swipe was accepted, but its deferred POST never landed.
            notifyDropped: throttledToast('mi_ignore_failed')
        };
    }

    class App {
        constructor(configService) {
            this.configService = configService;

            const MI = window.ILAP.ManualIgnore;

            // Shared Infrastructure
            const sessionService = new window.ILAP.SessionStateService();
            const resourceService = new window.ILAP.ResourceService();

            // UI Dependencies
            const strategies = new MI.ContainerStrategyProvider();
            const detector = new MI.DuplicateDetector(MI.ContextScanner);
            const maskConfig = { isEnabled: () => this.configService.get().maskEnabled };
            const badgeRenderer = new MI.BadgeRenderer(strategies, detector, MI.BADGE_CLASSES, resourceService, maskConfig);

            // Not an MI outcome, but this is the one content script with a push card
            // on every store page. No badge to correct, so not the manager's.
            this.notifyUndoFailed = throttledToast('undo_failed');

            this.ignoreManager = new IgnoreManager(Object.assign(buildAdapters(), {
                badgeRenderer,
                containerStrategies: strategies,
                sessionState: sessionService,
                isEnabled: () => this.configService.get().enabled
            }));

            this.eventParser = new MI.EventParser(this.configService);
            this.swipeDetector = new MI.SwipeGestureDetector(this.configService);
        }

        async init() {
            await this.configService.init();
            this.configService.listen();
            this.configService.onChange((config) => {
                // The master toggle rides this same change feed: off strips the
                // page clean, on repaints from the session map.
                if (!config.enabled) {
                    this.ignoreManager.hideBadges();
                    return;
                }
                this.ignoreManager.refreshAll();
                this.ignoreManager.syncMasks();
            });

            this.setupInteractions();
            this.setupObserver();

            // ilap_unignored: badges to drop. ilap_undo_failed: a rollback that
            // will not land, so only the pending marks come off. Each pulse's
            // reason decides whether a card goes with it.
            const Store = window.ILAP.Curator.Store;
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local') return;
                const p = changes[Store.UNIGNORE_PULSE_KEY];
                const pulsed = p && p.newValue && p.newValue.appids;
                if (pulsed) {
                    this.ignoreManager.handleUnignored(pulsed, p.newValue.reason);
                }
                const u = changes[Store.UNDO_FAILED_KEY] && changes[Store.UNDO_FAILED_KEY].newValue;
                if (u) {
                    // 'removed': the user dropped the job, so nothing is said.
                    this.ignoreManager.clearPending();
                    if (u.reason !== 'removed') this.notifyUndoFailed();
                }
            });

            this.ignoreManager.refreshAll();
        }

        // The first time the detector cancels a menu that opened at press (macOS,
        // Linux), say once per install why the menu is gone on game covers and
        // how to get it back. Asked once per tab, so every later press in it
        // costs no storage read.
        _hintMenuAtPress() {
            if (this._menuHintAsked) return;
            this._menuHintAsked = true;
            chrome.storage.local.get(PRESS_MENU_HINT_KEY, (d) => {
                if (chrome.runtime.lastError || d[PRESS_MENU_HINT_KEY]) return;
                chrome.storage.local.set({ [PRESS_MENU_HINT_KEY]: true });
                window.ILAP.showToast(window.ILAP.t('press_menu_hint'), 12000);
            });
        }

        // Both paths are fire-and-forget: a gesture is not awaited by anything.
        // A storage write that rejects — in practice an extension update, which
        // leaves this page's script running with no storage behind it — would
        // otherwise leave an unhandled rejection per swipe.
        _dispatch(intent, action) {
            const handler = action === 'unignore'
                ? this.ignoreManager.processUnignoreRequest(intent)
                : this.ignoreManager.processIgnoreRequest(intent);
            handler.catch((e) => console.warn('[ILAP] gesture failed:', e));
        }

        setupInteractions() {
            document.body.addEventListener('click', (e) => {
                if (!e.isTrusted) return; // ignore only real user input, not page-synthesized clicks
                // A badge click belongs to the badge listener below alone: both
                // capture on this node, so it could not stop this one.
                if (e.target.closest('.ilap-ignored-overlay')) return;
                const intent = this.eventParser.parseClick(e);
                if (intent) {
                    e.preventDefault();
                    e.stopPropagation();
                    // The parser says which action the click resolved to.
                    this._dispatch(intent, intent.action);
                }
            }, true);

            this.swipeDetector.attach(document.body, (gestureData) => {
                // Same hand-off as the click listener: a gesture started on a badge
                // ends in a contextmenu the badge listener answers, so the badge wins.
                if (gestureData.startEl.closest
                    && gestureData.startEl.closest('.ilap-ignored-overlay')) return;
                const intent = this.eventParser.createIntent(gestureData.startEl, gestureData.reason);
                if (!intent) return;
                this._dispatch(intent, gestureData.action);
            }, () => this._hintMenuAtPress());

            // The un-ignore that cannot be rebound: a click on the IGNORED badge,
            // either button, whatever the select says (its "off" is labelled for
            // this). Delegated, since badges come and go. Behind the master switch
            // like every binding: a disabled extension queues nothing and leaves the
            // page's own menu alone.
            const onBadge = (e) => {
                if (!e.isTrusted) return;
                if (!this.configService.get().enabled) return;
                const badge = e.target.closest('.ilap-ignored-overlay');
                if (!badge || !badge.dataset.ilapAppid) return;
                e.preventDefault();
                e.stopPropagation();
                this._dispatch({ appid: badge.dataset.ilapAppid }, 'unignore');
            };
            document.body.addEventListener('click', onBadge, true);
            document.body.addEventListener('contextmenu', onBadge, true);
        }

        setupObserver() {
            let timeout;
            const observer = new MutationObserver((mutations) => {
                const shouldRun = mutations.some(m => m.addedNodes.length > 0);
                if (shouldRun) {
                    clearTimeout(timeout);
                    timeout = setTimeout(() => this.ignoreManager.refreshAll(), 200);
                }
            });
            const root = document.getElementById('page_root') || document.body;
            observer.observe(root, { childList: true, subtree: true });
        }
    }

    // A document_idle script can land after window.onload (Firefox does), where a
    // bare 'load' listener would never run.
    const boot = () => {
        const { DEFAULTS } = window.ILAP.Settings;
        const defaultConfig = {
            defaultKey: DEFAULTS.SHORTCUT, platformKey: DEFAULTS.PLATFORM,
            unignoreKey: DEFAULTS.UNIGNORE, enabled: true, maskEnabled: true
        };
        const configService = new window.ILAP.ManualIgnore.ConfigService(defaultConfig);
        // The last fire-and-forget promise on this path: its first act is a
        // storage read, which throws on a context an update has already replaced
        // (a store page open across an extension update boots the new script into
        // a page whose old one is orphaned, and a reload is the only cure).
        new App(configService).init()
            .catch((e) => console.warn('[ILAP] Manual Ignore did not start:', e));
    };
    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot);

})();