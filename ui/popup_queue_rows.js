// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // What one job says in the queue, from its record and a storage snapshot: the
    // strip's markup, its status and its numbers. No DOM here. The drawer the
    // strips sit in and how they move are popup_queue.js's.

    const t = window.ILAP.t;

    const esc = window.ILAP.Sanitizer.escapeHTML;

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

    // One sweep of the running strip's sheen — matches the 2.4s on
    // .queue-job.running in popup.css. A strip that starts running is started
    // at the phase of a shared clock (a negative animation-delay), so a fresh
    // one picks the sweep up where an old one was (popup_queue.js _patchList).
    const SHEEN_MS = 2400;

    // Inline icons (inherit the button colour via currentColor, ui/icons.js).
    const { PAUSE: ICON_PAUSE, PLAY: ICON_PLAY, TRASH: ICON_TRASH, LIST: ICON_LIST, BUNDLE: ICON_BUNDLE } = window.ILAP_Icons;
    // An un-ignore job's glyph: the Undo button's turning arrow, in green, drawn
    // bold (a stroke of its own colour around the shape).
    const ICON_UNDO = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="#4fd64f" stroke="#4fd64f" stroke-width="1.6" stroke-linejoin="round" d="M12 5V1.8L6.5 6.5 12 11.2V8c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8z"/></svg>';
    // A job waiting its turn: a white clock in the ⚠ slot.
    const ICON_CLOCK = '<svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.4"/><path d="M6 3.4V6l1.8 1.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    // Skipped games: a yellow warning triangle with a dark mark.
    const ICON_WARN = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="#ffd21a" stroke="#ffd21a" stroke-width="2" stroke-linejoin="round" d="M12 3 22 20.5H2Z"/><path fill="none" stroke="#1a1300" stroke-width="2.4" stroke-linecap="round" d="M12 9.5v5.2"/><circle cx="12" cy="17.6" r="1.35" fill="#1a1300"/></svg>';
    // The Remove confirmation's two answers: bare Unicode marks in bold, drawn only here.
    const ICON_CHECK = '<span aria-hidden="true">✓</span>';
    const ICON_CROSS = '<span aria-hidden="true">✕</span>';

    class QueueRows {
        // Given by popup_main.js:
        //   store, lease     src/curator/store.js, lease.js
        //   filters          filter labels and colours, shared with the curator button
        //                    (src/curator/filters.js)
        //   presetLabel(key) a built-in list's name (popup_presets.js)
        constructor(opts) {
            for (const dep of ['store', 'lease', 'filters', 'presetLabel']) {
                if (!opts || !opts[dep]) throw new TypeError('[ILAP] QueueRows needs opts.' + dep);
            }
            this.store = opts.store;
            this.lease = opts.lease;
            this.filters = opts.filters;
            this.presetLabel = opts.presetLabel;
            // How a job type shows on its strip. `name` where its record's will not do,
            // `glyph` in front of it (a built-in list has the lists glyph, a bundle its
            // two capsules, an un-ignore job the green Undo arrow, a curator's job a
            // square in its filter's colour), `cls` for the strip, `isCurrent` for the
            // curator of this page. Null-prototype because the key is a job's stored
            // `type`: an unknown one must fall through to the record's own name, which
            // a prototype hit would take away.
            const JT = this.store.JOB_TYPE;
            const glyph = (icon) => () => `<span class="queue-job-glyph">${icon}</span>`;
            this.jobViews = Object.assign(Object.create(null), {
                [JT.CURATOR]: {
                    cls: ' curator',
                    isCurrent: (job, cur) => !!cur && job.curatorId === cur,
                    glyph: (job) => this._filterSquare(job),
                },
                [JT.PRESET]: {
                    cls: ' preset',
                    name: (job) => this.presetLabel(job.presetKey),
                    glyph: () => `<span class="queue-job-glyph has-tip">${ICON_LIST}<span class="queue-filter-tip" role="tooltip">${esc(t('presets_title'))}</span></span>`,
                },
                [JT.BUNDLE]: { glyph: glyph(ICON_BUNDLE) },
                [JT.UNDO]: {
                    name: (job) => this._undoScopeName(job.scope) || t('undo_job_name'),
                    glyph: glyph(ICON_UNDO),
                },
                [JT.MI]: { name: () => t('mi_job_name') },
                [JT.MIUNDO]: { name: () => t('miundo_job_name') },
                [JT.CREATOR]: { name: () => t('creator_job_name'), glyph: glyph(window.ILAP_Icons.CREATOR) },
            });
        }

        // A gesture job shows at the bottom and counts for nothing in the ring.
        isGesture(job) {
            const traits = this.store.jobTraits(job);
            return !!traits && traits.gesture;
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

        // Stored status has only user intent ('enumerating'/'paused', else
        // drainable). "Running" is derived: a drainable job whose drain lease is
        // live IS being drained by some tab right now. The lease is the curator's,
        // so of a curator's two jobs only the one it names runs (a lock with no
        // jobId is from an older build).
        statusOf(job, store, now) {
            if (job.status === 'enumerating' || job.status === 'paused') return job.status;
            const lock = store[this.lease.LOCK_PREFIX + job.curatorId];
            const live = lock && (lock.expiresAt || 0) > now && (!lock.jobId || lock.jobId === job.id);
            return live ? 'running' : 'pending';
        }

        // Progress comes from the drainer-owned cursor key; legacy records
        // (pre-cursor-key) kept the cursor inline.
        doneOf(job, store) {
            const v = store[this.store.CURSOR_PREFIX + job.id];
            return Number.isFinite(v) ? v : (job.cursor || 0);
        }

        // Appids the drainer skipped: permanently refused (region-locked), on
        // the user's wishlist, and in the user's library (counted for the whole
        // job on its first pass, so it shows before the cursor gets there).
        // Drainer-owned per-job keys, like the cursor.
        skippedOf(job, store) {
            const n = (v) => Number.isFinite(v) ? v : 0;
            return {
                unavailable: n(store[this.store.SKIPPED_PREFIX + job.id]),
                wishlisted: n(store[this.store.WISHLISTED_PREFIX + job.id]),
                owned: n(store[this.store.OWNED_PREFIX + job.id]),
            };
        }

        // The parts of one job's strip (strip): its name box, glyph or filter
        // square, the numbers, the status, the skips mark, the two actions and
        // the strip's opening tag.
        // A type this build does not know keeps whatever name its record has, and
        // can only be removed from here — the drainer skips it.
        // Remove is always there, running job or paused. A click on it asks first
        // (popup_queue.js _confirmId): ✓ and ✕ take the two slots, so a slip never
        // drops a job.
        // A running job's drainer finds it gone at its next batch (Store.removeJob).
        // `state`: { cur, the curator of this page; status; cursor; skipped; asking,
        // Remove has asked about this job; masterOff, with the extension off }.
        parts(job, state) {
            const { cur, status: effStatus, cursor, skipped, asking, masterOff } = state;
            const traits = this.store.jobTraits(job);
            const isGesture = !!traits && traits.gesture;
            const view = this.jobViews[this.store.jobType(job)] || {};
            const name = esc(view.name ? view.name(job) : job.curatorName || job.curatorId || '');
            const total = job.total || 0;
            const done = Math.min(cursor, total || cursor);
            const status = esc(t(STATUS_LABELS[effStatus] || 'queue_status_pending'));
            const statusColor = STATUS_COLORS[effStatus] || STATUS_COLORS.pending;
            const isCurrent = !!view.isCurrent && view.isCurrent(job, cur);
            const pct = total > 0 ? Math.round(done / total * 100) : 0;
            const count = total > 0 ? `${done} / ${total}` : '—';
            const remaining = Math.max(total - done, 0);
            const jobId = esc(job.id || '');
            const paused = job.status === 'paused';
            const pauseTitle = esc(t(paused ? 'queue_resume' : 'queue_pause'));
            const removeTitle = esc(t('queue_remove'));

            const cancelTitle = esc(t('notice_cancel'));
            // Each button names its job too: four strips read four times 'Pause' (Section 508).
            const named = (title) => (name ? title + ': ' + name : title);
            // Asking: ✓ (remove) where Pause/Play was, ✕ (keep) where Remove was.
            const actions = asking ? `
                        <span class="queue-job-actions">
                            <button type="button" class="queue-act is-confirm" data-act="confirm" data-job-id="${jobId}" title="${removeTitle}" aria-label="${named(removeTitle)}">${ICON_CHECK}</button>
                            <button type="button" class="queue-act is-cancel" data-act="cancel" data-job-id="${jobId}" title="${cancelTitle}" aria-label="${named(cancelTitle)}">${ICON_CROSS}</button>
                        </span>` : `
                        <span class="queue-job-actions">
                            <button type="button" class="queue-act ${paused ? 'is-play' : 'is-pause'}" data-act="pause" data-job-id="${jobId}" title="${pauseTitle}" aria-label="${named(pauseTitle)}"${masterOff ? ' disabled' : ''}>${paused ? ICON_PLAY : ICON_PAUSE}</button>
                            <button type="button" class="queue-act queue-act-del" data-act="remove" data-job-id="${jobId}" title="${removeTitle}" aria-label="${named(removeTitle)}">${ICON_TRASH}</button>
                        </span>`;
            // One mark for every kind of skip, a line for each in its tip. A
            // pending job shows its clock in that slot instead, its tip with the
            // same lines under the wait, and the ⚠ comes back once it runs.
            // '' with nothing to show: strip() keeps the slot empty.
            const skipLines = [];
            if (skipped.unavailable > 0) skipLines.push(esc(t('queue_skipped_unavailable', { n: skipped.unavailable })));
            if (skipped.wishlisted > 0) skipLines.push(esc(t('queue_skipped_wishlisted', { n: skipped.wishlisted })));
            if (skipped.owned > 0) skipLines.push(esc(t('queue_skipped_owned', { n: skipped.owned })));
            const waitLines = [esc(t('queue_pending_tip'))].concat(skipLines).join('<br>');
            const skipBadge = effStatus === 'pending'
                ? `<span class="queue-job-skip queue-job-wait">${ICON_CLOCK}<span class="queue-skip-tip" role="tooltip"><b>${status}</b><br>${waitLines}</span></span>`
                : skipLines.length
                ? `<span class="queue-job-skip">${ICON_WARN}<span class="queue-skip-tip" role="tooltip">${skipLines.join('<br>')}</span></span>`
                : '';
            const glyph = view.glyph ? view.glyph(job) : '';
            const nameBox = `<span class="queue-job-namebox"><span class="queue-job-name">${name}</span><span class="queue-name-full" role="tooltip">${name}</span></span>`;
            // Status shows as the status word, the bar's colour, the action
            // key (a quiet grey ⏸ on a job that goes, a ▶ waiting on a paused
            // one) and, while the job is actually running, a sheen sweeping
            // across its strip (.queue-job.running).
            const open = `<div class="queue-job${isCurrent ? ' current' : ''}${isGesture ? ' mi' : ''}${view.cls || ''}${paused ? ' paused' : ''}${effStatus === 'running' ? ' running' : ''}${effStatus === 'pending' ? ' pending' : ''}" data-job-id="${jobId}"${effStatus === 'running' ? ` style="animation-delay:-${Date.now() % SHEEN_MS}ms"` : ''}>`;
            return { isGesture, total, done, pct, count, remaining, status, statusColor, actions, skipBadge, glyph, nameBox, open };
        }

        // A curator's job in front of its name: the square names the filter on hover
        // and opens the curator on a double click (_openCurator).
        _filterSquare(job) {
            return `<span class="queue-job-filter" data-curator-id="${esc(job.curatorId || '')}" style="${this.filters.fillStyle(job.filter)}"><span class="queue-filter-tip" role="tooltip">${esc(t(this.filters.labelKey(job.filter)))}</span></span>`;
        }

        // A job's row: one slim strip per job, all on one line,
        // so three jobs fit the window with no scroll. The name cut
        // to the name column (shown whole on hover), a mini progress bar that
        // stretches left over the name on hover with "done/total" on it, the
        // percent, then the skips and the two actions.
        strip(job, state) {
            const p = this.parts(job, state);
            // A gesture job shows its live remaining count: its total moves as
            // it fills, so a percent would jump backward on a fresh swipe.
            // The stretched bar shows "done/total" over its middle, the slash
            // on the centre line (.queue-mini-num).
            const num = p.total > 0 ? [p.done, '/', p.total] : ['', '', ''];
            const mini = p.isGesture ? '' : `<span class="queue-mini" role="progressbar" aria-valuemin="0" aria-valuemax="${p.total}" aria-valuenow="${p.done}" aria-label="${p.status} · ${p.count}"><span class="queue-mini-track"><span class="queue-mini-line"><span class="queue-mini-fill" style="width:${p.pct}%; background:${p.statusColor}"></span></span><span class="queue-mini-num" aria-hidden="true">${num.map(s => `<span>${s}</span>`).join('')}</span></span></span>`;
            const progress = p.isGesture
                ? `<span class="queue-job-count" style="color:${p.statusColor}" aria-label="${p.status} · ${esc(t('queue_mi_remaining', { n: p.remaining }))}">${p.remaining}</span>`
                : `<span class="queue-job-pct">${p.total > 0 ? p.pct + '%' : '—'}</span>`;

            // Every strip has the ⚠/clock slot, empty or not. A row out of room
            // takes it from its name column, so a slot on some strips only puts
            // their bars out of line with the rest (popup.css, .queue-job-area).
            const skipSlot = p.skipBadge || '<span class="queue-job-skip"></span>';

            return `
                ${p.open}
                    <div class="queue-job-line">
                        ${p.glyph}<span class="queue-job-area">${p.nameBox}${mini}</span>${progress}${skipSlot}${p.actions}
                    </div>
                </div>`;
        }
    }

    window.ILAP_QueueRows = { create: (opts) => new QueueRows(opts) };

})();
