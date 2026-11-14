// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.ManualIgnore = window.ILAP.ManualIgnore || {};

    // The three kinds of mark a tab paints for its gestures, each the model of
    // one kind (ignore-manager.js IgnoreManager drives them):
    //   BadgeMarks  the games this tab badged IGNORED, kept across reloads
    //   TintMarks   greyed capsules, whose mark is Steam's own flag, tinted
    //   BundleMarks finished bundles, badged under their key

    const SESSION_KEY = 'ilap_session_map_v2';

    // Each collaborator is checked as the model is built: a missing one would
    // fail at the first gesture, or, for BadgeMarks' storage, never (its reads
    // and writes swallow every error).
    function need(cls, what, dep, fns) {
        if (!dep || !fns.every(fn => typeof dep[fn] === 'function')) {
            throw new TypeError(`[ILAP] ${cls} needs ${what}`);
        }
    }
    // A finished bundle's key, and the links its capsules use (bundle.js).
    const BUNDLE_KEY_RE = /^(bundle|sub)_\d+$/;
    const BUNDLE_LINKS = 'a[href*="/bundle/"], a[href*="/sub/"]';

    // The games this tab badged: the reason each was queued with, when this tab
    // queued it, and whether the browsing switch did (its badge says AI). When
    // is the cooldown, and what a cancel asks the queue for: an entry queued by
    // then contains this tab's swipe, a later one is somebody else's.
    // Persisted in the page's sessionStorage (`session`: get/set), rows
    // [appid, reason, ts?, auto?]. A change is written by `save()`, once per batch.
    class BadgeMarks {
        constructor(session) {
            need('BadgeMarks', 'session', session, ['get', 'set']);
            this.session = session;
            this.reasons = new Map();
            this.times = new Map();
            this.auto = new Set();
            this._load();
        }

        _load() {
            try {
                const stored = this.session.get(SESSION_KEY);
                if (!stored) return;
                // sessionStorage is the Steam page's origin, so this is untrusted
                // input, not our own state read back. These appids go straight
                // into querySelectorAll and new RegExp (IgnoreManager
                // refreshBadgesForGame, ui.js render/unrender/syncMasks), where a
                // `"` or a `(` is not a wrong badge but a thrown DOMException
                // that kills the whole badge pass. A digit string is the only
                // thing this tab ever wrote (EventParser takes it from an /app/
                // href match).
                const rows = JSON.parse(stored)
                    .filter(([appid]) => typeof appid === 'string' && /^\d+$/.test(appid));
                // A swipe time from the future is no time of ours: it would hold
                // the cooldown shut for good and let a cancel claim another tab's
                // entry. Without one the cancel errs safe (a real rollback).
                const now = Date.now();
                for (const [appid, reason, ts, auto] of rows) {
                    this.reasons.set(appid, reason);
                    if (Number.isFinite(ts) && ts <= now) this.times.set(appid, ts);
                    if (auto === 1) this.auto.add(appid);
                }
            } catch (e) { /* ignore */ }
        }

        save() {
            try {
                this.session.set(SESSION_KEY, JSON.stringify(Array.from(this.reasons, ([appid, reason]) => {
                    const row = [appid, reason, this.times.get(appid)];
                    if (this.auto.has(appid)) row.push(1);
                    return row;
                })));
            } catch (e) { /* ignore */ }
        }

        has(appid) { return this.reasons.has(appid); }
        reason(appid) { return this.reasons.get(appid) || 0; }
        queuedAt(appid) { return this.times.get(appid); }
        isAuto(appid) { return this.auto.has(appid); }
        get size() { return this.reasons.size; }
        appids() { return Array.from(this.reasons.keys()); }

        add(appid, reason, ts, auto) {
            this.reasons.set(appid, reason);
            this.times.set(appid, ts);
            if (auto) this.auto.add(appid);
            else this.auto.delete(appid);
        }

        // True when the game was badged here.
        delete(appid) {
            this.times.delete(appid);
            this.auto.delete(appid);
            return this.reasons.delete(appid);
        }
    }

    // A gesture on a capsule Steam already greys out (the game is on the
    // account's list) sets its reason, and Steam's flag takes the gesture's
    // colour instead of a badge of ours: such games stay out of BadgeMarks (no
    // badge click, no solo un-ignore). appid -> the reason queued.
    // Also the games un-ignored since this page loaded, in any tab (the
    // ilap_unignored pulse, reason 'undo'): Steam keeps its grey on them until
    // a reload, so its `ds_ignored` is stale for exactly these.
    // `renderer`: SteamFlagTint (ui.js), steamGreyed / tintSteamFlag / untintSteamFlag.
    class TintMarks {
        constructor(renderer) {
            need('TintMarks', 'renderer', renderer, ['steamGreyed', 'tintSteamFlag', 'untintSteamFlag']);
            this.renderer = renderer;
            this.reasons = new Map();
            this.unignored = new Set();
        }

        has(appid) { return this.reasons.has(appid); }
        reason(appid) { return this.reasons.get(appid); }
        get size() { return this.reasons.size; }

        // Steam's grey on the capsule, unless it is stale: the flag element, or null.
        greyed(link, appid) {
            return this.unignored.has(appid) ? null : this.renderer.steamGreyed(link);
        }

        // Anything that says the game is on Steam's list, or was, on this page.
        claims(link, appid) {
            return this.reasons.has(appid) || this.unignored.has(appid) || !!this.renderer.steamGreyed(link);
        }

        set(appid, reason) { this.reasons.set(appid, reason); }

        // True when the game had a tint, now gone.
        clear(appid) {
            if (!this.reasons.delete(appid)) return false;
            this.renderer.untintSteamFlag(appid);
            return true;
        }

        noteUnignored(appid) { this.unignored.add(appid); }

        // The tint on one link's flag, when the game has one and Steam greys it.
        paint(link, appid) {
            if (!this.reasons.has(appid)) return;
            const flag = this.renderer.steamGreyed(link);
            if (flag) this.renderer.tintSteamFlag(flag, appid, this.reasons.get(appid));
        }

        // Master off: the flags back to Steam's own colour. The model stays.
        hide() {
            for (const appid of this.reasons.keys()) this.renderer.untintSteamFlag(appid);
        }
    }

    // Bundles whose ignore job ran to its end ('<bundle|sub>_<id>', from
    // ilap_ignored_bundles): their capsules have the IGNORED badge too.
    // `renderer`: BadgeRenderer's render / unrender.
    class BundleMarks {
        constructor(renderer) {
            need('BundleMarks', 'renderer', renderer, ['render', 'unrender']);
            this.renderer = renderer;
            this.keys = new Set();
        }

        has(key) { return this.keys.has(key); }
        get size() { return this.keys.size; }
        list() { return Array.from(this.keys); }

        // The finished bundles, as stored. A mark that went (a rollback of one of
        // its games) takes its badges with it.
        set(keys) {
            const next = new Set((keys || []).filter(k => BUNDLE_KEY_RE.test(k)));
            for (const key of this.keys) if (!next.has(key)) this.renderer.unrender(key);
            this.keys = next;
        }

        // A finished bundle's capsules, badged under its key in place of an appid.
        // Only a link with art in it, as only such a link takes the gesture
        // (gestures.js _bundleIntent).
        paint(root) {
            if (!this.keys.size) return;
            for (const link of root.querySelectorAll(BUNDLE_LINKS)) {
                if (!link.querySelector || !link.querySelector('img, video')) continue;
                const m = (link.getAttribute('href') || '').match(/\/(bundle|sub)\/(\d+)([/?#]|$)/);
                if (!m) continue;
                const key = m[1] + '_' + m[2];
                if (this.keys.has(key)) this.renderer.render(link, key, 0);
            }
        }

        hide() {
            for (const key of this.keys) this.renderer.unrender(key);
        }
    }

    Object.assign(window.ILAP.ManualIgnore, { BadgeMarks, TintMarks, BundleMarks, SESSION_KEY });
})();
