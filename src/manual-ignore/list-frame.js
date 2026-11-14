// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.ManualIgnore = window.ILAP.ManualIgnore || {};

    // The Classic Discovery Queue's red IGNORED frame on the own page of a game
    // a list ignored, with what ignored it in the tooltip: a curator list, a
    // built-in list, a bundle, or the AI tab's HIGH level while browsing.
    // Steam's Ignore button decides: the frame shows while the page says the
    // game is ignored and goes as soon as it says otherwise. On a Classic
    // Discovery Queue page it outranks the Queue Helper's verdict on the same
    // button (explore-queue/ui.js). Loads after the Queue Helper's renderer and
    // the built-in lists' names (ui/popup_presets.js), and boots itself.

    const PRESET_PREFIX = 'preset_';
    const AI_PREFIX = 'ai_';
    const BUNDLE_RE = /^(bundle|sub)_(\d+)$/;
    const CURATOR_RE = /^\d+$/;
    // The kinds whose name is read from Steam when it is not stored.
    const FETCHED = new Set(['curator', 'bundle']);
    const TEXT = {
        curator: 'list_frame_curator',
        preset: 'list_frame_preset',
        bundle: 'list_frame_bundle',
        auto: 'list_frame_auto',
    };

    // The list a log entry names, or null for a hand or a queue helper (pure).
    function listOf(e) {
        const id = String(e.curatorId || '');
        if (id.indexOf(PRESET_PREFIX) === 0) return { kind: 'preset', key: id.slice(PRESET_PREFIX.length), ts: e.ts };
        if (BUNDLE_RE.test(id)) return { kind: 'bundle', id, ts: e.ts };
        if (CURATOR_RE.test(id)) return { kind: 'curator', id, ts: e.ts };
        return null;
    }

    // Why a game the page shows ignored is on the list, or null (pure,
    // unit-tested). `log` is IgnoreLog's, oldest -> newest. `covered` are the
    // lists run to their end that have the game (listsCovering): they skipped
    // it as already ignored, so the log has no entry of theirs. Of the game's
    // ignores since its last rollback:
    //   - the newest one a list made;
    //   - else a list that covers it, over a hand, a queue helper and a shot;
    //   - else a shot of the AI tab's HIGH level.
    // A rollback with no ignore of ours after it leaves no frame.
    function listReason(log, appid, covered) {
        const id = String(appid);
        const since = [];
        let rolledBack = false;
        for (let i = (log || []).length - 1; i >= 0; i--) {
            const e = log[i];
            if (!e || String(e.appid) !== id || e.skipped) continue;
            if (e.undoneAt) { rolledBack = true; break; }
            since.push(e);
        }
        for (const e of since) {
            const list = listOf(e);
            if (list) return list;
        }
        if (rolledBack && !since.length) return null;
        if (covered && covered.length) return covered[0];
        const shot = since.find(e => e.auto);
        return shot ? { kind: 'auto', ts: shot.ts } : null;
    }

    // The lists run to their end that have the game (pure, unit-tested): the
    // built-in lists done at the shipped version, less the games an AI list's
    // done mark kept out ('+t' translation, '+l' in game), then the finished
    // bundles. `data` = data/presets.json, `done` = { <key>: done mark },
    // `bundles` = ilap_ignored_bundles, `aiGames` = ILAP.aiGames.
    function listsCovering(appid, { data, done, bundles, aiGames }) {
        const id = String(appid);
        const has = (list) => Array.isArray(list) && list.some(a => String(a) === id);
        const out = [];
        const revs = (data && data.rev) || {};
        for (const key of Object.keys(revs)) {
            const mark = done[key];
            if (typeof mark !== 'string') continue;
            const [base, ...tags] = mark.split('+');
            if (base !== revs[key]) continue;
            const listed = key.indexOf(AI_PREFIX) === 0
                ? has((data.ai || {})[key.slice(AI_PREFIX.length)])
                    && aiGames(data, { translation: tags.includes('t'), ingame: tags.includes('l') }).has(Number(id))
                : has(data[key]);
            if (listed) out.push({ kind: 'preset', key });
        }
        for (const key of Object.keys(bundles || {})) {
            if (BUNDLE_RE.test(key) && has(bundles[key] && bundles[key].appids)) {
                out.push({ kind: 'bundle', id: key, ts: bundles[key].ts });
            }
        }
        return out;
    }

    // A storage change the frame of `appid` may follow (pure, unit-tested): a
    // log chunk whose entries for the game changed, a built-in list's done
    // mark, the finished bundles or the list names. A drain appends to the
    // chunk that has the game for a while, and those writes alone do not count.
    function concernsFrame(changes, appid) {
        const DoneMarks = window.ILAP.Curator.DoneMarks;
        const id = String(appid);
        const of = (v) => JSON.stringify((Array.isArray(v) ? v : []).filter(e => e && String(e.appid) === id));
        return Object.keys(changes).some((k) => {
            if (window.ILAP.IgnoreLog.isLogKey(k)) return of(changes[k].oldValue) !== of(changes[k].newValue);
            return k.indexOf(DoneMarks.PRESET_DONE_PREFIX) === 0
                || k === DoneMarks.IGNORED_BUNDLES_KEY || k === DoneMarks.LIST_NAMES_KEY;
        });
    }

    function get(keys) {
        return new Promise(resolve => chrome.storage.local.get(keys, resolve));
    }

    // listReason over the stored log, done marks and finished bundles.
    async function readListReason(appid) {
        const DoneMarks = window.ILAP.Curator.DoneMarks;
        const data = await window.ILAP.loadPresets();
        const keys = Object.keys(data.rev || {});
        const [log, res] = await Promise.all([
            window.ILAP.IgnoreLog.getLog(),
            get(keys.map(k => DoneMarks.PRESET_DONE_PREFIX + k).concat([DoneMarks.IGNORED_BUNDLES_KEY])),
        ]);
        const done = {};
        for (const k of keys) done[k] = res[DoneMarks.PRESET_DONE_PREFIX + k];
        const covered = listsCovering(appid, {
            data, done, bundles: res[DoneMarks.IGNORED_BUNDLES_KEY], aiGames: window.ILAP.aiGames,
        });
        return listReason(log, appid, covered);
    }

    // The list's name as the extension knows it, '' when it does not yet.
    async function knownListName(reason) {
        if (reason.kind === 'preset') return window.ILAP_Presets.label(reason.key);
        if (!FETCHED.has(reason.kind)) return '';
        const names = await window.ILAP.Curator.DoneMarks.listNames();
        return names[reason.id] ? names[reason.id].name : '';
    }

    // A curator's or a bundle's name read from Steam and stored, '' on a failure.
    async function fetchListName(reason) {
        let name = '';
        if (reason.kind === 'curator') {
            name = await window.ILAP.Creators.fetchName(reason.id);
        } else if (reason.kind === 'bundle') {
            const m = BUNDLE_RE.exec(reason.id);
            const bundle = await window.ILAP.ManualIgnore.fetchBundle({ kind: m[1], id: m[2] });
            name = bundle ? bundle.name : '';
        }
        if (name) await window.ILAP.Curator.DoneMarks.noteListName(reason.id, name);
        return name;
    }

    // Steam shows its "Ignored" button, and hides "Ignore", while the game is
    // on the account's ignore list.
    function shownIgnored(btn) {
        const active = btn.querySelector('.queue_btn_active');
        return !!active && getComputedStyle(active).display !== 'none';
    }

    // The panel's Serbian is the Latin one, and Intl's 'sr' is Cyrillic.
    const dateLocale = (lang) => (lang === 'sr' ? 'sr-Latn' : lang);

    // deps:
    //   isEnabled()       → the master switch
    //   button()          → Steam's Ignore button (#ignoreBtn) or null
    //   reason()          → Promise<reason | null> (readListReason)
    //   knownName(reason) → Promise<string> (knownListName)
    //   fetchName(reason) → Promise<string> (fetchListName)
    //   ui()              → the Queue Helper's renderer for the button (explore-queue/ui.js)
    //   t(key)            → the panel's words
    //   lang()            → the panel's language, for the date
    class ListFrame {
        constructor(deps) {
            for (const fn of ['isEnabled', 'button', 'reason', 'knownName', 'fetchName', 'ui', 't', 'lang']) {
                if (typeof deps[fn] !== 'function') throw new TypeError('[ILAP] ListFrame needs deps.' + fn);
            }
            this.d = deps;
            this.shown = false;
            this._seq = 0;
            this._observer = null;
        }

        // Steam flips its button between Ignore and Ignored in place, and the
        // frame follows. `onFlip` refreshes it.
        watch(onFlip) {
            const btn = this.d.button();
            if (!btn || this._observer) return;
            let ignored = shownIgnored(btn);
            this._observer = new MutationObserver(() => {
                const now = shownIgnored(btn);
                if (now === ignored) return;
                ignored = now;
                onFlip();
            });
            this._observer.observe(btn, { attributes: true, attributeFilter: ['style'], subtree: true });
        }

        async refresh() {
            const seq = ++this._seq;
            const btn = this.d.button();
            if (!btn || !this.d.isEnabled() || !shownIgnored(btn)) { this.hide(); return; }
            const reason = await this.d.reason();
            const known = reason ? await this.d.knownName(reason) : '';
            if (seq !== this._seq) return;
            if (!reason) { this.hide(); return; }
            this._draw(reason, known);
            if (known || !FETCHED.has(reason.kind)) return;
            const fetched = await this.d.fetchName(reason);
            if (fetched && seq === this._seq) this._draw(reason, fetched);
        }

        hide() {
            this._seq++;
            if (!this.shown) return;
            this.shown = false;
            this.d.ui().clearVisuals();
        }

        _draw(reason, name) {
            const date = reason.ts > 0
                ? new Date(reason.ts).toLocaleDateString(dateLocale(this.d.lang()), { dateStyle: 'medium' })
                : '';
            this.d.ui().applyVisuals('LIST', null, { text: this.d.t(TEXT[reason.kind]), name, date });
            this.shown = true;
        }
    }

    // On a game's own page with Steam's Ignore button (signed in). Nothing is
    // drawn before the master switch is read.
    function boot() {
        const page = /^\/app\/(\d+)/.exec(location.pathname);
        const button = () => document.getElementById('ignoreBtn');
        if (!page || !button()) return;
        const appid = page[1];
        const Explore = window.ILAP.Explore;
        const ui = new Explore.UI(new window.ILAP.ResourceService(), Explore.COLORS, button);
        let enabled = false;
        const frame = new ListFrame({
            isEnabled: () => enabled,
            button,
            reason: () => readListReason(appid),
            knownName: knownListName,
            fetchName: fetchListName,
            ui: () => ui,
            t: (key) => window.ILAP.t(key),
            lang: () => window.ILAP.i18n.getLang(),
        });
        const refresh = () => frame.refresh().catch((e) => console.warn('[ILAP] list frame failed:', e));
        window.ILAP.MasterSwitch.watch({
            onInit: (on) => {
                enabled = on;
                frame.watch(refresh);
                chrome.storage.onChanged.addListener((changes, area) => {
                    if (area === 'local' && concernsFrame(changes, appid)) refresh();
                });
                window.ILAP.i18n.onLangChange(() => { if (frame.shown) refresh(); });
                refresh();
            },
            onChange: (on) => { enabled = on; refresh(); },
        });
    }

    Object.assign(window.ILAP.ManualIgnore, {
        ListFrame, listReason, listsCovering, concernsFrame, readListReason, knownListName, fetchListName,
    });

    boot();
})();
