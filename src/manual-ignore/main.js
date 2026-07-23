// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    class IgnoreManager {
        constructor(badgeRenderer, containerStrategies, apiAdapter, nameExtractor, statsAdapter, sessionState) {
            this.renderer = badgeRenderer;
            this.strategies = containerStrategies;
            this.api = apiAdapter;
            this.nameExtractor = nameExtractor;
            this.stats = statsAdapter;
            this.session = sessionState;
            
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
            const { appid, reason } = intent;

            if (this.sessionMap.has(appid)) return;

            const res = await this.api.ignore(appid, reason);
            if (res && res.ok) this._onIgnoreSuccess(intent);
        }

        _onIgnoreSuccess(intent) {
            const { appid, reason, linkElement } = intent;

            this.sessionMap.set(appid, reason);
            this._saveSession();

            const containerObj = this.strategies.findContainer(linkElement);
            const contextEl = containerObj ? containerObj.element : linkElement;

            const source = reason === 0 ? "Default Ignore" : "Played Elsewhere";
            // get() may resolve asynchronously (appdetails fallback when the DOM
            // carries no name — e.g. the front-page release-calendar carousel);
            // its DOM pass still runs synchronously, before the badge below
            // mutates the container. Badges must not wait on a network fetch.
            Promise.resolve(this.nameExtractor.get(appid, contextEl))
                .then(name => this.stats.save(name, source, appid));

            this.refreshBadgesForGame(appid);
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
            // MI is ungated (a swipe must fire instantly) but marks the ignore in
            // the gate: the background drainer yields to manual swipes, and gated
            // EQ/DQ/drainer space out AFTER this POST rather than landing flush
            // against it (see IgnoreGate.noteManualIgnore). Called after the
            // session-dedupe, so it never runs on a no-op.
            const apiAdapter = { ignore: (appid, reason) => {
                if (window.ILAP.IgnoreGate && window.ILAP.IgnoreGate.noteManualIgnore) {
                    window.ILAP.IgnoreGate.noteManualIgnore();
                }
                return window.ILAP.apiIgnoreGame(appid, reason);
            } };
            const nameExtractorAdapter = { get: (appid, el) => window.ILAP.resolveGameName(appid, el) };
            // Stats + the undo log ride one adapter call: the appid lands in
            // ilap_ignore_log so a manual ignore is undoable like every other.
            // The log is optional, same stance as the drainer's log hooks: a
            // partial build must degrade to stats-only, not throw mid-ignore.
            const statsAdapter = { save: (name, source, appid) => {
                window.ILAP.saveStats(name, source);
                if (window.ILAP.IgnoreLog) window.ILAP.IgnoreLog.append({ appid, name, source: 'mi' });
            } };

            this.ignoreManager = new IgnoreManager(
                badgeRenderer, 
                strategies, 
                apiAdapter, 
                nameExtractorAdapter, 
                statsAdapter,
                sessionService
            );
            
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

    window.addEventListener('load', () => {
        const defaultConfig = { defaultKey: 'swipeRight', platformKey: 'swipeLeft', enabled: true, maskEnabled: false };
        const configService = new window.ILAP.ManualIgnore.ConfigService(defaultConfig);
        new App(configService).init();
    });

})();