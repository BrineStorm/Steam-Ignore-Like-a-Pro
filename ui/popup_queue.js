// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The ignore queue applet in the popup/widget. It renders from a storage
    // snapshot: the job records, the per-job cursor keys for progress, and the
    // live lease for "running". Hidden while the queue is empty.

    const t = window.ILAP.t;

    const esc = window.ILAP.Sanitizer.escapeHTML;
    const Store = window.ILAP.Curator.Store;
    const Lease = window.ILAP.Curator.Lease;
    const Settings = window.ILAP.Settings;

    // Filter labels and colours shared with the curator button (src/curator/filters.js).
    const Filters = window.ILAP_Filters;
    const filterStyle = (value) => Filters.colorStyle(value, { bold: true, fallback: 'var(--muted)' });

    // No 'done' state: finished jobs are removed from the queue (the drainer emits
    // a completion pulse for the widget blink instead of leaving a record behind).
    const STATUS_LABELS = {
        enumerating: 'queue_status_enumerating',
        pending: 'queue_status_pending',
        running: 'queue_status_running',
        paused: 'queue_status_paused'
    };

    // Match the pause/play button hover colours: running → green, paused → yellow.
    // Enumerating is a transient "fetching the list" state → Spared blue.
    const STATUS_COLORS = {
        enumerating: '#66c0f4',
        running: '#7ad13f',
        paused: '#ffd21a'
    };

    // Duration of the smooth "collapse on completion" — matches the .5s on
    // .solo-collapse over ::details-content in popup.css (see _collapseEmpty).
    const COLLAPSE_MS = 500;

    // Curator id of the page this surface is rendered on (only matches in the on-page
    // widget; the popup window's location isn't a curator page → null → no highlight).
    // Shared parser (src/curator/filters.js) so this and main.js agree.
    const currentCuratorId = () => Filters.curatorIdFromPath(location.pathname);

    // Inline icons (inherit the button colour via currentColor), shared with the
    // curator droplist (ui/icons.js).
    const { PAUSE: ICON_PAUSE, PLAY: ICON_PLAY, TRASH: ICON_TRASH } = window.ILAP_Icons;

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
            // Delegated handler — the list HTML is rebuilt on every render.
            if (this.list) this.list.addEventListener('click', (e) => this._onAction(e));
        }

        // Pause/Resume flips the stored user intent (paused ↔ pending — 'running'
        // is never stored); Remove drops the job. Both go through Store's
        // serialized queue writers, so a click here can't interleave with a
        // concurrent queue write in the same context.
        //
        // With the extension OFF only Remove works. Pause renders `disabled`; the
        // guard below also covers a master flip between that render and the click.
        _onAction(e) {
            if (!e.isTrusted) return; // real clicks only — not page-synthesized events
            const btn = e.target.closest('.queue-act');
            if (!btn) return;
            const id = btn.dataset.jobId;
            const act = btn.dataset.act;
            if (act === 'remove') {
                Store.removeJob(id);
            } else if (act === 'pause' && !this._masterOff) {
                Store.updateJob(id, (j) => ({ status: j.status === 'paused' ? 'pending' : 'paused' }));
            }
        }

        // `store` is a storage snapshot: the queue array plus the per-job
        // lock/cursor keys this view derives running/progress from.
        render(store) {
            if (!this.accordion) return;
            store = store || {};
            const jobs = Array.isArray(store[Store.QUEUE_KEY]) ? store[Store.QUEUE_KEY] : [];

            if (jobs.length === 0) {
                this._collapseEmpty();
                return;
            }

            // A job exists again — cancel a still-running "collapse on completion"
            // so a freshly staged job isn't hidden out from under the user.
            if (this._closeTimer) {
                clearTimeout(this._closeTimer);
                this._closeTimer = null;
                this.accordion.classList.remove('solo-collapse');
            }

            this.accordion.hidden = false;
            // From the render snapshot, so _onAction judges by what the row shows.
            this._masterOff = !Settings.isOn(store[Settings.KEYS.MASTER]);
            const now = Date.now();
            const statuses = jobs.map(j => this._effectiveStatus(j, store, now));
            // Barber-pole indicator while any job is actively ignoring.
            this.accordion.classList.toggle('has-running', statuses.some(s => s === 'running'));
            if (this.chip) this.chip.textContent = jobs.length;
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
                this.list.innerHTML = jobs
                    .map((j, i) => this._row(j, cur, statuses[i], this._done(j, store),
                        this._skipped(j, store)))
                    .join('') + halt;
            }
            if (window.ILAP && window.ILAP.i18n) window.ILAP.i18n.applyDom(this.list);
        }

        // The queue emptied. If the applet was OPEN (the user was watching a job
        // that just finished) — collapse it with the same smooth, content-preserving
        // animation as a manual "solo" close (the .solo-collapse class over
        // ::details-content) and hide only after it ends, rather than snapping shut.
        // A closed or already-hidden applet is just hidden — nothing to animate on screen.
        _collapseEmpty() {
            if (this.accordion.hidden) return;            // already hidden
            if (this._closeTimer) return;                 // animation already running
            this.accordion.classList.remove('has-running');
            if (!this.accordion.open) {                   // collapsed — no body to animate
                this.accordion.hidden = true;
                return;
            }
            this.accordion.classList.add('solo-collapse');
            this.accordion.open = false;
            this._closeTimer = setTimeout(() => {
                this._closeTimer = null;
                this.accordion.hidden = true;
                this.accordion.classList.remove('solo-collapse');
            }, COLLAPSE_MS);
        }

        // Stored status carries only user intent ('enumerating'/'paused', else
        // drainable). "Running" is derived: a drainable job whose drain lease is
        // live IS being drained by some tab right now.
        _effectiveStatus(job, store, now) {
            if (job.status === 'enumerating' || job.status === 'paused') return job.status;
            const lock = store[Lease.LOCK_PREFIX + job.curatorId];
            return (lock && (lock.expiresAt || 0) > now) ? 'running' : 'pending';
        }

        // Progress comes from the drainer-owned cursor key; legacy records
        // (pre-cursor-key) kept the cursor inline.
        _done(job, store) {
            const v = store[Store.CURSOR_PREFIX + job.id];
            return Number.isFinite(v) ? v : (job.cursor || 0);
        }

        // Appids the drainer skipped as permanently refused (region-locked) —
        // drainer-owned per-job key, like the cursor.
        _skipped(job, store) {
            const v = store[Store.SKIPPED_PREFIX + job.id];
            return Number.isFinite(v) ? v : 0;
        }

        _row(job, cur, effStatus, cursor, skipped) {
            // Only a curator job has a curator: every other type shows a localized
            // name and no filter sub-line (the footer says everything else). The
            // AUTO-FILLING gesture jobs also swap the percent bar for a live
            // remaining count (see the progress branch below). A type this build
            // does not know keeps whatever name its record carries, and can only
            // be removed from here — the drainer skips it.
            const type = Store.jobType(job);
            const traits = Store.jobTraits(job);
            const isCuratorJob = type === Store.JOB_TYPE.CURATOR;
            const isGesture = !!traits && traits.gesture;
            const nameKey = JOB_NAME_KEYS[type];
            const name = nameKey
                ? esc(t(nameKey))
                : esc(job.curatorName || job.curatorId || '');
            const total = job.total || 0;
            const done = Math.min(cursor, total || cursor);
            const status = esc(t(STATUS_LABELS[effStatus] || 'queue_status_pending'));
            const statusColor = STATUS_COLORS[effStatus];
            const isCurrent = isCuratorJob && !!cur && job.curatorId === cur;
            const filter = isCuratorJob ? esc(t(Filters.labelKey(job.filter))) : '';
            const pct = total > 0 ? Math.round(done / total * 100) : 0;
            const count = total > 0 ? `${done} / ${total}` : '—';
            const jobId = esc(job.id || '');
            const paused = job.status === 'paused';
            const pauseIcon = paused ? ICON_PLAY : ICON_PAUSE;
            const pauseTitle = esc(t(paused ? 'queue_resume' : 'queue_pause'));
            const removeTitle = esc(t('queue_remove'));

            const actions = `
                        <span class="queue-job-actions">
                            <button type="button" class="queue-act ${paused ? 'is-play' : 'is-pause'}" data-act="pause" data-job-id="${jobId}" title="${pauseTitle}" aria-label="${pauseTitle}"${this._masterOff ? ' disabled' : ''}>${pauseIcon}</button>
                            <button type="button" class="queue-act queue-act-del" data-act="remove" data-job-id="${jobId}" title="${removeTitle}" aria-label="${removeTitle}">${ICON_TRASH}</button>
                        </span>`;
            const skipLine = skipped > 0
                ? `<div class="queue-job-skip">${esc(t('queue_skipped_unavailable', { n: skipped }))}</div>` : '';

            // An MI job auto-fills while it drains, so its total is a moving target:
            // a percent bar would jump backward on a fresh swipe (5/10 → 5/15). Show
            // a live remaining COUNT ("In queue: N") instead of the bar/percent.
            const progress = isGesture
                ? `${skipLine}
                    <div class="queue-job-foot">
                        <span class="queue-job-count">${esc(t('queue_mi_remaining', { n: Math.max(total - done, 0) }))}</span>${actions}
                    </div>`
                : `<div class="queue-bar"><div class="queue-bar-fill" style="width:${pct}%"></div></div>
                    ${skipLine}
                    <div class="queue-job-foot">
                        <span class="queue-job-count">${count}${total > 0 ? ` <b class="queue-job-pct">${pct}%</b>` : ''}</span>${actions}
                    </div>`;

            return `
                <div class="queue-job${isCurrent ? ' current' : ''}${isGesture ? ' mi' : ''}">
                    <div class="queue-job-head">
                        <span class="queue-job-name">${name}</span>
                        <span class="queue-job-status"${statusColor ? ` style="color:${statusColor}"` : ''}>${status}</span>
                    </div>
                    ${!isCuratorJob ? '' : `<div class="queue-job-sub" style="${filterStyle(job.filter)}">${filter}</div>`}
                    ${progress}
                </div>`;
        }
    }

    window.ILAP_Queue = { create: (root) => new QueueManager(root) };

})();
