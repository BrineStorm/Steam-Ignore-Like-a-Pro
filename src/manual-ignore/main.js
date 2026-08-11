// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    const TOAST_COOLDOWN_MS = 10000;

    // How long after ignoring a game its solo un-ignore gesture stays inert.
    // Purely an anti-fiddling brake on ignore→rollback ping-pong: long enough
    // that a deliberate "wrong one" still lands well inside the moment, short
    // enough that nobody notices it. Held in memory only (see `ignoredAt`).
    const UNIGNORE_COOLDOWN_MS = 2000;

    class IgnoreManager {
        // Injected as a deps object, like the rest of the queue-era code
        // (UndoService, CuratorQueueDrainer, EnqueueService): the positional
        // list had grown to seven and a mis-ordered call site would have failed
        // silently rather than loudly.
        constructor(deps) {
            this.renderer = deps.badgeRenderer;
            this.strategies = deps.containerStrategies;
            this.enqueue = deps.enqueue;            // (appid, name, reason) => Promise<{ kind }>
            this.enqueueUndo = deps.enqueueUndo;    // (appid) => Promise<{ kind }>
            this.cancelIgnore = deps.cancelIgnore;  // (appid) => Promise<boolean>
            this.signalUnignored = deps.signalUnignored;  // (appid) => Promise<void>
            this.nameExtractor = deps.nameExtractor;
            this.session = deps.sessionState;
            this.isLoggedIn = deps.isLoggedIn;      // () => Promise<bool> (logged-out gate)
            this.notifyQueueFull = deps.notifyQueueFull || null;  // () => void, throttled by the adapter
            // The un-ignore queue's own "full" card. A separate one because the
            // MI card names the IGNORE job by hand ("remove the job and try
            // again") and would send the user to the wrong row.
            this.notifyUndoQueueFull = deps.notifyUndoQueueFull || null;
            this.notifyDropped = deps.notifyDropped || null;      // () => void, same contract

            this.sessionMap = new Map();
            // Appids whose solo un-ignore is queued but not yet confirmed. In
            // memory only, like the badges it marks: both are per-tab, and a
            // reload re-reads the queue as the source of truth anyway.
            this.pending = new Set();
            // When this tab swiped each badged game, for the un-ignore cooldown
            // alone. In memory and never persisted: a reload has already spent
            // far more than the cooldown, so there is nothing to restore — and
            // nothing about when the user acted is written anywhere.
            this.ignoredAt = new Map();
            this.SESSION_KEY = 'ilap_session_map_v2';

            this._loadSession();
        }

        _loadSession() {
            try {
                const stored = this.session.get(this.SESSION_KEY);
                if (stored) this.sessionMap = new Map(JSON.parse(stored));
            } catch (e) { /* ignore */ }
        }

        _saveSession() {
            try {
                this.session.set(this.SESSION_KEY, JSON.stringify(Array.from(this.sessionMap.entries())));
            } catch(e) { /* ignore */ }
        }

        async processIgnoreRequest(intent) {
            const { appid, reason, linkElement } = intent;

            if (this.sessionMap.has(appid)) return;

            // A logged-out swipe does nothing — the deferred POST could only be
            // refused, so painting the badge would be a lie the queue never gets
            // to correct (the drainer parks on a dead session instead of dropping
            // the job). Keeps the optimistic badge honest: we never badge a swipe
            // we can't ignore.
            if (this.isLoggedIn && !(await this.isLoggedIn())) return;

            // Resolve the name now, while the DOM context is live (only the rare
            // nameless carousel capsule awaits an appdetails GET); the drainer
            // needs it to stamp Last Ignored when the deferred POST lands.
            const containerObj = this.strategies.findContainer(linkElement);
            const contextEl = containerObj ? containerObj.element : linkElement;
            const name = await this.nameExtractor.get(appid, contextEl);

            // Enqueue BEFORE badging: a swipe past MI_MAX is a silent no-op, so we
            // must know it landed before painting the optimistic badge. The POST
            // itself is sent later, paced through the IgnoreGate by the drainer.
            const outcome = await this.enqueue(appid, name, reason);
            if (!outcome || outcome.kind !== 'added') {
                // At MI_MAX the enqueue is a no-op, and a swipe that paints
                // nothing reads as a broken extension. The cap is only reached
                // when the queue isn't draining at all (no store tab + a halted
                // SW route, a gate stop, a dead session), so say the honest
                // thing: the queue is stuck, remove the job and retry.
                if (outcome && outcome.kind === 'full' && this.notifyQueueFull) this.notifyQueueFull();
                return;
            }
            this._onEnqueued(intent);
        }

        _onEnqueued(intent) {
            const { appid, reason } = intent;

            this.sessionMap.set(appid, reason);
            this.ignoredAt.set(appid, Date.now());
            this._saveSession();

            this.refreshBadgesForGame(appid);
        }

        // The mirror gesture: un-ignore ONE game, deferred through the same queue
        // and the same rate gate. Scoped to what this tab badged — the session map
        // IS the badge model, so "there is a badge under the cursor" and "the
        // appid is in the map" are the same statement. A game ignored in another
        // tab or another session simply has no badge here to gesture at.
        async processUnignoreRequest(intent) {
            const { appid } = intent;

            if (!this.sessionMap.has(appid)) return;   // nothing badged → nothing to undo
            if (this.pending.has(appid)) return;       // already queued; re-gesturing is a no-op

            // Regret before the ignore was ever sent: cancel the queued entry
            // rather than queue a rollback for it. Nothing was ignored, so
            // nothing needs un-ignoring — the badge just goes.
            //
            // Tried FIRST, ahead of both gates below, and the order is the whole
            // point. The cooldown is a brake on ignore→rollback POST ping-pong;
            // a cancel emits no POST in either direction, so it has nothing to
            // brake. Behind the cooldown the branch was also nearly unreachable:
            // the gate paces at MIN_GAP+jitter (~0.5–0.8 s), so a lone queued
            // swipe is already sent well before the 2 s brake lifts, and every
            // "oops, wrong game" cost a real remove=1 — two POSTs, a stats bump
            // and a log entry — for an ignore nobody wanted. Ahead of the
            // logged-out gate for the same kind of reason: cancelling needs no
            // session, and a swipe made while logged out is exactly the one
            // worth taking back.
            if (this.cancelIgnore && await this.cancelIgnore(appid)) {
                // Announced through the pulse instead of applied in place: the
                // pulse is the only cross-tab reach, and badges are per-tab. A
                // second tab that swiped the same game would otherwise go on
                // showing IGNORED for a swipe that was taken back — and go on
                // through reloads, because the session map is persisted. This
                // tab's own listener picks it up on the way back, exactly like
                // every other un-ignore.
                await this.signalUnignored(appid);
                return;
            }

            // Anti-fiddling brake, and from here on it is the only kind of
            // rollback left: a real remove=1 POST for an ignore Steam already
            // has. A game just ignored can't be rolled back for a moment.
            // Silent, like every other gesture that doesn't fire — a card
            // saying "wait two seconds" would be pure noise.
            const at = this.ignoredAt.get(appid);
            if (at && Date.now() - at < UNIGNORE_COOLDOWN_MS) return;

            // Same logged-out gate as the ignore path: with no session the POST
            // cannot succeed, so don't mark a badge pending for it.
            if (this.isLoggedIn && !(await this.isLoggedIn())) return;

            const outcome = await this.enqueueUndo(appid);
            if (!outcome || outcome.kind !== 'added') {
                if (outcome && outcome.kind === 'full' && this.notifyUndoQueueFull) this.notifyUndoQueueFull();
                return;
            }
            this.pending.add(appid);
            this.syncPending();
        }

        // A rollback was refused (or its job was removed): the games stay ignored,
        // so the badges are already truthful — only the provisional mark comes off.
        // Cleared for EVERY pending appid, not one: the `ilap_undo_failed` pulse
        // carries no appid (nothing on the page is wrong, so it never needed one).
        // Worst case a droplist undo's failure un-dims a solo gesture that is still
        // queued — the badge is right either way, and the mark returns on nothing.
        clearPending() {
            if (!this.pending.size) return;
            this.pending.clear();
            this.syncPending();
        }

        syncPending() {
            this.renderer.syncPending(Array.from(this.pending));
        }

        // Games this tab badged are no longer ignored (ilap_unignored pulse) —
        // either an undo drain rolled them back, or their deferred MI POSTs
        // never landed. Drop them from the per-tab session map and un-render the
        // badges, so the page stops showing IGNORED for games that aren't.
        // Usually one appid; a whole list when an MI job is removed from the
        // queue applet with entries still undrained.
        //
        // `reason === 'failed'` is the second case, and it is the only one the
        // user hasn't asked for: from their side a swipe silently un-did itself
        // minutes later. Say so — once per burst, and only in a tab that
        // actually badged one of these games (the sessionMap guard), so the
        // toast lands where the gesture happened instead of in every open tab.
        handleUnignored(appids, reason) {
            let dropped = 0;
            for (const raw of (Array.isArray(appids) ? appids : [appids])) {
                const appid = String(raw);
                if (!this.sessionMap.has(appid)) continue;  // only clear what THIS tab badged
                this.sessionMap.delete(appid);
                this.pending.delete(appid);   // the badge is going — its mark goes with it
                this.ignoredAt.delete(appid);
                this.renderer.unrender(appid);
                dropped += 1;
            }
            if (!dropped) return;
            this._saveSession();
            if (reason === 'failed' && this.notifyDropped) this.notifyDropped();
        }

        refreshBadgesForGame(appid) {
            const reason = this.sessionMap.get(appid) || 0;
            
            const candidates = document.querySelectorAll(`a[href*="/app/${appid}"]`);
            candidates.forEach(link => {
                if (!new RegExp(`/app/${appid}(/|\\?|$)`).test(link.getAttribute('href'))) return;
                this.renderer.render(link, appid, reason);
            });
        }

        refreshAll() {
            if (this.sessionMap.size === 0) return;
            // ONE document pass keyed against the session map — not one
            // document-wide query PER session-ignored appid. This runs on every
            // debounced mutation batch of Steam's continuously-mutating React
            // storefront, so N per-appid sweeps compounded into hundreds of
            // whole-DOM scans per second late in a session.
            const links = document.querySelectorAll('a[href*="/app/"]');
            for (const link of links) {
                const m = (link.getAttribute('href') || '').match(/\/app\/(\d+)([/?]|$)/);
                if (!m || !this.sessionMap.has(m[1])) continue;
                this.renderer.render(link, m[1], this.sessionMap.get(m[1]) || 0);
            }
            // Badges Steam just rebuilt come back without their pending mark.
            if (this.pending.size) this.syncPending();
        }

        syncMasks() {
            this.renderer.syncMasks(Array.from(this.sessionMap.keys()));
        }
    }

    // Feedback on the shared push card (src/toast.js), one card per burst:
    // someone who keeps swiping past the cap — or a drain that drops several
    // games in a row — must not be buried in cards.
    function throttledToast(key) {
        let lastAt = 0;
        return () => {
            const now = Date.now();
            if (now - lastAt < TOAST_COOLDOWN_MS) return;
            lastAt = now;
            const t = (k) => (window.ILAP && window.ILAP.t) ? window.ILAP.t(k) : k;
            window.ILAP.showToast(
                window.ILAP.Sanitizer.escapeHTML(t(key)), 5000);
        };
    }

    // Everything the IgnoreManager needs from the world outside it, in one
    // place: the queue store, name resolution, the login gate. Split out of the
    // App constructor, which had grown into wiring and composition at once —
    // this half is the wiring, and it is the half that changes when the queue
    // API does.
    //
    // MI DEFERS: a swipe paints the badge optimistically and enqueues the ignore
    // into the shared curator queue as a type:'mi' job; the drainer sends every
    // MI POST through the IgnoreGate, paced like EQ/DQ/curator — no ungated
    // instant POST, so the residual near-pair ban risk is gone (see
    // Store.enqueueMi for the job shape). Stats + the undo-log entry are written
    // by the drainer WHEN the POST lands, not here — a game is counted as
    // ignored only once it truly is.
    function buildAdapters() {
        // Resolved per call, never captured: src/curator/store.js is injected
        // AFTER this file (see the manifest's content_scripts order), and on the
        // readyState path in boot() — the Firefox case, where a document_idle
        // script can land after window.onload — the App is built before that
        // file has run at all. Holding a reference here would make every gesture
        // throw on exactly the platform the readyState guard exists for.
        const Store = () => window.ILAP.Curator.Store;
        return {
            enqueue: (appid, name, reason) => Store().enqueueMi({ appid, name, reason }),
            // The un-ignore twin job. No name and no reason: nothing about a
            // rollback is displayed or counted (Last Ignored and the ignore count
            // are deliberately left alone, exactly as the undo drain leaves them).
            enqueueUndo: (appid) => Store().enqueueMiUndo({ appid }),
            // …and its shortcut: if the ignore is still sitting in the queue,
            // take it back instead of queueing a rollback behind it.
            cancelIgnore: (appid) => Store().cancelMiEntry(appid),
            // A cancelled swipe stops being ignored the same way a rolled-back one
            // does, so it travels the same road: the silent 'undo' reason, and every
            // tab drops the badge off its own session map.
            signalUnignored: (appid) => Store().signalUnignored([appid], 'undo'),
            nameExtractor: { get: (appid, el) => window.ILAP.resolveGameName(appid, el) },
            // The logged-out gate. NOT the sessionid cookie: Steam gives one to
            // anonymous visitors too, so "there is a sessionid" was true for a
            // signed-out browser and every swipe painted a badge for an ignore
            // that could never land. The policy (signed-in header settles it for
            // free, anything else one cached /account/ probe) is SteamAuth's, and
            // the rate gate asks the very same question through it. Fails closed:
            // a probe that could not be made is not a session.
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
            const maskConfig = { isEnabled: () => this.configService.get().maskEnabled === true };
            const badgeRenderer = new MI.BadgeRenderer(strategies, detector, MI.BADGE_CLASSES, resourceService, maskConfig);

            // Not an MI outcome at all, but this content script is the only one
            // on every store page that owns a push card (the curator module
            // no-ops outside a curator page): an undo drain could not roll some
            // ignores back. Kept on the App, not the IgnoreManager — there is no
            // badge state to correct, only something to say.
            this.notifyUndoFailed = throttledToast('undo_failed');

            this.ignoreManager = new IgnoreManager(Object.assign(buildAdapters(), {
                badgeRenderer,
                containerStrategies: strategies,
                sessionState: sessionService
            }));

            this.eventParser = new MI.EventParser(this.configService);
            this.swipeDetector = new MI.SwipeGestureDetector(this.configService);
        }

        async init() {
            await this.configService.init();
            this.configService.listen();
            this.configService.onChange(() => {
                this.ignoreManager.refreshAll();
                this.ignoreManager.syncMasks();
            });

            this.setupInteractions();
            this.setupObserver();

            // Games stopped being ignored (undo drain confirmed, or deferred MI
            // POSTs were dropped) — ilap_unignored pulses the appid list. Clear
            // their badges in this tab if we badged them this session; the
            // pulse's reason decides whether the user also gets told.
            // ilap_undo_failed is the opposite report: a rollback that will
            // never land, so no badge changes — only the provisional marks come
            // off, and its own reason decides whether a card goes with them.
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local') return;
                const p = changes.ilap_unignored;
                // `appid` is the pre-list payload shape: an extension update
                // leaves already-open tabs running the OLD content script, whose
                // drainer still pulses one appid at a time. Accepting both costs
                // a fallback and spares those tabs a badge that lies until the
                // user reloads them.
                const pulsed = p && p.newValue
                    && (p.newValue.appids || (p.newValue.appid ? [p.newValue.appid] : null));
                if (pulsed) {
                    this.ignoreManager.handleUnignored(pulsed, p.newValue.reason);
                }
                const u = changes.ilap_undo_failed && changes.ilap_undo_failed.newValue;
                if (u) {
                    // Same pulse, two jobs: take the pending mark off the badges
                    // whose solo un-ignore just fell through, and — unless the
                    // user is the one who cancelled it — say so. 'removed' means
                    // they dropped the un-ignore job themselves, so the marks go
                    // and nothing is announced, exactly like the 'removed' arm of
                    // the un-badge pulse above.
                    this.ignoreManager.clearPending();
                    if (u.reason !== 'removed') this.notifyUndoFailed();
                }
            });

            this.ignoreManager.refreshAll();
        }

        setupInteractions() {
            document.body.addEventListener('click', (e) => {
                if (!e.isTrusted) return; // ignore only real user input, not page-synthesized clicks
                // A click that lands on a badge belongs to the badge listener
                // below, and to it alone: both sit on this node in capture phase,
                // so stopPropagation there cannot hold this one back, and a
                // modifier-click bound to the un-ignore would otherwise resolve
                // the same rollback twice from one event.
                if (e.target.closest('.ilap-ignored-overlay')) return;
                const intent = this.eventParser.parseClick(e);
                if (intent) {
                    e.preventDefault();
                    e.stopPropagation();
                    // The same modifier-click vocabulary now also carries the
                    // un-ignore binding; the parser says which action it resolved.
                    if (intent.action === 'unignore') {
                        this.ignoreManager.processUnignoreRequest(intent);
                    } else {
                        this.ignoreManager.processIgnoreRequest(intent);
                    }
                }
            }, true);

            this.swipeDetector.attach(document.body, (gestureData) => {
                // The same hand-off the click listener above makes, for the same
                // reason and one event later: a right-button gesture STARTED on a
                // badge ends in a contextmenu that the badge listener answers too,
                // and `stopPropagation` there cannot stop it — the two sit on this
                // node, and only stopImmediatePropagation reaches a sibling. So a
                // rollback gestured off a badge would resolve twice from one
                // motion. The badge wins, as everywhere else: it needs no binding
                // and no distance, and the gesture would only have said the same
                // thing.
                if (gestureData.startEl.closest
                    && gestureData.startEl.closest('.ilap-ignored-overlay')) return;
                const intent = this.eventParser.createIntent(gestureData.startEl, gestureData.reason);
                if (!intent) return;
                if (gestureData.action === 'unignore') {
                    this.ignoreManager.processUnignoreRequest(intent);
                } else {
                    this.ignoreManager.processIgnoreRequest(intent);
                }
            });

            // The un-ignore binding that is NOT rebindable: a click on the IGNORED
            // badge — either button — always rolls the game back, whatever the
            // un-ignore select says, including its "off". That option no longer
            // promises an off it can't deliver; it names this. It is the floor
            // under the setting: whatever the user did to their gestures, a badge
            // they didn't mean is always one click from gone, on the badge itself
            // and nowhere else. Costs the page nothing: the badge already
            // swallowed plain clicks so it could not navigate.
            //
            // Delegated rather than bound per badge because badges are created and
            // destroyed continuously — one listener outlives them all. Both
            // listeners stay behind the master toggle, like every other binding: a
            // disabled extension must queue nothing (the gate would refuse the
            // rollback forever and leave the badge dimmed for good) and swallow
            // nothing of the page's own menu.
            const onBadge = (e) => {
                if (!e.isTrusted) return;
                if (!this.configService.get().enabled) return;
                const badge = e.target.closest('.ilap-ignored-overlay');
                if (!badge || !badge.dataset.ilapAppid) return;
                e.preventDefault();
                e.stopPropagation();
                this.ignoreManager.processUnignoreRequest({ appid: badge.dataset.ilapAppid });
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

    // A document_idle content script may be injected as late as "immediately
    // after the window.onload event fires" — Firefox really does land on that
    // edge, Chrome practically never. A BARE 'load' listener registered after
    // the event has already fired never runs, and then this whole module is
    // dead: no boot render, no observer, no gesture listeners. Guard on
    // readyState, exactly like the widget and curator boots already do.
    const boot = () => {
        const defaultConfig = {
            defaultKey: 'swipeRight', platformKey: 'swipeLeft',
            unignoreKey: 'zigzag', enabled: true, maskEnabled: false
        };
        const configService = new window.ILAP.ManualIgnore.ConfigService(defaultConfig);
        new App(configService).init();
    };
    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot);

})();