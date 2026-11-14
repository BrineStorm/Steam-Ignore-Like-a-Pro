// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The AI tab's marks on capsules: the flag of an AI game, its blurred cover,
    // and the crossed mark of one the HIGH level ignored (ai-browse.js says which
    // games, ui.js draws the badge beside the crossed mark).

    window.ILAP = window.ILAP || {};
    window.ILAP.ManualIgnore = window.ILAP.ManualIgnore || {};

    const { fadeOut, sharpen, sizeToCapsule, ensurePositioning, applyBlur } = window.ILAP.ManualIgnore.MarkDom;

    // How long the AI marks wait after untag for a scan to keep them.
    const AI_SWEEP_MS = 250;
    const AI_BLURS = '.ilap-ai-blur, :scope > .ilap-blur-backdrop[data-ilap-ai-blur]';
    // The AI tab's flag of a game (AiMarks.tag), by its layer. The game page's
    // note (ai-page.js) uses the same classes on its own elements and marks
    // them `data-ilap-note`: those are the note's, and every selector here leaves them.
    const flagSel = (appid) => `.ilap-ai-flagbox[data-ilap-appid="${appid}"]:not([data-ilap-note])`;
    const crossSel = (appid) => `.ilap-ai-tag-ignored[data-ilap-appid="${appid}"]`;
    // Which of two places keeps a row's one flag: Steam's own flag holder (the
    // capsule, [data-ds-appid]) over any other link of the game (a curator
    // review's text link is wider than its capsule), then the larger.
    const area = (el) => { const r = el && el.getBoundingClientRect(); return r ? r.width * r.height : 0; };
    const holds = (el) => !!(el && el.matches && el.matches('[data-ds-appid]'));
    const outranks = (a, b) => (holds(a) !== holds(b) ? holds(a) : area(a) > area(b));
    // A flag's kind of AI use, and its words in the panel's language: AI, and
    // the kind when the lists know it. The capsules' flag and the game page's
    // note (ai-page.js) both say it so. A game marked by hand ('manual') reads
    // AI like any other, and only its page note says how it was found.
    const aiFlagKind = (kind) => (kind === 'translation' || kind === 'ingame' ? kind : 'ai');
    function aiFlagWords(kind) {
        const k = aiFlagKind(kind);
        if (k === 'ai') return 'AI';
        return `AI · ${window.ILAP.t(k === 'translation' ? 'ai_flag_translation' : 'ai_flag_ingame')}`;
    }

    class AiMarks {
        // `strategies`: where a link's capsule is (containers.js).
        // `tips`: the hover tip of the crossed mark (FloatTip, ui.js).
        constructor(strategies, tips) {
            if (!strategies || typeof strategies.findContainer !== 'function' || typeof strategies.coverOf !== 'function') {
                throw new TypeError('[ILAP] AiMarks needs strategies');
            }
            if (!tips || typeof tips.watch !== 'function') throw new TypeError('[ILAP] AiMarks needs tips');
            this.strategies = strategies;
            this.tips = tips;
            this._games = null;   // _gamesIn, for one run
        }

        // A mark on an AI game's capsule: a flag in Steam's own geometry, and its
        // cover blurred when `blur`. `kind` is the AI use the lists know the game
        // for ('translation', 'ingame', else 'ai'), which the flag names. No flag
        // when `flag` is false (High: a game it shoots, ai-browse.js). Its own blur
        // (ilap-ai-blur, a veil with data-ilap-ai-blur), so the blur setting and an
        // un-ignore leave it. One mark per capsule: a capsule inside or around one
        // that has the game's mark gets none.
        tag(link, appid, blur, kind, flag) {
            const containerObj = this.strategies.findContainer(link);
            if (!containerObj) return;
            const host = containerObj.element.tagName === 'IMG' ? containerObj.element.parentElement : containerObj.element;
            if (!host) return;
            // One flag and one blur per game per row (a curator review row
            // flagged its capsule and its gift icon both, and blurred the
            // icon). Only the row's best place takes them.
            const row = this._rowOf(host, appid);
            if (row && !this._bestOfRow(row, link, appid)) return;
            // A mark or blur this capsule still has from before untag stays, so a
            // level or box change redraws nothing that still holds. A flag left
            // unasked goes with the sweep.
            if (flag) {
                const item = this._flagItem(link, appid);
                const near = (item && item.querySelector(`:scope > ${flagSel(appid)}`))
                    || this._markNear(host, flagSel(appid));
                if (near) {
                    delete near.dataset.ilapStale;
                    this._labelFlag(near.firstElementChild, kind);
                } else if (!this._markNear(host, crossSel(appid))) {
                    // A flag a lesser link of the row had (its capsule came later) goes.
                    const twin = row && row.querySelector(flagSel(appid));
                    if (twin) { delete twin.dataset.ilapAppid; fadeOut(twin); }
                    this._putFlag(item || this.strategies.coverOf(host), appid, kind);
                }
            }
            const blurs = host.querySelectorAll(AI_BLURS);
            if (blur && blurs.length) blurs.forEach(el => { delete el.dataset.ilapStale; });
            else if (blur) applyBlur(host, appid, true);
        }

        // Steam's own flag holder for this game, or null: the element its IN
        // LIBRARY or ON WISHLIST flag goes on (dynamicstore.js appends .ds_flag
        // to the [data-ds-appid] element). Our flag goes in the same spot, so
        // Steam's rules place it where theirs would stand on this surface. A
        // package of several apps is no single game's.
        _flagItem(link, appid) {
            const item = link.closest('[data-ds-appid]');
            if (!item) return null;
            const ids = String(item.getAttribute('data-ds-appid')).split(',');
            return ids.length === 1 && ids[0].trim() === String(appid) ? item : null;
        }

        // The flag rides a layer of its own that covers the holder and takes no
        // pointer: Steam's jQuery drops the holder's .ds_flag children whenever
        // it re-flags it, and the layer keeps ours out of that. The flag itself
        // has Steam's class, so Steam's rules give it their place on each
        // surface, fold it to its icon on a small capsule and hide it while a
        // hover trailer plays, as they do theirs. Its size follows the capsule
        // and its colour the level (styles.css).
        _putFlag(at, appid, kind) {
            ensurePositioning(at);
            const box = document.createElement('div');
            box.className = 'ilap-ai-flagbox';
            box.dataset.ilapAppid = appid;
            const flag = document.createElement('div');
            flag.className = 'ds_flag ilap-ai-flag';
            this._labelFlag(flag, kind);
            box.appendChild(flag);
            at.appendChild(box);
        }

        _labelFlag(flag, kind) {
            if (!flag) return;
            flag.dataset.kind = aiFlagKind(kind);
            flag.lang = window.ILAP.i18n.getLang();
            flag.textContent = aiFlagWords(kind);
        }

        // A language switch: every flag on the page says its kind anew.
        relabel() {
            document.querySelectorAll('.ilap-ai-flag:not([data-ilap-note])').forEach(flag => this._labelFlag(flag, flag.dataset.kind));
        }

        // Every mark and blur of tag off the page, once a scan that follows
        // (ai-browse.js setOptions, then scan) has had AI_SWEEP_MS to keep the ones
        // whose game still counts. The rest fade out, and the covers sharpen. The
        // crossed marks stay with their badges.
        untag() {
            document.querySelectorAll('.ilap-ai-flagbox:not([data-ilap-note]), .ilap-ai-blur, .ilap-blur-backdrop[data-ilap-ai-blur]')
                .forEach(el => { el.dataset.ilapStale = '1'; });
            clearTimeout(this._sweepTimer);
            this._sweepTimer = setTimeout(() => this._sweep(), AI_SWEEP_MS);
        }

        _sweep() {
            document.querySelectorAll('.ilap-ai-flagbox[data-ilap-stale]').forEach(el => {
                delete el.dataset.ilapAppid;   // a scan meanwhile draws its own
                fadeOut(el);
            });
            document.querySelectorAll('.ilap-ai-blur[data-ilap-stale]').forEach(el => {
                el.classList.remove('ilap-ai-blur');
                delete el.dataset.ilapAiBlur;
                delete el.dataset.ilapStale;
                sharpen(el);
            });
            document.querySelectorAll('.ilap-blur-backdrop[data-ilap-ai-blur][data-ilap-stale]').forEach(el => {
                delete el.dataset.ilapAiBlur;
                fadeOut(el);
            });
        }

        // An AI game the HIGH level ignored: its badge's host takes the
        // crossed mark, white AI struck through, and the game's flags go.
        cross(host, appid) {
            // They fade as the badge comes in, out of the flags' selectors meanwhile.
            document.querySelectorAll(flagSel(appid)).forEach(el => { delete el.dataset.ilapAppid; fadeOut(el); });
            if (!this._markNear(host, crossSel(appid))) {
                const tag = document.createElement('div');
                tag.className = 'ilap-ai-tag ilap-ai-tag-ignored';
                tag.dataset.ilapAppid = appid;
                this._putTag(host, tag);
            }
            this.tips.watch();
        }

        // The game's crossed marks go with its badge.
        uncross(appid) {
            document.querySelectorAll(crossSel(appid)).forEach(el => {
                delete el.dataset.ilapAppid;
                fadeOut(el);
            });
        }

        // In the top right corner of the capsule's cover: on a wide row that is
        // the cover at its end, clear of the row's price (coverOf), and the mark
        // is the row size there (styles.css .ilap-ai-tag-row).
        _putTag(host, tag) {
            const at = this.strategies.coverOf(host);
            ensurePositioning(at);
            if (at !== host) tag.classList.add('ilap-ai-tag-row');
            at.appendChild(tag);
            sizeToCapsule(tag, at);
        }

        // The game's row round a capsule, or null: the largest block whose
        // /app/ links all go to this game (a curator review links it twice,
        // the capsule and a text link over the whole review).
        _rowOf(host, appid) {
            let row = null;
            for (let el = host.parentElement, i = 0; el && el !== document.body && i < 7; el = el.parentElement, i++) {
                const games = this._gamesIn(el);
                if (games.size > 1 || (games.size === 1 && !games.has(String(appid)))) break;
                row = el;
            }
            return row;
        }

        // Up to two of the games an element links to, enough to tell one game
        // from several. A scan tags the page's links in one synchronous loop, and
        // each tag climbs to the shared result list, so the answer is kept for
        // the run: read once per element, not once per game. Dropped once the run
        // yields. Steam cannot change the page under it, and the marks a tag
        // adds have no game links.
        _gamesIn(el) {
            if (!this._games) {
                this._games = new Map();
                queueMicrotask(() => { this._games = null; });
            }
            let games = this._games.get(el);
            if (!games) {
                games = new Set();
                for (const a of el.querySelectorAll('a[href*="/app/"]')) {
                    const m = /\/app\/(\d+)/.exec(a.getAttribute('href') || '');
                    if (m) games.add(m[1]);
                    if (games.size > 1) break;
                }
                this._games.set(el, games);
            }
            return games;
        }

        // Whether `link` has the row's best place for the marks: Steam's own
        // flag holder before any other link (a review's text link would take
        // its small icons for a cover), then the larger. Whichever link a scan
        // reaches first.
        _bestOfRow(row, link, appid) {
            let best = null;
            for (const l of row.querySelectorAll('a[href*="/app/"]')) {
                const c = this.strategies.findContainer(l);
                if (!c) continue;
                const h = c.element.tagName === 'IMG' ? c.element.parentElement : c.element;
                const place = h && (this._flagItem(l, appid) || this.strategies.coverOf(h));
                if (place && (!best || outranks(place, best.place))) best = { link: l, place };
            }
            return !best || best.link === link;
        }

        // The mark `sel` on this capsule, on one inside it, or on one around
        // it, or null.
        _markNear(host, sel) {
            const inside = host.querySelector(sel);
            if (inside) return inside;
            for (let el = host.parentElement, i = 0; el && el !== document.body && i < 7; el = el.parentElement, i++) {
                const around = el.querySelector(`:scope > ${sel}`);
                if (around) return around;
            }
            return null;
        }
    }

    window.ILAP.ManualIgnore.AiMarks = AiMarks;
    window.ILAP.ManualIgnore.aiFlagWords = aiFlagWords;
})();
