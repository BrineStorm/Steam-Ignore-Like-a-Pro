// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The built-in ignore lists (data/presets.json, built by
    // scripts/build-presets.js): the AI and lists tabs' panes (ui/popup_tabs.js).
    // One + queues one list as a job of its own. A list is offered while it is
    // neither in the queue nor run to its end in this build's version of it,
    // and one run at an older version has a blue dot (DoneMarks.presetMarks).

    const t = window.ILAP.t;
    const esc = window.ILAP.Sanitizer.escapeHTML;

    const AI = 'ai';
    const DENUVO = 'denuvo';
    // The AI list's buckets besides the plain years (scripts/build-presets.js
    // bucketOf): 'upcoming_2027', 'upcoming_2028+', 'tba', 'earlier_2023'.
    const UPCOMING_RE = /^upcoming_(\d{4}\+?)$/;
    const EARLIER_RE = /^earlier_(\d{4})$/;
    const TBA = 'tba';
    const YEAR_RE = /^\d{4}$/;
    // The lists that ship whole, in the lists tab's order: by their English
    // names (Denuvo DRM, EULA can change at any time, Every VR game, In-App
    // Purchases, Invasive EULA terms, Kernel access, Known bad games,
    // Lesser-known bad games), the same in every language.
    const FLAT = [DENUVO, 'eularetro', 'vr', 'iap', 'eula', 'anticheat', 'bad', 'lesser'];
    // An AI list's rev gets a tag per ticked box (translation first), so its
    // done mark says which games it left out.
    const KEEP_TAG = { translation: '+t', ingame: '+l' };
    const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The widget's lists window stops this far over the viewport's bottom,
    // as the panel does (src/widget/main.js #popup-root max-height).
    const VIEWPORT_MARGIN = 12;
    // The gap between the queue's window and the lists' one under it, and how
    // long the lists take to move out from under the queue or back (the
    // queue's own slide, popup_tabs.js SLIDE_MS).
    const QUEUE_GAP = 6;
    const MOVE_MS = 260;

    // The upcoming years soonest first, then 'tba', then the released years
    // newest first, then the older ones together.
    function bucketRank(b) {
        const up = UPCOMING_RE.exec(b);
        if (up) return [0, parseInt(up[1], 10)];
        if (b === TBA) return [1, 0];
        if (YEAR_RE.test(b)) return [2, -b];
        return [3, 0];
    }
    function aiBuckets(data) {
        return Object.keys((data && data.ai) || {}).sort((a, b) => {
            const ra = bucketRank(a), rb = bucketRank(b);
            return ra[0] - rb[0] || ra[1] - rb[1];
        });
    }

    function bucketLabel(bucket) {
        const up = UPCOMING_RE.exec(bucket);
        if (up) return t('preset_upcoming', { year: up[1] });
        const earlier = EARLIER_RE.exec(bucket);
        if (earlier) return t('preset_earlier', { year: earlier[1] });
        if (bucket === TBA) return t('preset_tba');
        return bucket;
    }
    const hasList = (data, key) => Array.isArray(data[key]) && data[key].length > 0;
    // A whole list's name, in the menu and on its job. Denuvo DRM is a brand name.
    const FLAT_NAME = {
        anticheat: 'preset_anticheat', iap: 'preset_iap', vr: 'preset_vr',
        bad: 'preset_bad', lesser: 'preset_lesser', eula: 'preset_eula', eularetro: 'preset_eularetro',
    };
    const flatName = (key) => (key === DENUVO ? 'Denuvo DRM' : t(FLAT_NAME[key]));
    // A list whose name alone does not say all it covers has a tip over it.
    const FLAT_TIP = { anticheat: 'preset_anticheat_tip', bad: 'preset_bad_tip', lesser: 'preset_lesser_tip' };
    // The long names, on one line with the whole name on hover. No tip on these.
    const FLAT_CUT = new Set(['eula', 'eularetro']);
    const tipId = (key) => 'list-tip-' + key;

    // The name a list's job shows in the queue ("AI games 2025"). Keys:
    // 'ai_2025', 'ai_upcoming_2027', 'ai_tba', 'ai_earlier_2023', and FLAT's.
    function label(key) {
        key = String(key || '');
        if (FLAT.includes(key)) return flatName(key);
        if (!key.startsWith(AI + '_')) return key;
        const bucket = key.slice(AI.length + 1);
        const up = UPCOMING_RE.exec(bucket);
        if (up) return t('preset_ai_job_upcoming', { when: up[1] });
        if (bucket === TBA) return t('preset_ai_job_tba');
        return t('preset_ai_job', { when: bucketLabel(bucket) });
    }

    // The year the AI row starts on, among the open ones: this year's released
    // games, or the nearest released year when this year has no list or it is
    // queued or done (the newer of two as near). With no such year open, the
    // first open bucket.
    function startBucket(open) {
        const now = new Date().getFullYear();
        const years = open.filter(b => YEAR_RE.test(b));
        if (!years.length) return open[0] || null;
        return years.reduce((best, b) => {
            const d = Math.abs(+b - now), bd = Math.abs(+best - now);
            return d < bd || (d === bd && +b > +best) ? b : best;
        });
    }

    // The ✓ of a list in the queue, on its row and by its year in the year list.
    function queuedMark(cls, fresh) {
        return `<span class="${cls} is-queued${fresh ? ' fresh' : ''}" role="img" aria-label="${esc(t('curator_in_queue'))}">${window.ILAP_Icons.CHECK}</span>`;
    }

    // The lists drawer: the button in the tab line's left corner slides it out
    // of the panel's left side, as tall as the panel, and back. AI-generated
    // content on top, one row whose year is picked from a droplist, the whole
    // lists under it. A row has its list's name, how many games it has and,
    // while it is on offer, a + that queues it as a job of its own. A list in
    // the queue says so in place of the +, and so does one run to its end in
    // this build's version of it.
    class ListPanes {
        // `opts.holdCount()` keeps the queue's job count at its old number and
        // returns its release (popup_queue.js holdCount). `opts.onOpen()`: the
        // drawer is about to slide out (the queue's drawer shuts).
        // `opts.queueFoot()`: the lower edge of the queue's window out beside
        // the widget's panel, or null (popup_queue.js foot).
        // Given by popup_main.js as well:
        //   store            src/curator/store.js (getQueue, stagePreset)
        //   marks            src/curator/done-marks.js (presetMarks, markPresetSeen)
        //   loadPresets()    the lists, read once per page (src/presets.js)
        //   aiGames(data, keep)  the AI games the ticked boxes leave in (src/presets.js)
        constructor(root, opts) {
            for (const dep of ['holdCount', 'store', 'marks', 'loadPresets', 'aiGames']) {
                if (!opts || !opts[dep]) throw new TypeError('[ILAP] ListPanes needs opts.' + dep);
            }
            this.root = root;
            this.opts = opts;
            this.store = opts.store;
            this.marks = opts.marks;
            this.btn = root.getElementById('lists-btn');
            this.drawer = root.getElementById('lists-drawer');
            this.panes = { ai: root.getElementById('ai-pane'), lists: root.getElementById('lists-pane') };
            // The AI tab's boxes as stored: AI games of a ticked kind stay
            // out of the AI lists.
            this.keep = { translation: false, ingame: false };
            this.data = null;
            this.queued = new Set();   // list keys with a job in the queue
            this.done = new Set();     // list keys run to their end at this rev
            this.updated = new Set();  // list keys run at an older rev: the blue dot
            this.bucket = null;        // the AI row's year
            this.msg = { ai: '', lists: '' };
            this.isOpen = false;
            // The extension is off: it takes no new jobs, so the drawer stays shut.
            this.masterOff = false;
            this._anim = null;
            this._moveAnim = null;
            // A + is dead from its press until the list's job is in the queue.
            this._staging = new Set();
            if (this.drawer) {
                this.drawer.addEventListener('click', (e) => {
                    if (!e.isTrusted) return;
                    const add = e.target.closest('.list-add');
                    const year = e.target.closest('.ai-year');
                    const opt = e.target.closest('.ai-opt');
                    const row = e.target.closest('.list-row');
                    if (!year && !opt) this._showYears(false);   // a pick shuts it after the redraw
                    if (year) this._showYears(!this._yearsOpen());
                    else if (opt) this._pickYear(opt.dataset.bucket);
                    else if (add) { if (!add.disabled) this._stage(add.closest('.list-pane') === this.panes.ai ? 'ai' : 'lists', add.dataset.key); }
                    // The dot, or its row anywhere but the + and the year: the dot goes.
                    else if (row) this._dismissDot(row.dataset.key, e.detail === 0 && !!e.target.closest('.list-dot'));
                });
                // A name shows whole on hover only where it was cut, judged at
                // hover time (popup_queue.js does the same for job names).
                this.drawer.addEventListener('mouseover', (e) => {
                    const dot = e.target.closest && e.target.closest('.list-dot');
                    if (dot) this._placeDotTip(dot);
                    const box = e.target.closest && e.target.closest('.list-namebox');
                    if (!box) return;
                    const name = box.querySelector('.list-name');
                    box.classList.toggle('is-cut', !!name && name.scrollWidth > name.clientWidth);
                });
                this.drawer.addEventListener('focusin', (e) => {
                    const dot = e.target.closest('.list-dot');
                    if (dot) this._placeDotTip(dot);
                });
                // The arrows, Home and End walk the open year list.
                // Escape shuts the year list first, then the drawer, which hands
                // focus back to its button.
                this.drawer.addEventListener('keydown', (e) => {
                    const opts = this._yearsOpen() ? Array.from(this.drawer.querySelectorAll('.ai-opt')) : [];
                    const i = opts.indexOf(e.target);
                    if (i >= 0 && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
                        e.preventDefault();
                        const to = { ArrowDown: Math.min(i + 1, opts.length - 1), ArrowUp: Math.max(i - 1, 0), Home: 0, End: opts.length - 1 }[e.key];
                        // One Tab stop, on the year the arrows are on.
                        opts.forEach((o, k) => { o.tabIndex = k === to ? 0 : -1; });
                        opts[to].focus({ preventScroll: true });
                        return;
                    }
                    if (e.key !== 'Escape' || !this.isOpen) return;
                    e.stopPropagation();
                    if (this._yearsOpen()) {
                        this._showYears(false);
                        const year = this.drawer.querySelector('.ai-year');
                        if (year) year.focus();
                        return;
                    }
                    this.toggle(false);
                    if (this.btn) this.btn.focus();
                });
            }
            if (this.btn) {
                // Opened from the keyboard (a click with no pointer, detail 0),
                // the drawer takes the focus: it sits before the panel in the
                // tab order, out of reach of a Tab from its button.
                this.btn.addEventListener('click', (e) => {
                    if (!e.isTrusted) return;
                    const byKey = e.detail === 0;
                    this.toggle(!this.isOpen).then(() => {
                        const first = byKey && this.isOpen && this.drawer.querySelector('button:not([disabled])');
                        if (first) first.focus({ preventScroll: true });
                    });
                });
            }
            // A click anywhere else in the panel shuts the year list too.
            root.addEventListener('click', (e) => {
                if (this.drawer && !this.drawer.contains(e.target)) this._showYears(false);
            });
            // The panel changes height as a tab's pane opens or shuts under
            // the line, or a hint line comes or goes over it: the block
            // follows the line. Its rows grow and shrink as a message comes
            // or goes: the block follows them. So it does the queue's window
            // over it, as a strip comes or goes there.
            const panel = root.getElementById('popup-root');
            const queueInner = root.querySelector('#queue-drawer > .drawer-inner');
            if (panel && this.drawer && typeof ResizeObserver === 'function') {
                const ro = new ResizeObserver(() => { if (this.isOpen) this._place(); });
                ro.observe(panel);
                for (const p of Object.values(this.panes)) if (p) ro.observe(p);
                if (queueInner) ro.observe(queueInner);
            }
        }

        // In the widget the lists are a window of their own, framed all round,
        // its right edge on the panel's left one and its foot on the tab
        // line's lower edge, so it stays by its button whatever opens under
        // the line. With no pane open the line is the panel's lower edge.
        // With a pane open its foot is as far under the line as the panel's
        // own lower frame, so its height stays the same as the pane opens and
        // shuts. Rows taller than the room over the foot take the window's
        // top up to the panel's top and its foot down under the line, as far
        // as the panel's own margin over the viewport's bottom, so they show
        // whole. With the queue's window out over the panel's top, the
        // window's top stays under it and its foot goes down as far as its
        // rows need, the rest scrolling inside. In the toolbar popup the lists
        // drop down under the line in the window's flow and need no placing.
        _place() {
            const inner = this.drawer && this.drawer.firstElementChild;
            const line = this.root.getElementById('tabline');
            const pane = this.root.getElementById('tab-panel');
            const panel = this.root.getElementById('popup-root');
            const shell = this.root.getElementById('ilap-shell');
            if (!inner || !line || !panel || !shell) return;
            if (window.ILAP_Tabs.inWindow(this.drawer)) {
                inner.style.maxHeight = '';
                return;
            }
            // Moving out from under the queue's window or back (follow): it
            // lands placed, and catches up on anything that moved meanwhile.
            if (this._moveAnim) return;
            const s = shell.getBoundingClientRect();
            const frame = parseFloat(getComputedStyle(panel).borderBottomWidth) || 0;
            const below = pane && pane.getBoundingClientRect().height
                ? Math.max(0, s.bottom - line.getBoundingClientRect().bottom - frame) : 0;
            const queueFoot = this.opts.queueFoot ? this.opts.queueFoot() : null;
            const top = queueFoot === null ? s.top : queueFoot + QUEUE_GAP;
            // The rows' whole height, read uncapped.
            inner.style.maxHeight = 'none';
            const need = inner.getBoundingClientRect().height;
            const foot = Math.max(s.bottom - below, Math.min(top + need, window.innerHeight - VIEWPORT_MARGIN));
            this.drawer.style.right = panel.offsetWidth + 'px';
            this.drawer.style.bottom = (s.bottom - foot) + 'px';
            inner.style.maxHeight = Math.max(0, foot - top) + 'px';
            // Rows that fit show whole, so the block clips instead of
            // scrolling: rows that grow (a longer translation) cannot flash a
            // scrollbar in the frame before this runs again.
            inner.style.overflowY = need > foot - top ? '' : 'hidden';
        }

        // The queue's window opened or shut over the widget's open lists: the
        // lists' window slides down out from under it, or back up, as the
        // queue unrolls or rolls up. It clips while it moves, so no scrollbar
        // shows on the way.
        follow() {
            const inner = this.drawer && this.drawer.firstElementChild;
            if (!inner || !this.drawer.classList.contains('open') || window.ILAP_Tabs.inWindow(this.drawer)) return;
            // Still unrolling: it goes on unrolling in its new place.
            if (this._anim) { this._place(); return; }
            // Measured mid-move too, so a reversal starts where the window is.
            const from = inner.getBoundingClientRect();
            if (this._moveAnim) { this._moveAnim.cancel(); this._moveAnim = null; }
            this._place();
            const to = inner.getBoundingClientRect();
            if ((from.bottom === to.bottom && from.height === to.height) || reduceMotion() || !inner.animate) {
                inner.classList.remove('moving');
                return;
            }
            inner.classList.add('moving');
            const anim = this._moveAnim = inner.animate([
                { transform: `translateY(${from.bottom - to.bottom}px)`, height: from.height + 'px', maxHeight: from.height + 'px' },
                { transform: 'none', height: to.height + 'px', maxHeight: to.height + 'px' },
            ], { duration: MOVE_MS, easing: 'ease' });
            anim.finished.catch(() => {}).then(() => {
                if (anim !== this._moveAnim) return;
                this._moveAnim = null;
                inner.classList.remove('moving');
                this._place();
            });
        }

        // In the widget the window unrolls from its lower right corner, by the
        // lists button, as its rows fade in, and rolls back into it. In the
        // toolbar popup it drops down. Its rows are read before it opens. `onOpen`
        // may answer the height a pane it folded at once left under the line
        // (the toolbar popup): the drawer starts from that height, so the
        // window makes one move from the pane's height to the lists'.
        async toggle(open) {
            if (!this.drawer || (open && this.masterOff) || open === this.isOpen) return;
            this.isOpen = open;
            if (this.btn) this.btn.setAttribute('aria-expanded', String(open));
            if (!open) this._showYears(false);
            const lent = open && this.opts.onOpen ? this.opts.onOpen() : 0;
            if (lent) this.drawer.style.height = lent + 'px';
            await window.ILAP_Tabs.slideDrawer(this.drawer, open, this, open
                ? () => this.refresh().catch((e) => console.warn('[ILAP] built-in lists unavailable:', e))
                    .then(() => this._place())
                : null, window.ILAP_Tabs.inWindow(this.drawer) ? 'height' : 'unroll-up-left');
        }

        // Shut at once, for a tab's pane that takes its place under the line
        // and grows from its height, and for the widget's panel opening again
        // after a click elsewhere hid it. Answers the height it had.
        foldNow() {
            if (!this.drawer || (!this.isOpen && !this._anim)) return 0;
            const h = this.drawer.getBoundingClientRect().height;
            this.isOpen = false;
            if (this.btn) this.btn.setAttribute('aria-expanded', 'false');
            this._showYears(false);
            if (this._anim) { this._anim.cancel(); this._anim = null; }
            this.drawer.classList.remove('open', 'shown', 'sliding');
            this.drawer.style.height = '';
            return h;
        }

        // The extension went off or on. An open drawer slides shut.
        setMasterOff(off) {
            this.masterOff = off;
            if (this.btn) {
                this.btn.classList.toggle('master-dim', off);
                this.btn.setAttribute('aria-disabled', String(off));
            }
            if (off) this.toggle(false);
        }

        // The AI tab's boxes as stored (popup_ai.js). A box that changes
        // redraws an open drawer: the AI lists' counts and done marks move.
        setKeep(keep) {
            const moved = keep.translation !== this.keep.translation || keep.ingame !== this.keep.ingame;
            this.keep = { translation: keep.translation, ingame: keep.ingame };
            if (moved && this.isOpen) this.refresh().catch((e) => console.warn('[ILAP] built-in lists unavailable:', e));
        }

        // A list's games as a + would queue them: an AI list less the kept
        // games (ILAP.aiGames).
        _appids(key) {
            if (!key.startsWith(AI + '_')) return this.data[key];
            const games = this.opts.aiGames(this.data, this.keep);
            return (this.data.ai[key.slice(AI.length + 1)] || []).filter(a => games.has(Number(a)));
        }

        // A list's rev as a + would queue it: an AI list's tagged with the
        // ticked boxes.
        _rev(key) {
            const rev = this.data.rev[key];
            if (!key.startsWith(AI + '_')) return rev;
            return rev + Object.keys(KEEP_TAG).filter(kind => this.keep[kind]).map(kind => KEEP_TAG[kind]).join('');
        }

        // The revs each list counts as done at. An AI list run with fewer boxes
        // ticked than now left out fewer games, so it covers today's list too.
        // One run with a box ticked that is now clear left games out: the list
        // is offered again, for those games.
        _doneRevs() {
            const ticked = Object.keys(KEEP_TAG).filter(kind => this.keep[kind]);
            // Every subset of the ticked boxes, in tag order.
            const tags = ticked.reduce((all, kind) => all.concat(all.map(s => s + KEEP_TAG[kind])), ['']);
            const revs = {};
            for (const key of Object.keys(this.data.rev)) {
                revs[key] = key.startsWith(AI + '_') ? tags.map(tag => this.data.rev[key] + tag) : this.data.rev[key];
            }
            return revs;
        }

        // Reads the lists and what is queued or done, and redraws both panes.
        // Called as the drawer opens and whenever the queue or a done mark
        // changes, so it never offers a list another tab has just taken.
        async refresh() {
            const data = this.data = await this.opts.loadPresets();
            const [marks, queue] = await Promise.all([this.marks.presetMarks(this._doneRevs()), this.store.getQueue()]);
            const blocked = marks.blocked;
            this.queued = new Set(queue.map(j => String(j.curatorId || ''))
                .filter(id => id.startsWith('preset_')).map(id => id.slice('preset_'.length)));
            this.done = new Set([...blocked].filter(k => !this.queued.has(k)));
            this.updated = marks.updated;
            const buckets = aiBuckets(data);
            if (!buckets.includes(this.bucket)) {
                this.bucket = startBucket(buckets.filter(b => !blocked.has(AI + '_' + b))) || buckets[0] || null;
            }
            this._render();
        }

        _state(key) {
            return this.queued.has(key) ? 'queued' : this.done.has(key) ? 'done' : '';
        }

        // A list run to its end at an older version than this build's: a blue
        // dot by its name, a button whose name is its tip. `kept`: it was on
        // screen before this redraw, so it does not come in again.
        _dot(key, kept) {
            if (!this.updated.has(key)) return '';
            const tip = esc(t('preset_updated_tip'));
            return `<button type="button" class="list-dot${kept ? ' kept' : ''}" data-key="${esc(key)}" aria-label="${tip}">`
                + `<span class="list-dot-in"></span><span class="list-dot-tip" aria-hidden="true">${tip}</span></button>`;
        }

        // The end of a row: its list's state, or the + while it is on offer. A
        // list in the queue shows a ✓ in the +'s place, named for screen
        // readers. `fresh`: it was not on screen before this redraw, so it
        // draws itself in.
        _tail(key, name, fresh) {
            const state = this._state(key);
            if (state === 'queued') return queuedMark('list-state', fresh);
            if (state === 'done') return `<span class="list-state is-done">✓ ${esc(t('ignored_by'))}</span>`;
            const off = this.masterOff || this._staging.has(key);
            const described = FLAT_TIP[key] ? ` aria-describedby="${esc(tipId(key))}"` : '';
            return `<button type="button" class="list-add" data-key="${esc(key)}" aria-label="${esc(t('curator_add_to_queue') + ': ' + name)}"${described}${off ? ' disabled' : ''}>+</button>`;
        }

        _render() {
            if (!this.data) return;
            const data = this.data;
            const lang = window.ILAP.i18n.getLang();
            const count = (appids) => (appids || []).length.toLocaleString(lang);
            // A message the pane shows already stays as it is through the redraw,
            // one that goes folds away after it (_foldMsg).
            const shownMsg = (name) => this.panes[name] && this.panes[name].querySelector(':scope > .list-msg');
            const msg = (name) => {
                if (!this.msg[name]) return '';
                const old = shownMsg(name);
                const kept = old && !old.classList.contains('leaving') && old.textContent === this.msg[name] ? ' kept' : '';
                return `<div class="list-msg${kept}">${esc(this.msg[name])}</div>`;
            };
            const going = { ai: !this.msg.ai && shownMsg('ai'), lists: !this.msg.lists && shownMsg('lists') };
            // The dots on screen: one whose list still has it stays as it is
            // through the redraw, one that went (dismissed here or on the
            // other surface, or its list queued) folds away where it was.
            const oldDots = this.drawer && this.drawer.classList.contains('shown')
                ? Array.from(this.drawer.querySelectorAll('.list-dot')) : [];
            const shownDots = new Set(oldDots.filter(d => !d.classList.contains('leaving')).map(d => d.dataset.key));
            // A row's ✓ on screen stays still through the redraw. One that
            // comes while the drawer is out draws itself in.
            const shown = this.drawer && this.drawer.classList.contains('shown');
            const shownChecks = new Set(shown ? Array.from(this.drawer.querySelectorAll('.list-row > .list-state.is-queued'))
                .map(m => m.parentElement.dataset.key) : []);
            const fresh = (key) => shown && !shownChecks.has(key);
            // The focus on a row's button stays on that button through the redraw.
            const active = this.drawer && this.drawer.contains(this.root.activeElement) ? this.root.activeElement : null;
            const focusRow = active && active.closest('.list-row');
            const focusOn = focusRow && ['list-add', 'list-dot', 'ai-year'].find(c => active.classList.contains(c));
            const buckets = aiBuckets(data);
            // An open year list stays open through the redraw, so a pick folds
            // it shut from where it is (_pickYear) instead of in one frame.
            const yearsOpen = this._yearsOpen();
            if (this.panes.ai) {
                const key = AI + '_' + this.bucket;
                const state = this._state(key);
                // The year list opens under the year button, in the drawer's
                // block. Each year says whether it is queued or done already.
                const opts = buckets.map(b => {
                    const s = this._state(AI + '_' + b);
                    const tail = s === 'queued' ? queuedMark('ai-opt-mark')
                        : s === 'done' ? '<span class="ai-opt-mark">✓</span>'
                        : this.updated.has(AI + '_' + b) ? '<span class="ai-opt-dot" aria-hidden="true"></span>' : '';
                    return `<button type="button" class="ai-opt${b === this.bucket ? ' selected' : ''}${s ? ' is-' + s : ''}" role="option" aria-selected="${b === this.bucket}" tabindex="${b === this.bucket ? 0 : -1}" data-bucket="${esc(b)}">${esc(bucketLabel(b))}${tail}</button>`;
                }).join('');
                const yearWas = this._yearBox();
                this.panes.ai.innerHTML = !buckets.length ? '' : `
                    <div class="list-row ai-row${state ? ' is-' + state : ''}" data-key="${esc(key)}">
                        <span class="ai-head"><span class="ai-name"><span class="list-name">${esc(t('preset_ai'))}</span>${this._dot(key, shownDots.has(key))}</span><button type="button" class="ai-year" aria-haspopup="listbox" aria-expanded="${yearsOpen}">${esc(bucketLabel(this.bucket))}</button></span>
                        <span class="list-count">${count(this._appids(key))}</span>${this._tail(key, label(key), fresh(key))}
                    </div>
                    <div class="ai-years${yearsOpen ? ' open' : ''}" role="listbox"><div class="ai-years-in"><div class="ai-years-box">${opts}</div></div></div>${msg('ai')}`;
                if (yearsOpen) this._placeYears();
                this._moveYear(yearWas);
            }
            if (this.panes.lists) {
                const rows = FLAT.filter(k => hasList(data, k)).map(k => {
                    const state = this._state(k);
                    const tip = FLAT_TIP[k] ? `<span class="list-tip" id="${esc(tipId(k))}" role="tooltip">${esc(t(FLAT_TIP[k]))}</span>` : '';
                    // A long name keeps to one line and shows whole over itself where it is cut, as in the queue.
                    const name = !FLAT_CUT.has(k) ? `<span class="list-name${tip ? ' has-tip' : ''}">${esc(flatName(k))}</span>`
                        : `<span class="list-namebox"><span class="list-name">${esc(flatName(k))}</span>`
                            + `<span class="list-name-full" role="tooltip">${esc(flatName(k))}</span></span>`;
                    return `<div class="list-row${state ? ' is-' + state : ''}" data-key="${esc(k)}">
                        ${name}${tip}${this._dot(k, shownDots.has(k))}
                        <span class="list-count">${count(data[k])}</span>${this._tail(k, flatName(k), fresh(k))}</div>`;
                }).join('');
                // No title: the lists button's tooltip names them.
                this.panes.lists.innerHTML = `${rows}${msg('lists')}`;
            }
            for (const name of ['ai', 'lists']) if (going[name]) this._foldMsg(this.panes[name], going[name]);
            for (const dot of oldDots) {
                const leaving = dot.classList.contains('leaving');
                if ((leaving || !this.updated.has(dot.dataset.key)) && this._putBackDot(dot) && !leaving) this._foldDot(dot);
            }
            const refocus = focusOn && this.drawer.querySelector(
                `.list-row[data-key="${CSS.escape(focusRow.dataset.key)}"] .${focusOn}:not(.leaving)`);
            if (refocus && refocus !== active) refocus.focus({ preventScroll: true });
        }

        // A dot gone with the redraw, back in its place in its list's new row,
        // after the name (and the name's tip). False when the row is gone or
        // has a dot of its own.
        _putBackDot(dot) {
            const row = this.drawer.querySelector(`.list-row[data-key="${CSS.escape(dot.dataset.key)}"]`);
            if (!row || row.querySelector('.list-dot')) return false;
            const after = row.querySelector('.ai-name > .list-name')
                || row.querySelector(':scope > .list-tip') || row.querySelector(':scope > :is(.list-name, .list-namebox)');
            if (!after) return false;
            after.after(dot);
            return true;
        }

        // The dot shrinks as it fades (reduced motion: it fades), out of
        // reach, and goes. On a whole list's row it gives its room back to the
        // name as it shrinks, so a cut name opens out instead of jumping. The
        // AI row's dot keeps its room to the end: the year button beside it
        // may then come back up beside the name, which _moveYear animates.
        _foldDot(dot) {
            dot.classList.add('leaving');
            dot.tabIndex = -1;
            const onAiRow = !!dot.closest('.ai-row');
            const gone = () => {
                if (!dot.isConnected) return;
                const was = onAiRow ? this._yearBox() : null;
                dot.remove();
                if (was) this._moveYear(was);
            };
            if (!dot.animate) { gone(); return; }
            const timing = { duration: 200, easing: 'ease-in', fill: 'forwards' };
            const still = reduceMotion();
            const w = dot.getBoundingClientRect().width + 'px';
            const anim = dot.animate(onAiRow || still ? [{ opacity: 1 }, { opacity: 0 }]
                : [{ opacity: 1, width: w }, { opacity: 0, width: '0px' }], timing);
            if (!still && dot.firstElementChild) dot.firstElementChild.animate([{ transform: 'scale(1)' }, { transform: 'scale(0)' }], timing);
            anim.finished.catch(() => {}).then(gone);
        }

        // A click on a list's dot, or on its row anywhere but the + and the
        // AI row's year: the dot goes, and stays away until the list changes
        // again (DoneMarks.markPresetSeen, so the other surface's dot goes
        // too). On the AI row it is the picked year's dot. From the keyboard
        // (`toAdd`) the focus moves on to the row's +.
        _dismissDot(key, toAdd) {
            if (!key || !this.data || !this.updated.has(key)) return;
            this.updated.delete(key);
            this._render();
            this.marks.markPresetSeen(key, this.data.rev[key])
                .catch((e) => console.warn('[ILAP] list dot not stored:', e));
            const add = toAdd && this.drawer.querySelector(`.list-row[data-key="${CSS.escape(key)}"] .list-add`);
            if (add) add.focus({ preventScroll: true });
        }

        // A dot's tip shows over its row, or under it where the block has too
        // little room over the row (its top rows).
        _placeDotTip(dot) {
            const tip = dot.querySelector('.list-dot-tip');
            const row = dot.closest('.list-row');
            const inner = this.drawer.firstElementChild;
            if (!tip || !row || !inner) return;
            const room = row.getBoundingClientRect().top - inner.getBoundingClientRect().top;
            tip.classList.toggle('below', room < tip.getBoundingClientRect().height + 4);
        }

        // A message gone with the redraw is put back at the pane's foot and
        // folds away as it fades, as it came in.
        _foldMsg(pane, el) {
            if (reduceMotion() || !el.animate) return;
            // Folding already: back in its place, its motion goes on.
            if (el.classList.contains('leaving')) { pane.appendChild(el); return; }
            el.classList.add('kept', 'leaving');
            pane.appendChild(el);
            const h = el.getBoundingClientRect().height;
            el.animate([
                { height: h + 'px', paddingTop: getComputedStyle(el).paddingTop, opacity: 1 },
                { height: '0px', paddingTop: '0px', opacity: 0 },
            ], { duration: 200, easing: 'ease-in' }).finished.catch(() => {}).then(() => el.remove());
        }

        _yearsOpen() {
            const list = this.drawer && this.drawer.querySelector('.ai-years');
            return !!list && list.classList.contains('open');
        }

        // The AI row and where its year button stands in it, in an open drawer.
        _yearBox() {
            const row = this.isOpen && this.panes.ai && this.panes.ai.querySelector('.ai-row');
            const btn = row && row.querySelector('.ai-year');
            if (!btn) return null;
            const r = row.getBoundingClientRect(), b = btn.getBoundingClientRect();
            return { row, btn, h: r.height, x: b.left - r.left, y: b.top - r.top };
        }

        // A year that no longer fits beside the name wraps under it (popup.css),
        // and one that fits again comes back up. The redraw would jump there, so
        // the row grows or shrinks to its new height and the button flies from
        // its old place into the new one.
        _moveYear(was) {
            const now = this._yearBox();
            if (!was || !now || was.y === now.y || !now.row.animate || reduceMotion()) return;
            const timing = { duration: 220, easing: 'ease' };
            now.row.animate([{ height: was.h + 'px' }, { height: now.h + 'px' }], timing);
            now.btn.animate([{ transform: `translate(${was.x - now.x}px, ${was.y - now.y}px)` }, { transform: 'none' }], timing);
        }

        // The year list under its button, against its right edge, at least
        // as wide. Its box goes no lower than the block's bottom and
        // scrolls past that, so the block never grows for it.
        _placeYears() {
            const list = this.drawer.querySelector('.ai-years');
            const box = list && list.querySelector('.ai-years-box');
            const year = this.drawer.querySelector('.ai-year');
            const inner = this.drawer.firstElementChild;
            if (!box || !year || !inner) return;
            const p = this.panes.ai.getBoundingClientRect();
            const y = year.getBoundingClientRect();
            const top = y.bottom + 4;
            list.style.top = (top - p.top) + 'px';
            list.style.right = (p.right - y.right) + 'px';
            list.style.minWidth = y.width + 'px';
            const floor = inner.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(inner).borderBottomWidth) || 0) - 6;
            box.style.maxHeight = Math.max(48, floor - top) + 'px';
        }

        // The year list unfolds as it fades in, and back (popup.css .ai-years).
        // It opens scrolled to the picked year.
        _showYears(open) {
            const list = this.drawer && this.drawer.querySelector('.ai-years');
            const year = this.drawer && this.drawer.querySelector('.ai-year');
            if (!list || !year) return;
            if (open) this._placeYears();
            list.classList.toggle('open', open);
            year.setAttribute('aria-expanded', String(open));
            if (open) {
                const sel = list.querySelector('.ai-opt.selected');
                const box = list.querySelector('.ai-years-box');
                if (sel && box) box.scrollTop = sel.offsetTop - box.offsetTop - (box.clientHeight - sel.offsetHeight) / 2;
                if (sel) sel.focus({ preventScroll: true });
            }
        }

        _pickYear(bucket) {
            if (!bucket || bucket === this.bucket) { this._showYears(false); return; }
            this.bucket = bucket;
            this.msg.ai = '';
            this._render();
            // The redrawn list is laid out open first, so the shut is a transition.
            const list = this.drawer.querySelector('.ai-years');
            if (list) list.getBoundingClientRect();
            this._showYears(false);
            const year = this.drawer.querySelector('.ai-year');
            if (year) year.focus({ preventScroll: true });
        }

        // A list just added: a copy of its row shrinks into the job count on
        // the queue's icon, speeding up as it goes, the way a window minimizes into the
        // taskbar. The copy is an inert picture (its attributes stripped, so
        // nothing finds or answers it) laid in the shell, out of reach.
        // Resolves once it has landed.
        _flyToQueue(row, from) {
            return this.opts.flyToQueue ? this.opts.flyToQueue(row, from) : Promise.resolve();
        }

        async _stage(name, key) {
            // The extension went off while the drawer was open: it takes no new jobs.
            if (this.masterOff || !this.data || this._staging.has(key)) return;
            const row = this.panes[name].querySelector(`.list-row[data-key="${CSS.escape(key)}"]`);
            const from = row && row.getBoundingClientRect();
            const copy = row && row.cloneNode(true);
            const appids = this._appids(key);
            this._staging.add(key);
            this.msg[name] = '';
            const btn = row && row.querySelector('.list-add');
            if (btn) btn.disabled = true;
            const release = this.opts.holdCount();
            let outcome = null;
            try {
                outcome = await this.store.stagePreset(key, appids, this._rev(key));
            } catch (e) {
                console.warn('[ILAP] built-in list staging failed:', e);
            }
            const added = !!outcome && outcome.kind === 'added';
            if (added) await this._flyToQueue(copy, from);
            release(added);
            this._staging.delete(key);
            if (outcome && outcome.kind === 'full') this.msg[name] = t('undo_msg_full');
            await this.refresh().catch((e) => console.warn('[ILAP] built-in lists unavailable:', e));
        }
    }

    window.ILAP_Presets = { create: (root, opts) => new ListPanes(root, opts), label };

})();
