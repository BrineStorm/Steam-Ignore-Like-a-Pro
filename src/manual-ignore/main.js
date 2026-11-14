// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    const TOAST_COOLDOWN_MS = 10000;

    // How long a gesture on a greyed capsule waits for the gate before it
    // decides without Steam's reason (buildAdapters, steamReason). Past the
    // longest ordinary wait: the swipe marks the user active, so a curator
    // drain reserves at ACTIVE_GAP (3 s), and the read queues one GAP (650 ms)
    // behind it. Only a 429 penalty goes further.
    const STEAM_REASON_WAIT_MS = 4000;

    // true once the menu-at-press hint has been shown (App._hintMenuAtPress).
    const PRESS_MENU_HINT_KEY = 'ilap_press_menu_hint';

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
            spare: (appid) => window.ILAP.ManualIgnore.AiSpared.add(appid),
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

    // What the AI tab's level reads (App._loadAiOptions). Asked at boot, not
    // at load: the unit suite loads this file with no Settings behind it.
    const aiOptionKeys = () => {
        const K = window.ILAP.Settings.KEYS;
        return [K.AI_LEVEL, K.AI_SHOT, K.AI_SHOT_EMOJI, K.AI_SHOT_ANIM, K.AI_KEEP_TRANSLATION, K.AI_KEEP_INGAME,
            K.AI_NOTE_COLLAPSED];
    };

    class App {
        constructor(configService) {
            this.configService = configService;

            const MI = window.ILAP.ManualIgnore;

            // Shared Infrastructure
            const sessionService = new window.ILAP.SessionStateService();
            const resourceService = new window.ILAP.ResourceService();

            // UI Dependencies
            const strategies = new MI.ContainerStrategyProvider(MI.CONTAINER_STRATEGIES);
            const detector = new MI.DuplicateDetector(MI.ContextScanner);
            const maskConfig = { isEnabled: () => this.configService.get().maskEnabled };
            const tips = new MI.FloatTip(resourceService);
            const aiMarks = new MI.AiMarks(strategies, tips);
            const badgeRenderer = new MI.BadgeRenderer({
                strategies, detector, classes: MI.BADGE_CLASSES, resources: resourceService, maskConfig, aiMarks,
            });

            // Not an MI outcome, but this is the one content script with a push card
            // on every store page. No badge to correct, so not the manager's.
            this.notifyUndoFailed = throttledToast('undo_failed');

            const adapters = buildAdapters();
            this.ignoreManager = new MI.IgnoreManager(Object.assign({}, adapters, {
                badgeRenderer,
                containerStrategies: strategies,
                badgeMarks: new MI.BadgeMarks(sessionService),
                tintMarks: new MI.TintMarks(new MI.SteamFlagTint(tips)),
                bundleMarks: new MI.BundleMarks(badgeRenderer),
                isEnabled: () => this.configService.get().enabled
            }));

            // The AI tab's level, and the shot each game it queues gets.
            const aiGames = (keep) => window.ILAP.loadPresets().then(data => window.ILAP.aiGames(data, keep));
            const aiKinds = () => window.ILAP.loadPresets().then(data => window.ILAP.aiKinds(data));
            this.shots = new MI.ShotCounter(window.ILAP.Settings.KEYS.AI_SHOT_COUNT);
            this.ai = MI.wireAiBrowsing({
                settings: window.ILAP.Settings,
                ShotAnimator: MI.ShotAnimator,
                strategies,
                marks: this.ignoreManager,
                tags: {
                    tag: (link, appid, blur, kind, flag) => aiMarks.tag(link, appid, blur, kind, flag),
                    untag: () => aiMarks.untag(),
                },
                isEnabled: () => this.configService.get().enabled,
                isLoggedIn: adapters.isLoggedIn,
                aiGames,
                aiKinds,
                // Paced in the ignores' stream, like the swipe's reason read.
                readAccount: async () => {
                    await window.ILAP.IgnoreGate.paceRead();
                    return window.ILAP.fetchIgnoredAppsStrict();
                },
                // The games it leaves unshot: un-ignored by hand, refused by Steam
                // lately (the drainer's DoneMarks.markAiRefused), and the ignores
                // an account read made at `readAt` cannot show: a swipe still
                // queued in any tab, or an ignore the log has from about then on.
                readSpared: async (readAt) => {
                    const since = readAt - window.ILAP.SteamNet.USERDATA_LAG_MS;
                    const [hand, refused, swiped, logged] = await Promise.all([
                        MI.AiSpared.read(), window.ILAP.Curator.DoneMarks.aiRefusedNow(),
                        window.ILAP.Curator.Store.waitingSwipes(), window.ILAP.IgnoreLog.ignoredSince(since)]);
                    return {
                        hand: new Set(hand),
                        refused: new Set(Array.from(refused, String)),
                        own: new Set([...swiped, ...logged]),
                    };
                },
                nameOf: (appid, el) => window.ILAP.getGameName(appid, el),
                enqueue: (entries) => window.ILAP.Curator.Store.enqueueMiMany(entries),
                countShot: () => this.shots.next(),
                requestScan: () => this._scanAi(),
            });

            // The AI note on a game's own page (ai-page.js): the flag, the
            // developers' words and the way down to Steam's block. Store game
            // pages only; the Classic Discovery Queue's are game pages too.
            const pageApp = /^\/app\/(\d+)/.exec(location.pathname);
            this.aiNote = pageApp ? new MI.AiPageNote({
                pageAppid: pageApp[1],
                isEnabled: () => this.configService.get().enabled,
                aiGames,
                aiKinds,
                disclosure: () => window.ILAP.AiDisclosure.fromPage(document),
                rules: window.ILAP.AiDisclosure,
                nameOf: () => window.ILAP.getGameName(pageApp[1], document.querySelector('.page_content_ctn') || document.body),
                place: () => MI.aiNotePlace(document),
                header: () => MI.aiNoteHeader(document),
                fit: MI.aiNoteFit,
                // Nothing waits on it: a page left behind by an update keeps its fold.
                setCollapsed: (on) => {
                    try {
                        chrome.storage.local.set({ [window.ILAP.Settings.KEYS.AI_NOTE_COLLAPSED]: on },
                            () => void chrome.runtime.lastError);
                    } catch (e) { /* no storage left in this tab */ }
                },
                label: MI.aiFlagWords,
                t: (key, params) => window.ILAP.t(key, params),
                lang: () => window.ILAP.i18n.getLang(),
                reduceMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
            }) : null;
            if (this.aiNote) {
                // The note's flag and buttons explain themselves on hover.
                tips.watch();
                // Steam's column moves with the window, and with it the
                // lines the note can quote.
                let frame = 0;
                window.addEventListener('resize', () => {
                    if (frame) return;
                    frame = requestAnimationFrame(() => { frame = 0; this.aiNote.refit(); });
                });
            }

            // The flags and the note speak the panel's language, which the
            // stored choice sets after the first marks may be on the page.
            window.ILAP.i18n.onLangChange(() => {
                aiMarks.relabel();
                if (this.aiNote) this.aiNote.relabel();
            });

            // A gesture on a bundle capsule: no badge, a card instead (bundle.js).
            const Store = window.ILAP.Curator.Store;
            this.bundles = new MI.BundleRequests({
                read: (ref) => MI.fetchBundle(ref),
                // Its name, for the frame on the pages of the games it ignores.
                stage: async (spec) => {
                    const outcome = await Store.stageBundle(spec);
                    if (outcome.kind === 'added' || outcome.kind === 'merged') {
                        await window.ILAP.Curator.DoneMarks.noteListName(spec.kind + '_' + spec.id, spec.name);
                    }
                    return outcome;
                },
                // Already ignored as a whole: a swipe on it changes nothing.
                isDone: (key) => this.ignoreManager.isBundleMarked(key),
                isLoggedIn: async () => (await window.ILAP.SteamAuth.hasLiveSession()) === true,
                // showToast escapes; the text is plain.
                toast: (key, params) => window.ILAP.showToast(window.ILAP.t(key, params), 6000),
            });

            // Steam's creator ignore on creator links (creators-ui.js).
            const Creators = window.ILAP.Creators;
            this.creators = new MI.CreatorControl({
                read: () => Creators.readState(Store),
                effective: (mirror, job, cursor) => Creators.effective(mirror, job, cursor),
                creatorPath: MI.creatorPath,
                linkSelector: MI.CREATOR_LINK,
                enqueue: (spec) => Store.enqueueCreator(spec),
                fetchClanId: (href) => Creators.fetchClanId(href),
                fetchAppCreators: (appid) => Creators.fetchAppCreators(appid, MI.storeCountry()),
                isLoggedIn: async () => (await window.ILAP.SteamAuth.hasLiveSession()) === true,
                isSignedIn: () => window.ILAP.SteamAuth.resolveLogin(),
                isEnabled: () => this.configService.get().enabled,
                toast: (key, params) => window.ILAP.showToast(window.ILAP.t(key, params), 6000),
                t: (key) => window.ILAP.t(key),
                iconUrl: chrome.runtime.getURL('assets/icons/icon48.png'),
            });
            this.notifyCreatorFailed = throttledToast('creator_failed');

            this.eventParser = new MI.EventParser(this.configService);
            this.swipeDetector = new MI.SwipeGestureDetector(this.configService);
        }

        async init() {
            await this.configService.init();
            this.configService.listen();
            this.configService.onChange((config) => {
                // The master toggle rides this same change feed: off strips the
                // page clean, on repaints from the session map.
                this.creators.paint();
                if (!config.enabled) {
                    this.ignoreManager.hideBadges();
                    this.ai.untag();
                    if (this.aiNote) this.aiNote.hide();
                    return;
                }
                this.ignoreManager.refreshAll();
                this.ignoreManager.syncMasks();
                this.creators.resume().catch((e) => console.warn('[ILAP] creator read failed:', e));
                this._scanAi();
                this._refreshAiNote();
            });

            this.setupInteractions();
            this.setupObserver();

            this._applyBundleMarks(await window.ILAP.Curator.DoneMarks.getBundleMarks());
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === 'local') this._onStorage(changes);
            });

            this.ignoreManager.refreshAll();
            this._loadAiOptions();
            this.shots.load();
            // The games un-ignored by hand, the only ones High flags: known
            // from the start, so a scan with nothing to shoot flags them too.
            window.ILAP.ManualIgnore.AiSpared.read().then((list) => {
                this.ai.browse.spared(list);
                this._scanAi();
            }).catch(() => { /* the scans read it again */ });
            this.creators.boot(location.pathname)
                .catch((e) => console.warn('[ILAP] creator links did not start:', e));
        }

        _applyBundleMarks(marks) {
            this.ignoreManager.setBundleMarks(Object.keys(marks || {}));
        }

        // Each key this script follows, and who it goes to. ilap_unignored: badges
        // to drop. ilap_undo_failed: a rollback that will not land, so only the
        // pending marks come off. Each pulse's reason decides whether a card goes
        // with it.
        _onStorage(changes) {
            const Store = window.ILAP.Curator.Store;
            const b = changes[window.ILAP.Curator.DoneMarks.IGNORED_BUNDLES_KEY];
            if (b) this._applyBundleMarks(b.newValue);
            const p = changes[Store.UNIGNORE_PULSE_KEY];
            const pulsed = p && p.newValue && p.newValue.appids;
            if (pulsed) {
                this.ignoreManager.handleUnignored(pulsed, p.newValue.reason);
                // A shot still in flight lands with no badge.
                this.ai.browse.dropped(pulsed);
            }
            // A game un-ignored by hand takes its AI flag at High once its
            // badge is off, so a scan follows the pulse too.
            const spared = changes[window.ILAP.ManualIgnore.AiSpared.KEY];
            if (spared) this.ai.browse.spared(spared.newValue);
            if (spared || pulsed) this._scanAi();
            if (aiOptionKeys().some(k => changes[k])) this._loadAiOptions();
            const shotCount = changes[window.ILAP.Settings.KEYS.AI_SHOT_COUNT];
            if (shotCount) this.shots.see(shotCount.newValue);
            // The creator mirror, or the creator job and its cursor.
            if (changes[window.ILAP.Creators.MIRROR_KEY] || changes[Store.QUEUE_KEY]
                || changes[Store.CURSOR_PREFIX + Store.CREATOR_JOB_ID]) this._refreshCreators();
            if (changes[window.ILAP.Creators.FAILED_KEY]) this.notifyCreatorFailed();
            const u = changes[Store.UNDO_FAILED_KEY] && changes[Store.UNDO_FAILED_KEY].newValue;
            if (u) {
                // 'removed': the user dropped the job, so nothing is said.
                this.ignoreManager.clearPending();
                if (u.reason !== 'removed') this.notifyUndoFailed();
            }
        }

        // Fire-and-forget, like a gesture (_dispatch).
        _refreshCreators() {
            this.creators.refresh().catch((e) => console.warn('[ILAP] creator refresh failed:', e));
        }

        // The level, its shot and the AI tab's boxes, read whole on any
        // change of one, then a scan.
        _loadAiOptions() {
            const { KEYS: K, normalizeShot, normalizeShotEmoji, normalizeAiLevel, isOn } = window.ILAP.Settings;
            chrome.storage.local.get(aiOptionKeys(), (d) => {
                if (chrome.runtime.lastError) return;
                this.ai.setShot(normalizeShot(d[K.AI_SHOT]));
                this.ai.setEmoji(normalizeShotEmoji(d[K.AI_SHOT_EMOJI]));
                this.ai.setAnim(isOn(d[K.AI_SHOT_ANIM]));
                const options = {
                    level: normalizeAiLevel(d[K.AI_LEVEL]),
                    keep: { translation: d[K.AI_KEEP_TRANSLATION], ingame: d[K.AI_KEEP_INGAME] },
                    collapsed: d[K.AI_NOTE_COLLAPSED] === true,
                };
                // The AI flags take the level's colour from here (styles.css).
                document.documentElement.dataset.ilapAiLevel = String(options.level);
                this.ai.browse.setOptions(options);
                if (this.aiNote) this.aiNote.setOptions(options);
                this._scanAi();
                this._refreshAiNote();
            });
        }

        // Fire-and-forget, like a gesture (_dispatch).
        _scanAi() {
            this.ai.browse.scan().catch((e) => console.warn('[ILAP] AI browsing scan failed:', e));
        }

        _refreshAiNote() {
            if (!this.aiNote) return;
            this.aiNote.refresh().catch((e) => console.warn('[ILAP] AI note failed:', e));
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
                chrome.storage.local.set({ [PRESS_MENU_HINT_KEY]: true }, () => void chrome.runtime.lastError);
                window.ILAP.showToast(window.ILAP.t('press_menu_hint'), 12000);
            });
        }

        // Both paths are fire-and-forget: a gesture is not awaited by anything.
        // A storage write that rejects — in practice an extension update, which
        // leaves this page's script running with no storage behind it — would
        // otherwise leave an unhandled rejection per swipe.
        _dispatch(intent, action) {
            // A creator's link: Steam's creator ignore, either way.
            if (intent.creator) {
                this.creators.request({ link: intent.linkElement, ignore: action !== 'unignore' })
                    .catch((e) => console.warn('[ILAP] creator gesture failed:', e));
                return;
            }
            // A bundle has nothing of ours to un-ignore: only an ignore gesture counts.
            if (intent.bundle) {
                if (action === 'unignore') return;
                this.bundles.request(intent).catch((e) => console.warn('[ILAP] bundle gesture failed:', e));
                return;
            }
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
                // A bundle's badge ('bundle_<id>') has nothing to un-ignore: its
                // click and its menu go to the capsule's link.
                if (!badge || !/^\d+$/.test(badge.dataset.ilapAppid || '')) return;
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
                    timeout = setTimeout(() => {
                        this.ignoreManager.refreshAll();
                        this.creators.paint();
                        this._scanAi();
                    }, 200);
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