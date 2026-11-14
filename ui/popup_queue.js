// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The ignore queue in the popup/widget: a drawer that the extension's icon
    // in the header slides out of the panel's left side, against its top. It
    // renders from a storage snapshot: the job records, the per-job cursor keys
    // for progress, and the live lease for "running". The icon wears the job
    // count and a ring of the queue's progress. An empty queue shows a hint
    // that says where jobs come from, and the icon neither. What a strip says is
    // popup_queue_rows.js's.

    const t = window.ILAP.t;

    const esc = window.ILAP.Sanitizer.escapeHTML;

    // The empty queue's hint names the lists button by its glyph (ui/icons.js).
    const ICON_PRESETS = window.ILAP_Icons.PRESETS;

    // Makes `from` match `to` in place, node by node: an equal node is left as
    // it is, a node of another kind is swapped for its twin, an element of the
    // same tag takes the twin's attributes and the same pass over its children.
    function morph(from, to) {
        if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) { from.replaceWith(to); return; }
        if (from.nodeType === Node.TEXT_NODE) { if (from.data !== to.data) from.data = to.data; return; }
        if (from.nodeType !== Node.ELEMENT_NODE || from.isEqualNode(to)) return;
        for (const a of Array.from(from.attributes)) if (!to.hasAttribute(a.name)) from.removeAttribute(a.name);
        for (const a of Array.from(to.attributes)) if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
        const was = Array.from(from.childNodes);
        const next = Array.from(to.childNodes);
        next.forEach((n, i) => { if (i < was.length) morph(was[i], n); else from.appendChild(n); });
        was.slice(next.length).forEach(n => n.remove());
    }

    const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // A height change of the open drawer's block.
    const RESIZE_MS = 260;
    // A removed job's strip folding away, and the window's edge with it (_collapseRow).
    // Near linear with soft ends, so the edge moves for the whole 300 ms: with
    // ease-in-out it barely moved for the first 130 ms and then jumped.
    const FOLD_MS = 300;
    const FOLD_EASE = 'cubic-bezier(.3, .15, .7, .85)';
    // How long a finished last strip shows its ✓ before the hint (_finishLast).
    const DONE_HOLD_MS = 700;
    // In the widget the lists' window out under the queue's keeps this much
    // of the viewport: the gap over it and a few of its rows (ListPanes._place).
    const LISTS_ROOM = 120;
    // As the lists' window stops over the viewport's bottom (popup_presets.js).
    const VIEWPORT_MARGIN = 12;

    class QueueManager {
        // Given by popup_main.js:
        //   store            src/curator/store.js
        //   settings         src/settings-schema.js
        //   rows             what a strip says (popup_queue_rows.js)
        //   presetLabel(key) a built-in list's name (popup_presets.js)
        //   currentCurator() the curator of the page this surface is on, or null
        // `opts.onToggle()`: the drawer has started to open or shut (the
        // lists' window in the widget moves out from under it or back).
        constructor(root, opts) {
            for (const dep of ['store', 'settings', 'rows', 'presetLabel', 'currentCurator']) {
                if (!opts || !opts[dep]) throw new TypeError('[ILAP] QueueManager needs opts.' + dep);
            }
            this.root = root;
            this.opts = opts;
            this.store = opts.store;
            this.settings = opts.settings;
            this.rows = opts.rows;
            this.presetLabel = opts.presetLabel;
            this.shell = root.getElementById('ilap-shell');
            this.btn = root.getElementById('queue-btn');
            this.drawer = root.getElementById('queue-drawer');
            this.inner = this.drawer && this.drawer.firstElementChild;
            this.list = root.getElementById('queue-list');
            this.chip = root.getElementById('queue-jobs-chip');
            this.badge = this.chip && this.chip.parentElement;
            this.isOpen = false;
            // The jobs show as slim strips in a small window that
            // unrolls: over the panel in the toolbar popup, out of the panel's
            // left side in the widget, over the lists' drawer if it is out.
            this.strips = !!this.drawer;
            this.beside = this.strips && !window.ILAP_Tabs.inWindow(this.drawer);
            if (this.strips && this.list) this.list.classList.add('strips');
            this._anim = null;
            this._resizeAnim = null;
            this._masterOff = false;   // as of the last render — see _onAction
            // Remove asks first: the job whose strip shows ✓ and ✕ in place of
            // Pause/Play and Remove, and the snapshot to redraw it from.
            this._confirmId = null;
            this._lastStore = null;
            // Jobs whose strips are folding away after a ✓ (_collapseRow).
            this._leaving = new Set();
            // The fold of strips under way (_foldRows), or null.
            this._folding = null;
            // The job count held at its old number, and the number it waits to show.
            this._countHeld = false;
            this._heldCount = null;
            // Delegated handlers — the list HTML is rebuilt on every render.
            if (this.list) {
                this.list.addEventListener('click', (e) => this._onAction(e));
                // A held Enter's auto-repeat presses no job button again.
                this.list.addEventListener('keydown', (e) => {
                    if (e.repeat && e.key === 'Enter' && e.target.closest('.queue-act')) e.preventDefault();
                });
                // A double click on a curator's filter square opens the curator.
                this.list.addEventListener('dblclick', (e) => this._openCurator(e));
                // A name shows whole on hover only where it was cut. Judged at
                // hover time: the widget renders while its panel is hidden, when
                // nothing has a width yet.
                this.list.addEventListener('mouseover', (e) => {
                    const box = e.target.closest && e.target.closest('.queue-job-namebox');
                    if (!box) return;
                    const name = box.querySelector('.queue-job-name');
                    box.classList.toggle('is-cut', !!name && name.scrollWidth > name.clientWidth);
                });
            }
            if (this.btn) {
                // Opened from the keyboard (a click with no pointer, detail 0),
                // the drawer takes the focus: it sits before the panel in the
                // tab order, out of reach of a Tab from the icon.
                this.btn.addEventListener('click', (e) => {
                    if (!e.isTrusted) return;
                    const byKey = e.detail === 0;
                    this.toggle(!this.isOpen).then(() => {
                        const first = byKey && this.isOpen && this.drawer.querySelector('button:not([disabled])');
                        if (first) first.focus({ preventScroll: true });
                    });
                });
            }
            // Escape shuts the drawer and hands focus back to the icon.
            if (this.drawer) {
                this.drawer.addEventListener('keydown', (e) => {
                    if (e.key !== 'Escape' || !this.isOpen) return;
                    e.stopPropagation();
                    this.toggle(false);
                    if (this.btn) this.btn.focus();
                });
            }
            // In the toolbar popup the panel dims and blurs under the open
            // queue (popup.css #ilap-shell::after), and a click on it shuts the
            // queue and reaches nothing under it.
            if (this.shell && this.strips && !this.beside) {
                this.shell.addEventListener('click', (e) => {
                    if (e.isTrusted && e.target === this.shell && this.isOpen) this.toggle(false);
                });
            }
        }

        // The panel under the dim, all but its header, out of reach while the
        // queue is over it in the toolbar popup: Tab went on into it, its focus
        // drawn under the dim (Section 508). Beside the widget's panel nothing is dimmed.
        _dimInert(on) {
            const root = this.shell && this.shell.querySelector('#popup-root');
            if (!root || this.beside) return;
            for (const el of root.children) if (el.tagName !== 'H3') el.inert = on;
        }

        async toggle(open) {
            if (!this.drawer || open === this.isOpen) return;
            this.isOpen = open;
            if (this.btn) this.btn.setAttribute('aria-expanded', String(open));
            if (this.shell) this.shell.classList.toggle('queue-open', open);
            this._dimInert(open);
            // Opening, the block is placed before this returns, so the lists can measure it.
            const slid = window.ILAP_Tabs.slideDrawer(this.drawer, open, this, open ? () => this._place() : null,
                this.beside ? 'unroll-left' : 'unroll');
            if (this.opts.onToggle) this.opts.onToggle();
            await slid;
        }

        // The block's lower edge in the viewport while it is out beside the
        // widget's panel, null otherwise.
        foot() {
            return this.isOpen && this.beside && this.inner ? this.inner.getBoundingClientRect().bottom : null;
        }

        // Shut at once, unanimated: the widget's panel opening again after a
        // click elsewhere on the page hid it.
        shutNow() {
            if (!this.drawer || !this.isOpen) return;
            this.isOpen = false;
            if (this._anim) { this._anim.cancel(); this._anim = null; }
            this.drawer.classList.remove('open', 'shown', 'sliding');
            if (this.shell) this.shell.classList.remove('queue-open');
            this._dimInert(false);
            if (this.btn) this.btn.setAttribute('aria-expanded', 'false');
        }

        // In the toolbar popup the block's top is under the header, so the
        // icon stays in view, and its foot no lower than 8px over the
        // window's bottom: three strips fit, more scroll inside. The dimmed
        // panel starts at the same line. In the widget its right edge meets
        // the panel's left one, its top level with the panel's, never higher,
        // and it is no taller than the panel. With the lists out it leaves
        // them LISTS_ROOM over the viewport's bottom.
        _place() {
            const header = this.root.querySelector('#popup-root > h3');
            const shell = this.root.getElementById('ilap-shell');
            const panel = this.root.getElementById('popup-root');
            if (!this.strips || !this.inner || !header || !shell || !panel) return;
            if (this.beside) {
                this.drawer.style.top = '0px';
                this.drawer.style.right = panel.offsetWidth + 'px';
                const lists = this.root.getElementById('lists-drawer');
                const room = lists && lists.classList.contains('open')
                    ? window.innerHeight - VIEWPORT_MARGIN - LISTS_ROOM - shell.getBoundingClientRect().top : Infinity;
                this.inner.style.maxHeight = Math.max(0, Math.min(panel.offsetHeight, room)) + 'px';
                return;
            }
            const s = shell.getBoundingClientRect();
            const top = header.getBoundingClientRect().bottom - s.top;
            shell.style.setProperty('--queue-top', top + 'px');
            this.drawer.style.top = top + 'px';
            this.inner.style.maxHeight = Math.max(0, s.height - top - 8) + 'px';
        }

        // Runs `mutate` and grows or shrinks the open drawer's block from its
        // height before to its height after, so a strip that comes or goes
        // moves the block's edge smoothly. The block clips while it moves, so
        // no scrollbar shows on the way.
        resize(mutate) {
            const box = this.inner;
            if (!box || !this.isOpen) { mutate(); return; }
            const from = box.getBoundingClientRect().height;
            if (this._resizeAnim) this._resizeAnim.cancel();
            mutate();
            const to = box.getBoundingClientRect().height;
            if (from === to || reduceMotion() || !box.animate) return;
            box.classList.add('moving');
            const anim = this._resizeAnim = box.animate([{ height: from + 'px' }, { height: to + 'px' }],
                { duration: RESIZE_MS, easing: 'ease' });
            anim.finished.catch(() => {}).then(() => {
                if (anim !== this._resizeAnim) return;
                this._resizeAnim = null;
                box.classList.remove('moving');
            });
        }

        // Pause/Resume flips the stored user intent (paused ↔ pending — 'running'
        // is never stored); Remove asks for a ✓ (drops the job) or a ✕ (keeps it).
        // The writes go through Store's serialized queue writers, so a click here
        // can't interleave with a concurrent queue write in the same context.
        //
        // With the extension OFF only Remove works. Pause renders `disabled`; the
        // guard below also covers a master flip between that render and the click.
        _onAction(e) {
            if (!e.isTrusted) return; // real clicks only — not page-synthesized events
            const btn = e.target.closest('.queue-act');
            if (!btn) return;
            const id = btn.dataset.jobId;
            const act = btn.dataset.act;
            // Nothing awaits a click: in the widget, a rejected storage write (an
            // extension update) ends here as one warn line.
            const swallow = (e) => console.warn('[ILAP] queue action failed:', e);
            if (act === 'remove' || act === 'cancel') {
                this._confirmId = act === 'remove' ? id : null;
                this.render(this._lastStore);
            } else if (act === 'confirm') {
                this._confirmId = null;
                this._foldRows([btn.closest('.queue-job')])
                    .then(() => this.store.removeJob(id))
                    .catch(swallow)
                    .finally(() => this._leaving.delete(id));
            } else if (act === 'pause' && !this._masterOff) {
                this.store.updateJob(id, (j) => ({ status: j.status === 'paused' ? 'pending' : 'paused' }))
                    .catch(swallow);
            }
        }

        // The badge leaves the icon while the queue is empty.
        _setCount(n) {
            if (this._countHeld) { this._heldCount = n; return; }
            if (this.chip) this.chip.textContent = n;
            if (this.btn) this.btn.classList.toggle('is-empty', !n);
        }

        // The count's outline: the share of the queue's games done, over the
        // jobs that have a total (a gesture job's total moves as it fills).
        // Green while a job runs. With every job paused, a yellow dot stands
        // in for the count and its outline (popup.css).
        _setRing(jobs, store, running, paused) {
            if (!this.btn) return;
            let done = 0, total = 0;
            jobs.forEach((j) => {
                if (this.rows.isGesture(j) || !(j.total > 0)) return;
                total += j.total;
                done += Math.min(this.rows.doneOf(j, store), j.total);
            });
            const ring = total ? done / total * 100 : 0;
            this.btn.style.setProperty('--ring', total ? ring.toFixed(1) : '0');
            this.btn.style.setProperty('--ring-gap', (100 - ring).toFixed(1));
            this.btn.classList.toggle('has-running', running);
            this.btn.classList.toggle('all-paused', !!paused);
        }

        // A copy of what was just queued (a list's row, an undo menu's row)
        // shrinks into the job count, speeding up as it goes, the way a window
        // minimizes into the taskbar. `row` is the copy, `from` where the
        // original stood. Its attributes but class, value and style (the look
        // a copy takes along, popup_undo.js _takeRow) are stripped, so it is
        // an inert picture.
        flyIn(row, from) {
            const host = this.shell;
            const target = this.chip;
            if (reduceMotion() || !host || !target || !row || !from || !from.width) return Promise.resolve();
            const to = target.getBoundingClientRect();
            const h = host.getBoundingClientRect();
            for (const el of [row, ...row.querySelectorAll('*')]) {
                for (const { name } of [...el.attributes]) if (name !== 'class' && name !== 'value' && name !== 'style') el.removeAttribute(name);
            }
            const ghost = document.createElement('div');
            ghost.className = 'list-ghost';
            // A copied button is still a button: inert keeps it out of the Tab order.
            ghost.inert = true;
            ghost.appendChild(row);
            Object.assign(ghost.style, {
                left: (from.left - h.left) + 'px', top: (from.top - h.top) + 'px',
                width: from.width + 'px', height: from.height + 'px',
            });
            host.appendChild(ghost);
            if (!ghost.animate) { ghost.remove(); return Promise.resolve(); }
            const sx = to.width / from.width, sy = to.height / from.height;
            const dx = to.left - from.left, dy = to.top - from.top;
            return ghost.animate([
                { transform: 'none', opacity: 1 },
                { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: .3 },
            ], { duration: 450, easing: 'cubic-bezier(.55, 0, .8, .4)' }).finished
                .catch(() => {})
                .then(() => ghost.remove());
        }

        // What was queued flies into the job count (flyIn): the count keeps its
        // old number while it flies. The returned release shows the new one,
        // with a pop when it has landed.
        holdCount() {
            this._countHeld = true;
            return (landed) => {
                this._countHeld = false;
                if (this._heldCount !== null) this._setCount(this._heldCount);
                this._heldCount = null;
                if (landed && this.badge && this.badge.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                    this.badge.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }],
                        { duration: 320, easing: 'ease-out' });
                }
            };
        }

        // Strips fold away before the list is drawn without them: a ✓ here, or
        // a job gone from the queue by another tab, the curator page's menu or
        // the drainer. A render meanwhile waits for the fold and is drawn at its
        // end, from the latest snapshot. `after` runs once that render has
        // taken the strips out.
        _foldRows(rows, after) {
            const done = Promise.all(rows.map(r => this._collapseRow(r, r && r.dataset.jobId)));
            const fold = this._folding = Promise.all([this._folding, done]).finally(() => {
                if (this._folding === fold) {
                    this._folding = null;
                    this.render(this._lastStore);
                }
                if (after) after();
            });
            return done;
        }

        // A removed job's strip folds away: its height, padding and the gap
        // next to it shrink to nothing as it fades. A render meanwhile leaves
        // the job out, so it never pops back.
        _collapseRow(row, id) {
            this._leaving.add(id);
            if (!row || !row.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                return Promise.resolve();
            }
            const gap = '-' + (parseFloat(getComputedStyle(this.list).rowGap) || 0) + 'px';
            const side = row.nextElementSibling ? 'marginBottom' : row.previousElementSibling ? 'marginTop' : null;
            const from = { height: row.offsetHeight + 'px', opacity: 1 };
            const to = { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px' };
            if (side) { from[side] = '0px'; to[side] = gap; }
            row.style.overflow = 'hidden';
            return row.animate([from, to], { duration: FOLD_MS, easing: FOLD_EASE, fill: 'forwards' }).finished;
        }

        // The URL is built from the job's curator id, and only a numeric one:
        // in the widget this list sits in an open shadow root on a Steam page.
        // It answers real clicks only, for the same reason.
        _openCurator(e) {
            if (!e.isTrusted) return;
            const square = e.target.closest('.queue-job-filter');
            const id = square && square.dataset.curatorId;
            if (!id || !/^\d+$/.test(id)) return;
            e.preventDefault();
            window.getSelection().removeAllRanges();
            window.open('https://store.steampowered.com/curator/' + id + '/', '_blank', 'noopener');
        }

        // `store` is a storage snapshot: the queue array plus the per-job
        // lock/cursor keys this view derives running/progress from. The current
        // curator is the page this surface is on: only the on-page widget has one,
        // the popup window's location is no curator page, so nothing is highlighted.
        render(store) {
            if (!this.list) return;
            store = store || {};
            this._lastStore = store;
            const queued = Array.isArray(store[this.store.QUEUE_KEY]) ? store[this.store.QUEUE_KEY] : [];
            // The gesture jobs (Manual ignores / un-ignores) always show at the
            // bottom, the rest in queue order. Display only: the drainer still
            // takes gesture work first (drainer.js _pickJob).
            const isGesture = (j) => this.rows.isGesture(j);
            const jobs = queued.filter(j => !isGesture(j)).concat(queued.filter(isGesture))
                .filter(j => !this._leaving.has(j.id));
            if (this._folding) return;
            // A job gone from the queue elsewhere folds its strip away first.
            if (this.list && this.isOpen && !reduceMotion()) {
                const ids = new Set(jobs.map(j => j.id));
                const gone = Array.from(this.list.children).filter(r => r.dataset.jobId
                    && !ids.has(r.dataset.jobId) && !this._leaving.has(r.dataset.jobId));
                if (gone.length) {
                    if (!jobs.length && gone.length === this.list.querySelectorAll('.queue-job').length) {
                        this._finishLast(gone);
                        return;
                    }
                    this._foldRows(gone, () => gone.forEach(r => this._leaving.delete(r.dataset.jobId)));
                    return;
                }
            }
            // From the render snapshot, so _onAction judges by what the row shows.
            this._masterOff = !this.settings.isOn(store[this.settings.KEYS.MASTER]);
            // A question about a job that is gone is dropped.
            if (!jobs.some(j => j.id === this._confirmId)) this._confirmId = null;
            // An empty queue opens without its title's bars dropping in (popup.css).
            if (this.drawer) this.drawer.classList.toggle('is-empty', !jobs.length);

            if (jobs.length === 0) {
                this._collapseEmpty();
                return;
            }

            const now = Date.now();
            const statuses = jobs.map(j => this.rows.statusOf(j, store, now));
            // Jobs at their end: one of them gone from the queue next is
            // finished, and its strip shows a ✓ (_finishLast).
            this._finished = new Set(jobs.filter(j => j.total > 0 && this.rows.doneOf(j, store) >= j.total).map(j => j.id));
            this._setRing(jobs, store, statuses.some(s => s === 'running'), statuses.every(s => s === 'paused'));
            this._setCount(jobs.length);
            const cur = this.opts.currentCurator();
            if (this.list) {
                // SW drainer halted (persistent POST failures — a stale cached
                // sessionid or a missing Steam_Language cookie). Opening any
                // store page fixes both at content-script boot, so the hint just
                // points there. Tab drainers are unaffected: with a store page
                // open the flag has already been cleared.
                const halt = store[this.store.SW_HALT_KEY]
                    ? `<div class="queue-halt-hint">${esc(t('queue_sw_halt'))}</div>`
                    : '';
                if (this.strips) this.list.style.setProperty('--qname-w', this._nameWidth() + 'px');
                const html = jobs
                    .map((j, i) => this.rows.strip(j, {
                        cur,
                        status: statuses[i],
                        cursor: this.rows.doneOf(j, store),
                        skipped: this.rows.skippedOf(j, store),
                        asking: j.id === this._confirmId,
                        masterOff: this._masterOff,
                    }))
                    .join('') + halt;
                this.resize(() => this._patchList(html));
            }
            if (window.ILAP && window.ILAP.i18n) window.ILAP.i18n.applyDom(this.list);
        }

        // The list takes the new HTML in place: a job still in the queue keeps
        // its strip's elements, and only what differs is changed. A rebuilt
        // strip would start unhovered on every drain tick, so a tooltip under
        // the pointer would wait out its delay again, an open bar would run its
        // stretch again and ✓ ✕ would pop in again. A new strip in the open
        // queue fades in as the list makes room for it. The halt hint is kept
        // the same way, by its class, so it fades in only once.
        _patchList(html) {
            const tmp = document.createElement('div');
            tmp.innerHTML = html;
            const key = (r) => r.dataset.jobId || r.className;
            const old = new Map(Array.from(this.list.children).map(r => [key(r), r]));
            const added = [];
            const rows = Array.from(tmp.children).map((fresh) => {
                const kept = old.get(key(fresh));
                if (!kept) { added.push(fresh); return fresh; }
                // A strip that keeps running keeps its sheen delay, since a new
                // one would make the sweep jump.
                if (kept.classList.contains('running') && fresh.classList.contains('running')) {
                    fresh.style.animationDelay = kept.style.animationDelay;
                }
                // Set on hover (see the constructor), absent from the new HTML.
                const cut = kept.querySelector('.queue-job-namebox.is-cut');
                const freshBox = fresh.querySelector('.queue-job-namebox');
                if (cut && freshBox) freshBox.classList.add('is-cut');
                morph(kept, fresh);
                return kept;
            });
            const keep = new Set(rows);
            Array.from(this.list.childNodes).forEach(n => { if (!keep.has(n)) n.remove(); });
            // A kept strip already in its place is not moved: a move would
            // restart its animations as well.
            rows.forEach((r, i) => {
                const at = this.list.children[i] || null;
                if (r !== at) this.list.insertBefore(r, at);
            });
            if (!this.isOpen || reduceMotion()) return;
            for (const r of added) if (r.animate) r.animate([{ opacity: 0 }, { opacity: 1 }], { duration: RESIZE_MS, easing: 'ease' });
        }

        // The queue emptied: the strips give way to the hint, and the panel's
        // height follows. Drawn again every time, for a change of language.
        _collapseEmpty() {
            this._setRing([], {}, false);
            this.resize(() => this._markEmpty());
        }

        // The queue's last strip left it by the drainer or another tab. The
        // strip stays where it is: a finished one empties and shows a ✓ for a
        // moment, then it fades and the hint fades in in its place. The hint
        // keeps the strip's height at least, so the block never shrinks here.
        // A render meanwhile waits, as for a fold.
        _finishLast(rows) {
            // Nothing runs any more: the button's barber pole fades out now. Its
            // count, ring and paused dot go with the hint, so a paused dot does
            // not give way to the count for a moment first.
            if (this.btn) this.btn.classList.remove('has-running');
            rows.forEach(r => this._leaving.add(r.dataset.jobId));
            const finished = rows.some(r => this._finished && this._finished.has(r.dataset.jobId));
            const first = rows[0], last = rows[rows.length - 1];
            const height = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top;
            const fade = (el, a, b) => el.animate([{ opacity: a }, { opacity: b }],
                { duration: 250, easing: 'ease', fill: 'forwards' }).finished;
            const wait = (ms) => new Promise(res => setTimeout(res, ms));
            let step = Promise.resolve();
            if (finished) {
                rows.forEach((r) => {
                    r.insertAdjacentHTML('beforeend', `<span class="queue-done-check">${window.ILAP_Icons.CHECK}</span>`);
                    r.classList.add('is-done');
                });
                step = wait(250 + DONE_HOLD_MS);
            }
            const fold = this._folding = step
                .then(() => Promise.all(rows.map(r => fade(r, 1, 0))))
                .then(() => {
                    this.resize(() => this._markEmpty(height));
                    const hint = this.list.querySelector('.queue-empty-hint');
                    return hint && fade(hint, 0, 1);
                })
                .catch(() => {})
                .finally(() => {
                    rows.forEach(r => this._leaving.delete(r.dataset.jobId));
                    if (this._folding === fold) {
                        this._folding = null;
                        this.render(this._lastStore);
                    }
                });
        }

        // Where jobs come from: a curator's page, or the lists button.
        // Escaped with a stand-in for the icon, which then becomes the glyph.
        // `keep` is the height of the strip the hint takes the place of
        // (_finishLast). A hint drawn again keeps the height the old one had.
        _markEmpty(keep) {
            this._setCount(0);
            if (this.list) {
                const was = this.list.querySelector('.queue-empty-hint');
                const min = keep ? keep + 'px' : (was ? was.style.minHeight : '');
                const text = esc(t('queue_empty_hint', { icon: '\u0001' }));
                this.list.innerHTML = `<div class="queue-empty-hint">${text.replace('\u0001',
                    `<span class="queue-empty-icon">${ICON_PRESETS}</span>`)}</div>`;
                if (min) this.list.firstElementChild.style.minHeight = min;
            }
        }

        // The strips' name column: as wide as this year's AI list name in the
        // panel's language, the longest name a built-in list gives a job.
        _nameWidth() {
            this._ctx = this._ctx || document.createElement('canvas').getContext('2d');
            this._ctx.font = '700 12px ' + getComputedStyle(this.list).fontFamily;
            const sample = this.presetLabel('ai_' + new Date().getFullYear());
            return Math.ceil(this._ctx.measureText(sample).width) + 1;
        }

    }

    window.ILAP_Queue = { create: (root, opts) => new QueueManager(root, opts) };

})();
