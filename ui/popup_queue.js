// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Renders the curator ignore queue inside the popup/widget as a collapsible
    // applet (mirrors the SETTINGS accordion). It renders from a full storage
    // snapshot: the job records (`ilap_curator_queue`) hold only user-owned state,
    // drain progress comes from the per-job cursor keys, and "running" is derived
    // from a live drain lease — the drainer never stores a status, so it can never
    // clobber a pause/remove written here. The whole <details> is hidden when the
    // queue is empty, so it never shows even when the rest of the UI is locked.

    const t = (k, p) => (window.ILAP && window.ILAP.t) ? window.ILAP.t(k, p) : k;

    // Shared HTML-escaper (src/escape.js, loaded first in popup.html + content_scripts).
    const esc = window.ILAP.Sanitizer.escapeHTML;

    // Storage model (src/curator/store.js, loaded before this script in both
    // content_scripts and popup.html) — serialized queue writes + key prefixes.
    const Store = window.ILAP.Curator.Store;

    // Filter vocabulary + label colours are shared with the curator-page control
    // (see src/curator/filters.js, loaded before this script in both content_scripts
    // and popup.html). Bold + a muted fallback match this applet's own styling.
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

    // Curator id of the page this surface is rendered on (only matches in the on-page
    // widget; the popup window's location isn't a curator page → null → no highlight).
    // Shared parser (src/curator/filters.js) so this and main.js agree.
    const currentCuratorId = () => Filters.curatorIdFromPath(location.pathname);

    // Inline icons (inherit the button colour via currentColor).
    const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';
    const ICON_PLAY = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
    const ICON_TRASH = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9zm4 2v8h1v-8h-1zm3 0v8h1v-8h-1z"/></svg>';

    class QueueManager {
        constructor(root) {
            this.root = root;
            this.accordion = root.getElementById('queue-accordion');
            this.list = root.getElementById('queue-list');
            this.chip = root.getElementById('queue-jobs-chip');
            // Delegated handler — the list HTML is rebuilt on every render.
            if (this.list) this.list.addEventListener('click', (e) => this._onAction(e));
        }

        // Pause/Resume flips the stored user intent (paused ↔ pending — 'running'
        // is never stored); Remove drops the job. Both go through Store's
        // serialized queue writers, so a click here can't interleave with a
        // concurrent queue write in the same context.
        _onAction(e) {
            if (!e.isTrusted) return; // real clicks only — not page-synthesized events
            const btn = e.target.closest('.queue-act');
            if (!btn) return;
            const id = btn.dataset.jobId;
            const act = btn.dataset.act;
            if (act === 'remove') {
                Store.removeJob(id);
            } else if (act === 'pause') {
                Store.updateJob(id, (j) => ({ status: j.status === 'paused' ? 'pending' : 'paused' }));
            }
        }

        // `store` is a full chrome.storage.local snapshot: the queue array plus
        // the per-job lock/cursor keys this view derives running/progress from.
        render(store) {
            if (!this.accordion) return;
            store = store || {};
            const jobs = Array.isArray(store.ilap_curator_queue) ? store.ilap_curator_queue : [];

            if (jobs.length === 0) {
                this.accordion.hidden = true;
                this.accordion.open = false;
                return;
            }

            this.accordion.hidden = false;
            const now = Date.now();
            const statuses = jobs.map(j => this._effectiveStatus(j, store, now));
            // Barber-pole indicator while any job is actively ignoring.
            this.accordion.classList.toggle('has-running', statuses.some(s => s === 'running'));
            if (this.chip) this.chip.textContent = jobs.length;
            const cur = currentCuratorId();
            if (this.list) {
                this.list.innerHTML = jobs
                    .map((j, i) => this._row(j, cur, statuses[i], this._done(j, store)))
                    .join('');
            }
            if (window.ILAP && window.ILAP.i18n) window.ILAP.i18n.applyDom(this.list);
        }

        // Stored status carries only user intent ('enumerating'/'paused', else
        // drainable). "Running" is derived: a drainable job whose drain lease is
        // live IS being drained by some tab right now.
        _effectiveStatus(job, store, now) {
            if (job.status === 'enumerating' || job.status === 'paused') return job.status;
            const lock = store[Store.LOCK_PREFIX + job.curatorId];
            return (lock && (lock.expiresAt || 0) > now) ? 'running' : 'pending';
        }

        // Progress comes from the drainer-owned cursor key; legacy records
        // (pre-cursor-key) kept the cursor inline.
        _done(job, store) {
            const v = store[Store.CURSOR_PREFIX + job.id];
            return Number.isFinite(v) ? v : (job.cursor || 0);
        }

        _row(job, cur, effStatus, cursor) {
            const name = esc(job.curatorName || job.curatorId || '');
            const total = job.total || 0;
            const done = Math.min(cursor, total || cursor);
            const status = esc(t(STATUS_LABELS[effStatus] || 'queue_status_pending'));
            const statusColor = STATUS_COLORS[effStatus];
            const isCurrent = !!cur && job.curatorId === cur;
            const filter = esc(t(Filters.labelKey(job.filter)));
            const pct = total > 0 ? Math.round(done / total * 100) : 0;
            const count = total > 0 ? `${done} / ${total}` : '—';
            const jobId = esc(job.id || '');
            const paused = job.status === 'paused';
            const pauseIcon = paused ? ICON_PLAY : ICON_PAUSE;
            const pauseTitle = esc(t(paused ? 'queue_resume' : 'queue_pause'));
            const removeTitle = esc(t('queue_remove'));

            return `
                <div class="queue-job${isCurrent ? ' current' : ''}">
                    <div class="queue-job-head">
                        <span class="queue-job-name">${name}</span>
                        <span class="queue-job-status"${statusColor ? ` style="color:${statusColor}"` : ''}>${status}</span>
                    </div>
                    <div class="queue-job-sub" style="${filterStyle(job.filter)}">${filter}</div>
                    <div class="queue-bar"><div class="queue-bar-fill" style="width:${pct}%"></div></div>
                    <div class="queue-job-foot">
                        <span class="queue-job-count">${count}</span>
                        <span class="queue-job-actions">
                            <button type="button" class="queue-act ${paused ? 'is-play' : 'is-pause'}" data-act="pause" data-job-id="${jobId}" title="${pauseTitle}" aria-label="${pauseTitle}">${pauseIcon}</button>
                            <button type="button" class="queue-act queue-act-del" data-act="remove" data-job-id="${jobId}" title="${removeTitle}" aria-label="${removeTitle}">${ICON_TRASH}</button>
                        </span>
                    </div>
                </div>`;
        }
    }

    window.ILAP_Queue = { create: (root) => new QueueManager(root) };

})();
