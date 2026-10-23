// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The ignore queue applet in the popup/widget. It renders from a storage
    // snapshot: the job records, the per-job cursor keys for progress, and the
    // live lease for "running". Kept while the queue is empty (.is-empty), for
    // the built-in lists icon on its bar: it shows 0 and opens on a hint.

    const t = window.ILAP.t;

    const esc = window.ILAP.Sanitizer.escapeHTML;
    const Store = window.ILAP.Curator.Store;
    const Lease = window.ILAP.Curator.Lease;
    const Settings = window.ILAP.Settings;

    // Filter labels and colours and the curator-page parser, shared with the
    // curator button (src/curator/filters.js).
    const Filters = window.ILAP_Filters;

    // No 'done' state: finished jobs are removed from the queue (the drainer emits
    // a completion pulse for the widget blink instead of leaving a record behind).
    const STATUS_LABELS = {
        enumerating: 'queue_status_enumerating',
        pending: 'queue_status_pending',
        running: 'queue_status_running',
        paused: 'queue_status_paused'
    };

    // Running → lime, and a job waiting its turn the same (the running one is
    // told apart by its sheen), paused → yellow.
    // Enumerating is a transient "fetching the list" state → Spared blue. The done part of the strip's mini bar (or a
    // gesture job's count) wears it; the part still to go is pale.
    const STATUS_COLORS = {
        enumerating: '#66c0f4',
        pending: '#48ff00',
        running: '#48ff00',
        paused: '#fff44f'
    };

    // Duration of the smooth "collapse on completion" — matches the .5s on
    // .solo-collapse over ::details-content in popup.css (see _collapseEmpty).
    const COLLAPSE_MS = 500;

    // One sweep of the running strip's sheen — matches the 2.4s on
    // .queue-job.running in popup.css. Every render rebuilds the strips, which
    // would restart the sweep on each progress tick, so a running strip is
    // started at the phase of a shared clock (a negative animation-delay) and
    // the rebuilt one picks the sweep up where the old one was.
    const SHEEN_MS = 2400;

    // Curator id of the page this surface is rendered on (only matches in the on-page
    // widget; the popup window's location isn't a curator page → null → no highlight).
    // Shared parser (src/curator/filters.js) so this and main.js agree.
    const currentCuratorId = () => Filters.curatorIdFromPath(location.pathname);

    // Inline icons (inherit the button colour via currentColor, ui/icons.js).
    const { PAUSE: ICON_PAUSE, PLAY: ICON_PLAY, TRASH: ICON_TRASH, PRESETS: ICON_PRESETS, LIST: ICON_LIST,
        BUNDLE: ICON_BUNDLE } = window.ILAP_Icons;
    // An un-ignore job's glyph: the Undo button's turning arrow, in green, drawn
    // bold (a stroke of its own colour around the shape).
    const ICON_UNDO = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="#4fd64f" stroke="#4fd64f" stroke-width="1.6" stroke-linejoin="round" d="M12 5V1.8L6.5 6.5 12 11.2V8c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8z"/></svg>';
    // A job waiting its turn: a white clock in the ⚠ slot.
    const ICON_CLOCK = '<svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.4"/><path d="M6 3.4V6l1.8 1.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    // The Remove confirmation's two answers: bare Unicode marks in bold, drawn only here.
    const ICON_CHECK = '<span aria-hidden="true">✓</span>';
    const ICON_CROSS = '<span aria-hidden="true">✕</span>';

    // Row names of the job types that have no curator to name them. Null-prototype
    // because the key is a job's stored `type`: an unknown one must fall through
    // to the record's own name (see _row), which a prototype hit would take away.
    const JOB_NAME_KEYS = Object.assign(Object.create(null), {
        [Store.JOB_TYPE.UNDO]: 'undo_job_name',
        [Store.JOB_TYPE.MI]: 'mi_job_name',
        [Store.JOB_TYPE.MIUNDO]: 'miundo_job_name',
    });

    class QueueManager {
        constructor(root) {
            this.root = root;
            this.accordion = root.getElementById('queue-accordion');
            this.list = root.getElementById('queue-list');
            this.chip = root.getElementById('queue-jobs-chip');
            this._closeTimer = null;   // "collapse on completion" timer
            this._masterOff = false;   // as of the last render — see _onAction
            // Remove asks first: the job whose strip shows ✓ and ✕ in place of
            // Pause/Play and Remove, and the snapshot to redraw it from.
            this._confirmId = null;
            this._lastStore = null;
            // Jobs whose strips are folding away after a ✓ (_collapseRow).
            this._leaving = new Set();
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
                this._collapseRow(btn.closest('.queue-job'), id)
                    .then(() => Store.removeJob(id))
                    .catch(swallow)
                    .finally(() => this._leaving.delete(id));
            } else if (act === 'pause' && !this._masterOff) {
                Store.updateJob(id, (j) => ({ status: j.status === 'paused' ? 'pending' : 'paused' }))
                    .catch(swallow);
            }
        }

        _setCount(n) {
            if (this._countHeld) { this._heldCount = n; return; }
            if (this.chip) this.chip.textContent = n;
        }

        // A list added from the lists menu flies into the job count
        // (popup_presets.js _flyToQueue): the count keeps its old number while
        // it flies. The returned release shows the new one, with a pop when
        // the list has landed.
        holdCount() {
            this._countHeld = true;
            return (landed) => {
                this._countHeld = false;
                if (this._heldCount !== null) this._setCount(this._heldCount);
                this._heldCount = null;
                if (landed && this.chip && this.chip.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                    this.chip.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }],
                        { duration: 320, easing: 'ease-out' });
                }
            };
        }

        // A removed job's strip folds away before the job leaves the queue: its
        // height, padding and the gap next to it shrink to nothing as it fades.
        // A render meanwhile leaves the job out, so it never pops back.
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
            return row.animate([from, to], { duration: 260, easing: 'ease-in-out', fill: 'forwards' }).finished;
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
        // lock/cursor keys this view derives running/progress from.
        render(store) {
            if (!this.accordion) return;
            store = store || {};
            this._lastStore = store;
            const queued = Array.isArray(store[Store.QUEUE_KEY]) ? store[Store.QUEUE_KEY] : [];
            // The gesture jobs (Manual ignores / un-ignores) always show at the
            // bottom, the rest in queue order. Display only: the drainer still
            // takes gesture work first (drainer.js _pickJob).
            const isGesture = (j) => { const tr = Store.jobTraits(j); return !!tr && tr.gesture; };
            const jobs = queued.filter(j => !isGesture(j)).concat(queued.filter(isGesture))
                .filter(j => !this._leaving.has(j.id));
            // From the render snapshot, so _onAction judges by what the row shows.
            // The lists icon reads the class: an extension that is off takes no
            // new jobs, for the same reason Pause is dead.
            this._masterOff = !Settings.isOn(store[Settings.KEYS.MASTER]);
            this.accordion.classList.toggle('master-off', this._masterOff);
            // A question about a job that is gone is dropped.
            if (!jobs.some(j => j.id === this._confirmId)) this._confirmId = null;

            if (jobs.length === 0) {
                this._collapseEmpty();
                return;
            }

            // A job exists again — cancel a still-running "collapse on completion"
            // so a freshly staged job isn't emptied out from under the user.
            if (this._closeTimer) {
                clearTimeout(this._closeTimer);
                this._closeTimer = null;
                this.accordion.classList.remove('solo-collapse');
            }

            this.accordion.classList.remove('is-empty');
            const now = Date.now();
            const statuses = jobs.map(j => this._effectiveStatus(j, store, now));
            // Barber-pole indicator while any job is actively ignoring.
            this.accordion.classList.toggle('has-running', statuses.some(s => s === 'running'));
            this._setCount(jobs.length);
            const cur = currentCuratorId();
            if (this.list) {
                // SW drainer halted (persistent POST failures — a stale cached
                // sessionid or a missing Steam_Language cookie). Opening any
                // store page fixes both at content-script boot, so the hint just
                // points there. Tab drainers are unaffected: with a store page
                // open the flag has already been cleared.
                const halt = store[Store.SW_HALT_KEY]
                    ? `<div class="queue-halt-hint">${esc(t('queue_sw_halt'))}</div>`
                    : '';
                this.list.style.setProperty('--qname-w', this._nameWidth() + 'px');
                const html = jobs
                    .map((j, i) => this._row(j, cur, statuses[i], this._done(j, store),
                        this._skipped(j, store)))
                    .join('') + halt;
                if (!this._patchOpenBar(html)) this.list.innerHTML = html;
            }
            if (window.ILAP && window.ILAP.i18n) window.ILAP.i18n.applyDom(this.list);
        }

        // A bar under the pointer stays the same element through a render: a
        // rebuilt one would start unhovered and run its stretch and its count's
        // delay again on every drain tick. Its strip keeps the row, the line, the
        // name-and-bar box and the bar. The bar takes the new fill and numbers,
        // everything else in the list comes fresh. False when no bar is open or
        // its job is gone, for a plain rebuild.
        _patchOpenBar(html) {
            const bar = this.list.querySelector('.queue-mini:hover');
            const row = bar && bar.closest('.queue-job');
            if (!row) return false;
            const tmp = document.createElement('div');
            tmp.innerHTML = html;
            const fresh = Array.from(tmp.children).find(r => r.dataset.jobId === row.dataset.jobId);
            const freshBar = fresh && fresh.querySelector('.queue-mini');
            if (!freshBar) return false;
            // Puts `twin`'s siblings in `parent` around `kept`, in place of its own.
            const swapAround = (parent, kept, twin) => {
                const nodes = Array.from(twin.parentNode.childNodes);
                const at = nodes.indexOf(twin);
                Array.from(parent.childNodes).forEach(n => { if (n !== kept) n.remove(); });
                kept.before(...nodes.slice(0, at));
                kept.after(...nodes.slice(at + 1));
            };
            const area = bar.parentNode;
            const freshArea = freshBar.parentNode;
            swapAround(area, bar, freshBar);
            swapAround(area.parentNode, area, freshArea);
            swapAround(this.list, row, fresh);
            row.className = fresh.className;
            row.style.cssText = fresh.style.cssText;
            for (const a of ['aria-valuemax', 'aria-valuenow', 'aria-label']) bar.setAttribute(a, freshBar.getAttribute(a));
            bar.querySelector('.queue-mini-fill').style.cssText = freshBar.querySelector('.queue-mini-fill').style.cssText;
            const num = bar.querySelector('.queue-mini-num').children;
            Array.from(freshBar.querySelector('.queue-mini-num').children).forEach((s, i) => { num[i].textContent = s.textContent; });
            return true;
        }

        // The queue emptied. If the applet was OPEN (the user was watching a job
        // that just finished) — collapse it with the same smooth, content-preserving
        // animation as a manual "solo" close (the .solo-collapse class over
        // ::details-content) and swap in the empty hint only after it ends, rather
        // than snapping shut. A closed applet, or one the user opened on the
        // hint, gets the hint at once (again on a relabel) and stays as it is.
        _collapseEmpty() {
            if (this._closeTimer) return;                 // animation already running
            this.accordion.classList.remove('has-running');
            if (this.accordion.classList.contains('is-empty') || !this.accordion.open) {
                this._markEmpty();
                return;
            }
            this.accordion.classList.add('solo-collapse');
            this.accordion.open = false;
            this._closeTimer = setTimeout(() => {
                this._closeTimer = null;
                this._markEmpty();
                this.accordion.classList.remove('solo-collapse');
            }, COLLAPSE_MS);
        }

        // Where jobs come from: a curator's page, or the lists icon on this bar.
        // Escaped with a stand-in for the icon, which then becomes the glyph.
        _markEmpty() {
            this.accordion.classList.add('is-empty');
            this._setCount(0);
            if (this.list) {
                const text = esc(t('queue_empty_hint', { icon: '\u0001' }));
                this.list.innerHTML = `<div class="queue-empty-hint">${text.replace('\u0001',
                    `<span class="queue-empty-icon">${ICON_PRESETS}</span>`)}</div>`;
            }
        }

        // The name column: as wide as a built-in list's job name ("AI games 2026")
        // in this language, so that one always shows whole, a longer name is cut
        // to it, and every strip's mini bar starts at the same place. Measured off
        // a canvas: it needs a font, not a laid-out element.
        _nameWidth() {
            this._ctx = this._ctx || document.createElement('canvas').getContext('2d');
            this._ctx.font = '700 12px ' + getComputedStyle(this.list).fontFamily;
            const sample = window.ILAP_Presets.label('ai_' + new Date().getFullYear());
            return Math.ceil(this._ctx.measureText(sample).width) + 1;
        }

        // An undo job's name with what it was staged for (UndoService): the last
        // N games, or the last N hours or days. A job staged before the scope
        // was kept has none and takes the plain name.
        _undoScopeName(scope) {
            const n = scope && Number(scope.n);
            if (!(n > 0)) return '';
            const key = scope.unit === 'h' ? 'undo_job_hours' : scope.unit === 'd' ? 'undo_job_days' : 'undo_job_last';
            return t(key, { n });
        }

        // Stored status carries only user intent ('enumerating'/'paused', else
        // drainable). "Running" is derived: a drainable job whose drain lease is
        // live IS being drained by some tab right now. The lease is the curator's,
        // so of a curator's two jobs only the one it names runs (a lock with no
        // jobId is from an older build).
        _effectiveStatus(job, store, now) {
            if (job.status === 'enumerating' || job.status === 'paused') return job.status;
            const lock = store[Lease.LOCK_PREFIX + job.curatorId];
            const live = lock && (lock.expiresAt || 0) > now && (!lock.jobId || lock.jobId === job.id);
            return live ? 'running' : 'pending';
        }

        // Progress comes from the drainer-owned cursor key; legacy records
        // (pre-cursor-key) kept the cursor inline.
        _done(job, store) {
            const v = store[Store.CURSOR_PREFIX + job.id];
            return Number.isFinite(v) ? v : (job.cursor || 0);
        }

        // Appids the drainer skipped: permanently refused (region-locked), and
        // on the user's wishlist. Drainer-owned per-job keys, like the cursor.
        _skipped(job, store) {
            const n = (v) => Number.isFinite(v) ? v : 0;
            return {
                unavailable: n(store[Store.SKIPPED_PREFIX + job.id]),
                wishlisted: n(store[Store.WISHLISTED_PREFIX + job.id]),
            };
        }

        // One slim strip per job, all on one line: the name cut to the name column
        // (shown whole on hover), a mini progress bar that stretches left over the
        // name on hover, the percent, then the skips and the two actions. A job
        // from a built-in list has the lists glyph in front, a bundle its two
        // capsules, an un-ignore job the green Undo arrow, a curator's job a square in its filter's colour in
        // the same slot. Status shows as the bar's colour,
        // the action key (a quiet grey ⏸ on a job that goes, a ▶ waiting on a
        // paused one) and, while the job is actually running, a sheen sweeping
        // across its strip (.queue-job.running).
        // Remove is always there, running job or paused. A click on it asks first
        // (_confirmId): ✓ and ✕ take the two slots, so a slip never drops a job.
        // A running job's drainer finds it gone at its next batch (Store.removeJob).
        // Every type but a curator's shows a localized name. The AUTO-FILLING
        // gesture jobs swap the bar for a live remaining count (see below). A type
        // this build does not know keeps whatever name its record carries, and
        // can only be removed from here — the drainer skips it.
        _row(job, cur, effStatus, cursor, skipped) {
            const type = Store.jobType(job);
            const traits = Store.jobTraits(job);
            const isCuratorJob = type === Store.JOB_TYPE.CURATOR;
            const isPreset = type === Store.JOB_TYPE.PRESET;
            const isGesture = !!traits && traits.gesture;
            const nameKey = JOB_NAME_KEYS[type];
            const undoScope = type === Store.JOB_TYPE.UNDO ? this._undoScopeName(job.scope) : '';
            const name = undoScope
                ? esc(undoScope)
                : nameKey
                ? esc(t(nameKey))
                : isPreset
                    ? esc(window.ILAP_Presets.label(job.presetKey))
                    : esc(job.curatorName || job.curatorId || '');
            const total = job.total || 0;
            const done = Math.min(cursor, total || cursor);
            const status = esc(t(STATUS_LABELS[effStatus] || 'queue_status_pending'));
            const statusColor = STATUS_COLORS[effStatus] || STATUS_COLORS.pending;
            const isCurrent = isCuratorJob && !!cur && job.curatorId === cur;
            const pct = total > 0 ? Math.round(done / total * 100) : 0;
            const count = total > 0 ? `${done} / ${total}` : '—';
            const remaining = Math.max(total - done, 0);
            const jobId = esc(job.id || '');
            const paused = job.status === 'paused';
            const pauseTitle = esc(t(paused ? 'queue_resume' : 'queue_pause'));
            const removeTitle = esc(t('queue_remove'));

            const cancelTitle = esc(t('notice_cancel'));
            // Asking: ✓ (remove) where Pause/Play was, ✕ (keep) where Remove was.
            const actions = job.id === this._confirmId ? `
                        <span class="queue-job-actions">
                            <button type="button" class="queue-act is-confirm" data-act="confirm" data-job-id="${jobId}" title="${removeTitle}" aria-label="${removeTitle}">${ICON_CHECK}</button>
                            <button type="button" class="queue-act is-cancel" data-act="cancel" data-job-id="${jobId}" title="${cancelTitle}" aria-label="${cancelTitle}">${ICON_CROSS}</button>
                        </span>` : `
                        <span class="queue-job-actions">
                            <button type="button" class="queue-act ${paused ? 'is-play' : 'is-pause'}" data-act="pause" data-job-id="${jobId}" title="${pauseTitle}" aria-label="${pauseTitle}"${this._masterOff ? ' disabled' : ''}>${paused ? ICON_PLAY : ICON_PAUSE}</button>
                            <button type="button" class="queue-act queue-act-del" data-act="remove" data-job-id="${jobId}" title="${removeTitle}" aria-label="${removeTitle}">${ICON_TRASH}</button>
                        </span>`;
            // One mark for both kinds of skip, a line for each in its tip. A
            // pending job shows its clock in that slot instead, and the ⚠ comes
            // back once it runs.
            const skipLines = [];
            if (skipped.unavailable > 0) skipLines.push(esc(t('queue_skipped_unavailable', { n: skipped.unavailable })));
            if (skipped.wishlisted > 0) skipLines.push(esc(t('queue_skipped_wishlisted', { n: skipped.wishlisted })));
            const skipBadge = effStatus === 'pending'
                ? `<span class="queue-job-skip queue-job-wait">${ICON_CLOCK}<span class="queue-skip-tip" role="tooltip"><b>${status}</b><br>${esc(t('queue_pending_tip'))}</span></span>`
                : skipLines.length
                ? `<span class="queue-job-skip">⚠<span class="queue-skip-tip" role="tooltip">${skipLines.join('<br>')}</span></span>`
                : '';
            const glyph = isPreset ? `<span class="queue-job-glyph has-tip">${ICON_LIST}<span class="queue-filter-tip" role="tooltip">${esc(t('presets_title'))}</span></span>`
                : type === Store.JOB_TYPE.BUNDLE ? `<span class="queue-job-glyph">${ICON_BUNDLE}</span>`
                : type === Store.JOB_TYPE.UNDO ? `<span class="queue-job-glyph">${ICON_UNDO}</span>` : '';
            // A curator's strip: a square in its filter's colour in front of the
            // name, naming the filter on hover and opening the curator on a
            // double click (_openCurator).
            const filterBar = !isCuratorJob ? '' : `<span class="queue-job-filter" data-curator-id="${esc(job.curatorId || '')}" style="${Filters.fillStyle(job.filter)}"><span class="queue-filter-tip" role="tooltip">${esc(t(Filters.labelKey(job.filter)))}</span></span>`;
            const nameBox = `<span class="queue-job-namebox"><span class="queue-job-name">${name}</span><span class="queue-name-full" role="tooltip">${name}</span></span>`;

            // An MI job auto-fills while it drains, so its total is a moving target:
            // a percent bar would jump backward on a fresh swipe (5/10 → 5/15). It
            // shows the live remaining COUNT instead, in the status colour.
            // The stretched bar shows "done/total" over its middle, the slash
            // on the centre line (.queue-mini-num).
            const num = total > 0 ? [done, '/', total] : ['', '', ''];
            const mini = isGesture ? '' : `<span class="queue-mini" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="${status} · ${count}"><span class="queue-mini-track"><span class="queue-mini-line"><span class="queue-mini-fill" style="width:${pct}%; background:${statusColor}"></span></span><span class="queue-mini-num" aria-hidden="true">${num.map(s => `<span>${s}</span>`).join('')}</span></span></span>`;
            const progress = isGesture
                ? `<span class="queue-job-count" style="color:${statusColor}" aria-label="${status} · ${esc(t('queue_mi_remaining', { n: remaining }))}">${remaining}</span>`
                : `<span class="queue-job-pct">${total > 0 ? pct + '%' : '—'}</span>`;

            return `
                <div class="queue-job${isCurrent ? ' current' : ''}${isGesture ? ' mi' : ''}${isPreset ? ' preset' : ''}${isCuratorJob ? ' curator' : ''}${paused ? ' paused' : ''}${effStatus === 'running' ? ' running' : ''}${effStatus === 'pending' ? ' pending' : ''}" data-job-id="${jobId}"${effStatus === 'running' ? ` style="animation-delay:-${Date.now() % SHEEN_MS}ms"` : ''}>
                    <div class="queue-job-line">
                        ${glyph}${filterBar}<span class="queue-job-area">${nameBox}${mini}</span>${progress}${skipBadge}${actions}
                    </div>
                </div>`;
        }
    }

    window.ILAP_Queue = { create: (root) => new QueueManager(root) };

})();
