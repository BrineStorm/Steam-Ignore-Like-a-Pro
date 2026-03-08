(function() {
    'use strict';

    // === BUSINESS LOGIC ===

    class IgnoreManager {
        /**
         * @param {Object} badgeRenderer 
         * @param {Object} containerStrategies 
         * @param {Object} apiAdapter - Interface { ignore(appid, reason) }
         * @param {Object} nameExtractor - Interface { get(appid, contextEl) }
         * @param {Object} statsAdapter - Interface { save(name, source) }
         */
        constructor(badgeRenderer, containerStrategies, apiAdapter, nameExtractor, statsAdapter) {
            this.renderer = badgeRenderer;
            this.strategies = containerStrategies;
            this.api = apiAdapter;
            this.nameExtractor = nameExtractor;
            this.stats = statsAdapter;
            
            this.sessionIgnored = new Set();
            this._loadSession();
        }

        _loadSession() {
            try {
                const key = 'ilap_session_ignored_games';
                const stored = sessionStorage.getItem(key);
                if (stored) this.sessionIgnored = new Set(JSON.parse(stored));
            } catch (e) { /* ignore */ }
        }

        _saveSession() {
            try {
                const key = 'ilap_session_ignored_games';
                sessionStorage.setItem(key, JSON.stringify([...this.sessionIgnored]));
            } catch(e) { /* ignore */ }
        }

        async processIgnoreRequest(intent) {
            const { appid, reason, linkElement } = intent;

            if (this.sessionIgnored.has(appid)) return;

            // Injected API call
            const success = await this.api.ignore(appid, reason);

            if (success) {
                this.sessionIgnored.add(appid);
                this._saveSession();

                const containerObj = this.strategies.findContainer(linkElement);
                const contextEl = containerObj ? containerObj.element : linkElement;

                // Injected Dependencies
                const name = this.nameExtractor.get(appid, contextEl);
                const source = reason === 0 ? "Default Ignore" : "Played Elsewhere";
                this.stats.save(name, source);

                this.refreshBadgesForGame(appid);
            }
        }

        refreshBadgesForGame(appid) {
            const candidates = document.querySelectorAll(`a[href*="/app/${appid}"]`);
            candidates.forEach(link => {
                if (!new RegExp(`/app/${appid}(/|\\?|$)`).test(link.getAttribute('href'))) return;
                this.renderer.render(link, appid);
            });
        }

        refreshAll() {
            this.sessionIgnored.forEach(appid => this.refreshBadgesForGame(appid));
        }
    }

    // === COMPOSITION ROOT ===

    class App {
        constructor(configService) {
            this.configService = configService;
            
            // UI Dependencies
            const strategies = new window.ILAP.ManualIgnore.ContainerStrategyProvider();
            const detector = new window.ILAP.ManualIgnore.DuplicateDetector(); 
            const badgeRenderer = new window.ILAP.ManualIgnore.BadgeRenderer(strategies, detector); 
            
            // Adapters
            const apiAdapter = { ignore: (appid, reason) => window.ILAP.apiIgnoreGame(appid, reason) };
            const nameExtractorAdapter = { get: (appid, el) => window.ILAP.getGameName(appid, el) };
            const statsAdapter = { save: (name, source) => window.ILAP.saveStats(name, source) };

            // Logic Dependencies
            this.ignoreManager = new IgnoreManager(
                badgeRenderer, 
                strategies, 
                apiAdapter, 
                nameExtractorAdapter, 
                statsAdapter
            );
            
            this.eventParser = new window.ILAP.ManualIgnore.EventParser(this.configService);
        }

        async init() {
            await this.configService.init();
            this.configService.listen();
            this.configService.onChange(() => this.ignoreManager.refreshAll());

            this.setupInteractions();
            this.setupObserver();
            
            this.ignoreManager.refreshAll();
        }

        setupInteractions() {
            document.body.addEventListener('click', (e) => {
                const intent = this.eventParser.parse(e);
                if (intent) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.ignoreManager.processIgnoreRequest(intent);
                }
            }, true);
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

    // Bootstrap
    window.addEventListener('load', () => {
        const defaultConfig = { defaultKey: 'ctrlKey', platformKey: 'off', enabled: true };
        const configService = new window.ILAP.ManualIgnore.ConfigService(defaultConfig);
        new App(configService).init();
    });

})();