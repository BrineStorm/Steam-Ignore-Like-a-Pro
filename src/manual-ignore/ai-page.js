// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.ManualIgnore = window.ILAP.ManualIgnore || {};

    // The AI tab's note on an AI game's own store page (LOW and up). Steam
    // keeps the developers' AI Generated Content Disclosure far down the page,
    // under "About this game". The note puts the flag the game's capsules
    // show, the developers' own words and a way down to Steam's block beside
    // the facts at the top of the page. A game counts as on its capsules
    // (ai-disclosure.js pageVerdict under the AI tab's boxes). A listed game whose
    // page has no disclosure gets the flag alone, a game the lists mark by
    // hand (kind 'manual') a line that says so, and a game whose developer
    // removed the disclosure (kind 'removed') the flag with a tooltip that says
    // so. Only real input scrolls.
    // The button after the flag folds the note away, for every game page
    // (ilap_ai_note_collapsed): the flag then sits on the game's header image
    // with a button that brings the note back, and the column is Steam's own.
    //
    // deps:
    //   pageAppid       the open /app/<id> page's game
    //   isEnabled()     → the master switch
    //   aiGames(keep)   → Promise<Set of appid numbers> (ILAP.aiGames)
    //   aiKinds()       → Promise<Map appid number → 'translation' | 'ingame'>
    //   disclosure()    → { block, heading, text } | null (AiDisclosure.fromPage)
    //   rules           → { pageVerdict, translationOnly, liveAI } (AiDisclosure)
    //   nameOf()        → the game's name, which its disclosure may mention
    //   place()         → { parent, before } where the note goes, or null
    //   header()        → the header image's holder, where the folded flag goes, or null
    //   fit(note)       → sets how many lines of the words the note quotes
    //   setCollapsed(b) → stores the fold for every game page
    //   label(kind)     → the flag's words for a kind
    //   t(key, params)  → the panel's words for the tooltips and the buttons
    //   lang()          → the panel's language, for the flag's casing
    //   reduceMotion()  → true when the note comes and goes with no motion
    const LOW = 1;
    const SHOW_MS = 260;
    // The icon's stand-in in a tooltip's words (FloatTip in ui.js).
    const ICON = '\u0001';

    class AiPageNote {
        constructor(deps) {
            for (const fn of ['isEnabled', 'aiGames', 'aiKinds', 'disclosure', 'nameOf', 'place', 'header', 'fit',
                'setCollapsed', 'label', 't', 'lang', 'reduceMotion']) {
                if (typeof deps[fn] !== 'function') throw new TypeError('[ILAP] AiPageNote needs deps.' + fn);
            }
            if (!/^\d+$/.test(String(deps.pageAppid))) throw new TypeError('[ILAP] AiPageNote needs deps.pageAppid');
            if (!deps.rules || !['pageVerdict', 'translationOnly', 'liveAI'].every(fn => typeof deps.rules[fn] === 'function')) {
                throw new TypeError('[ILAP] AiPageNote needs deps.rules');
            }
            this.d = deps;
            this.level = 0;
            this.keep = { translation: false, ingame: false };
            this.collapsed = false;
            this.note = null;
            this.mini = null;
            this._seq = 0;
        }

        setOptions({ level, keep, collapsed }) {
            this.level = level;
            this.keep = { translation: keep.translation === true, ingame: keep.ingame === true };
            this.collapsed = collapsed === true;
        }

        // What the note shows now: null for none, else { kind, found }.
        async verdict() {
            if (this.level < LOW || !this.d.isEnabled()) return null;
            const id = Number(this.d.pageAppid);
            const [all, left, kinds] = await Promise.all([this.d.aiGames({}), this.d.aiGames(this.keep), this.d.aiKinds()]);
            const found = this.d.disclosure();
            const text = found ? found.text : '';
            const v = this.d.rules.pageVerdict({ id, all, left, text, nameOf: () => this.d.nameOf() }, this.keep);
            if (!v.ai) return null;
            let kind = 'ai';
            if (v.listed) kind = kinds.get(id) || 'ai';
            else if (this.d.rules.liveAI(text)) kind = 'ingame';
            else if (this.d.rules.translationOnly(text, v.name)) kind = 'translation';
            // The lists ship older than the page: a disclosure back on it is no removed one.
            if (kind === 'removed' && found) kind = 'ai';
            return { kind, found };
        }

        // Shows, updates or takes off the note, or the folded flag in its
        // place. A refresh asked while one reads wins over it.
        async refresh() {
            const seq = ++this._seq;
            const v = await this.verdict();
            if (seq !== this._seq) return;
            if (!v) { this.hide(); return; }
            this._shown = v;
            this._paint();
        }

        _paint() {
            const v = this._shown;
            if (this.collapsed) {
                this._hideNote();
                this._showMini(v);
            } else {
                this._hideMini();
                this._showNote(v);
            }
        }

        _showNote(v) {
            // The same note stays as it is: a refill would change its height in one frame.
            if (this.note && this.note.isConnected) {
                if (this.note.dataset.kind !== v.kind) this._relabelIn(this.note, v.kind);
                return;
            }
            const at = this.d.place();
            if (!at) return;
            const note = document.createElement('div');
            note.className = 'ilap-ai-note';
            note.dataset.ilapAppid = String(this.d.pageAppid);
            this._fill(note, v);
            at.parent.insertBefore(note, at.before || null);
            this.note = note;
            this.d.fit(note);
            this._move(note, true);
        }

        _showMini(v) {
            if (this.mini && this.mini.isConnected) {
                if (this.mini.dataset.kind !== v.kind) this._relabelIn(this.mini, v.kind);
                return;
            }
            const holder = this.d.header();
            if (!holder) return;
            if (getComputedStyle(holder).position === 'static') holder.dataset.ilapAnchor = '';
            // The capsules' flag box, for its place on the image. `data-ilap-note`
            // keeps the capsules' marks (ai-marks.js) off it.
            const box = document.createElement('div');
            box.className = 'ilap-ai-flagbox';
            box.dataset.ilapNote = '';
            box.dataset.ilapAppid = String(this.d.pageAppid);
            box.dataset.kind = v.kind;
            const mini = document.createElement('div');
            mini.className = 'ilap-ai-mini';
            mini.appendChild(this._flag(v.kind));
            mini.appendChild(this._foldButton(false));
            box.appendChild(mini);
            holder.appendChild(box);
            this.mini = box;
        }

        // The panel's language came or changed: the flags' words, the tooltips
        // and the buttons' names, then the note's lines, its link's width moved.
        relabel() {
            for (const el of [this.note, this.mini]) {
                if (el && el.isConnected) this._relabelIn(el, null);
            }
            this.refit();
        }

        // The window moved Steam's column: the lines it leaves the words.
        refit() {
            if (this.note && this.note.isConnected) this.d.fit(this.note);
        }

        hide() {
            this._shown = null;
            this._hideNote();
            this._hideMini();
        }

        _hideNote() {
            const note = this.note;
            this.note = null;
            if (!note || !note.isConnected) return;
            this._move(note, false);
        }

        _hideMini() {
            const mini = this.mini;
            this.mini = null;
            if (!mini) return;
            if (!mini.isConnected || this.d.reduceMotion()) { mini.remove(); return; }
            mini.style.pointerEvents = 'none';
            mini.animate([{ opacity: getComputedStyle(mini).opacity }, { opacity: 0 }],
                { duration: SHOW_MS, easing: 'ease', fill: 'forwards' })
                .finished.then(() => mini.remove(), () => mini.remove());
        }

        // A button's real press: the fold changes at once here and is stored
        // for every game page (its storage echo repaints the same).
        _toggle(collapsed) {
            this.collapsed = collapsed;
            if (this._shown) this._paint();
            this.d.setCollapsed(collapsed);
        }

        _flag(kind) {
            const flag = document.createElement('div');
            flag.className = 'ilap-ai-flag';
            // Labelled here (relabel), so the capsules' relabel leaves it.
            flag.dataset.ilapNote = '';
            this._label(flag, kind);
            return flag;
        }

        _label(flag, kind) {
            flag.dataset.kind = kind;
            flag.lang = this.d.lang();
            flag.textContent = this.d.label(kind);
            const tip = this.d.t('ai_note_tip', { icon: ICON });
            flag.dataset.ilapTip = kind === 'removed' ? `${this.d.t('ai_note_removed')} ${tip}` : tip;
        }

        _foldButton(open) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'ilap-ai-fold';
            b.setAttribute('aria-expanded', String(open));
            this._nameButton(b);
            b.addEventListener('click', (e) => {
                if (!e.isTrusted) return;
                e.preventDefault();
                e.stopPropagation();
                this._toggle(open);
            });
            return b;
        }

        _nameButton(b) {
            const name = this.d.t(b.getAttribute('aria-expanded') === 'true' ? 'ai_note_fold' : 'ai_note_unfold');
            b.setAttribute('aria-label', name);
            b.dataset.ilapTip = name;
        }

        // A kind of null keeps the flag's own.
        _relabelIn(el, kind) {
            const flag = el.querySelector('.ilap-ai-flag');
            if (flag) this._label(flag, kind || flag.dataset.kind);
            const b = el.querySelector('.ilap-ai-fold');
            if (b) this._nameButton(b);
            const own = el.querySelector('.ilap-ai-note-own');
            if (own) own.textContent = this.d.t('ai_note_manual');
            if (kind) el.dataset.kind = kind;
        }

        _fill(note, { kind, found }) {
            note.textContent = '';
            note.dataset.kind = kind;
            const head = document.createElement('div');
            head.className = 'ilap-ai-note-head';
            head.appendChild(this._flag(kind));
            head.appendChild(this._foldButton(true));
            note.appendChild(head);
            if (found && found.text) {
                const words = document.createElement('q');
                words.className = 'ilap-ai-note-text';
                words.textContent = found.text;
                note.appendChild(words);
            } else if (kind === 'manual') {
                // Our words, in the quote's place, so the fit counts its lines too.
                const own = document.createElement('div');
                own.className = 'ilap-ai-note-text ilap-ai-note-own';
                own.textContent = this.d.t('ai_note_manual');
                note.appendChild(own);
            }
            if (found) {
                const more = document.createElement('button');
                more.type = 'button';
                more.className = 'ilap-ai-note-more';
                more.textContent = `${found.heading} ↓`;
                more.addEventListener('click', (e) => {
                    if (!e.isTrusted) return;
                    found.block.scrollIntoView({ behavior: this.d.reduceMotion() ? 'auto' : 'smooth', block: 'start' });
                });
                note.appendChild(more);
            }
        }

        // In: its height grows from nothing as it fades in. Out: the reverse,
        // then it goes. Reduced motion: at once.
        _move(note, show) {
            if (this.d.reduceMotion() || !note.animate) {
                if (!show) note.remove();
                return;
            }
            const h = note.getBoundingClientRect().height;
            const s = getComputedStyle(note);
            const full = { height: h + 'px', marginTop: s.marginTop, marginBottom: s.marginBottom, opacity: 1 };
            const none = { height: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0 };
            note.style.overflow = 'hidden';
            const anim = note.animate(show ? [none, full] : [full, none], { duration: SHOW_MS, easing: 'ease' });
            const done = () => {
                note.style.overflow = '';
                if (!show) note.remove();
            };
            anim.finished.then(done, done);
        }
    }

    // Where the note goes on a game page: among the facts at the top of the
    // right column, before the user tags, or at the column's end.
    function notePlace(doc) {
        const glance = doc.querySelector('.glance_ctn');
        if (!glance) return null;
        const tags = glance.querySelector(':scope > .glance_ctn_responsive_right');
        return { parent: glance, before: tags };
    }

    // The game's header image at the top of the right column, where the
    // folded flag goes.
    function noteHeader(doc) {
        return doc.querySelector('.glance_ctn .game_header_image_ctn');
    }

    // How many lines of the developers' words the note quotes: four at most,
    // fewer where Steam's column would lose the air under the game's
    // description, none when even the flag and the way down leave too little.
    // Steam sizes that column to the media beside it and spreads what its
    // blocks leave over between them, so a note that takes all of it presses
    // the reviews against the description. The air kept is AIR px, or Steam's
    // own when it gives less.
    const MAX_LINES = 4;
    const AIR = 16;
    function fitNote(note) {
        const glance = note.closest('.glance_ctn');
        const desc = glance && glance.querySelector('.game_description_snippet');
        const next = glance && glance.querySelector('.glance_ctn_responsive_left');
        const words = note.querySelector('.ilap-ai-note-text');
        const quote = (n) => {
            note.style.setProperty('--ilap-note-lines', String(n));
            if (words) words.hidden = n === 0;
        };
        quote(MAX_LINES);
        if (!desc || !next || !words) return;
        const air = () => next.getBoundingClientRect().top - desc.getBoundingClientRect().bottom;
        // Steam's own air, read with the note out of the column's flow
        // (display: none would replay the flag's fade-in).
        note.style.position = 'absolute';
        const need = Math.min(AIR, air());
        note.style.position = '';
        for (let n = MAX_LINES; n > 0; n--) {
            quote(n);
            if (air() >= need - 0.5) return;
        }
        quote(0);
    }

    window.ILAP.ManualIgnore.AiPageNote = AiPageNote;
    window.ILAP.ManualIgnore.aiNotePlace = notePlace;
    window.ILAP.ManualIgnore.aiNoteHeader = noteHeader;
    window.ILAP.ManualIgnore.aiNoteFit = fitNote;
})();
