// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    const TOAST_COOLDOWN_MS = 10000;

    class IgnoreManager {
        // Injected as a deps object, like the rest of the queue-era code
        // (UndoService, CuratorQueueDrainer, EnqueueService): the positional
        // list had grown to seven and a mis-ordered call site would have failed
        // silently rather than loudly.
        constructor(deps) {
            this.renderer = deps.badgeRenderer;
            this.strategies = deps.containerStrategies;
            this.enqueue = deps.enqueue;            // (appid, name, reason) => Promise<{ kind }>
            this.nameExtractor = deps.nameExtractor;
            this.session = deps.sessionState;
            this.sessionId = deps.sessionId;        // () => sessionid|null (logged-out gate)
            this.notifyQueueFull = deps.notifyQueueFull || null;  // () => void, throttled by the adapter
            this.notifyDropped = deps.notifyDropped || null;      // () => void, same contract

            this.sessionMap = new Map();
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

            // A logged-out swipe does nothing — parity with the old instant POST,
            // which failed with no sessionid cookie and painted no badge. Keeps
            // the optimistic badge honest: we never badge a swipe we can't ignore.
            if (this.sessionId && !this.sessionId()) return;

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
            this._saveSession();

            this.refreshBadgesForGame(appid);
        }

        // A game this tab badged is no longer ignored (ilap_unignored pulse) —
        // either an undo drain rolled it back, or its deferred MI POST never
        // landed. Drop it from the per-tab session map and un-render the badge,
        // so the page stops showing IGNORED for a game that isn't.
        //
        // `reason === 'failed'` is the second case, and it is the only one the
        // user hasn't asked for: from their side a swipe silently un-did itself
        // minutes later. Say so — but only in a tab that actually badged this
        // game (the sessionMap guard above), so the toast lands where the
        // gesture happened instead of in every open store tab.
        handleUnignored(appid, reason) {
            appid = String(appid);
            if (!this.sessionMap.has(appid)) return;   // only clear what THIS tab badged
            this.sessionMap.delete(appid);
            this._saveSession();
            this.renderer.unrender(appid);
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
        }

        syncMasks() {
            this.renderer.syncMasks(Array.from(this.sessionMap.keys()));
        }
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
            
            // Adapters
            // MI now DEFERS: a swipe paints the badge optimistically and enqueues
            // the ignore into the shared curator queue as a type:'mi' job; the
            // drainer sends every MI POST through the IgnoreGate, paced like
            // EQ/DQ/curator — no more ungated instant POST, so the residual
            // near-pair ban risk is gone (see Store.enqueueMi for the job shape).
            // Stats + the undo-log entry are written by the drainer WHEN the POST
            // lands, not here — a game is counted as ignored only once it truly is.
            const enqueue = (appid, name, reason) =>
                window.ILAP.Curator.Store.enqueueMi({ appid, name, reason });
            const nameExtractorAdapter = { get: (appid, el) => window.ILAP.resolveGameName(appid, el) };

            // Feedback on the shared push card (src/toast.js), one card per
            // burst: someone who keeps swiping past the cap — or a drain that
            // drops several games in a row — must not be buried in cards.
            const throttledToast = (key) => {
                let lastAt = 0;
                return () => {
                    const now = Date.now();
                    if (now - lastAt < TOAST_COOLDOWN_MS) return;
                    lastAt = now;
                    const t = (k) => (window.ILAP && window.ILAP.t) ? window.ILAP.t(k) : k;
                    window.ILAP.showToast(
                        window.ILAP.Sanitizer.escapeHTML(t(key)), 5000);
                };
            };
            // The swipe was refused outright (queue at MI_MAX)…
            const notifyQueueFull = throttledToast('mi_queue_stuck');
            // …and: the swipe was accepted, but its deferred POST never landed.
            const notifyDropped = throttledToast('mi_ignore_failed');

            this.ignoreManager = new IgnoreManager({
                badgeRenderer,
                containerStrategies: strategies,
                enqueue,
                nameExtractor: nameExtractorAdapter,
                sessionState: sessionService,
                sessionId: () => window.ILAP.getSessionID(),
                notifyQueueFull,
                notifyDropped
            });
            
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

            // A game stopped being ignored (undo drain confirmed, or a deferred
            // MI POST was dropped) — ilap_unignored pulses per appid. Clear that
            // game's badge in this tab if we badged it this session; the pulse's
            // reason decides whether the user also gets told.
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local') return;
                const p = changes.ilap_unignored;
                if (p && p.newValue && p.newValue.appid) {
                    this.ignoreManager.handleUnignored(p.newValue.appid, p.newValue.reason);
                }
            });

            this.ignoreManager.refreshAll();
        }

        setupInteractions() {
            document.body.addEventListener('click', (e) => {
                if (!e.isTrusted) return; // ignore only real user input, not page-synthesized clicks
                const intent = this.eventParser.parseClick(e);
                if (intent) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.ignoreManager.processIgnoreRequest(intent);
                }
            }, true);

            this.swipeDetector.attach(document.body, (gestureData) => {
                const intent = this.eventParser.createIntent(gestureData.startEl, gestureData.reason);
                if (intent) {
                    this.ignoreManager.processIgnoreRequest(intent);
                }
            });
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
        const defaultConfig = { defaultKey: 'swipeRight', platformKey: 'swipeLeft', enabled: true, maskEnabled: false };
        const configService = new window.ILAP.ManualIgnore.ConfigService(defaultConfig);
        new App(configService).init();
    };
    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot);

})();