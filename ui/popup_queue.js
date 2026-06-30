// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Renders the curator ignore queue inside the popup/widget as a collapsible
    // applet (mirrors the SETTINGS accordion). Sketch surface for Phase 2: it only
    // reflects the jobs stored in chrome.storage.local under `ilap_curator_queue`.
    // The whole <details> is hidden when the queue is empty, so it never shows even
    // when the rest of the UI is locked. Draining/progress logic comes later.

    const t = (k, p) => (window.ILAP && window.ILAP.t) ? window.ILAP.t(k, p) : k;

    const esc = (s) => String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

    const FILTER_LABELS = {
        not_recommended: 'filter_not_recommended',
        informational: 'filter_informational',
        all_but_recommended: 'filter_all_but_recommended'
    };

    // Per-category accent — Steam's own label colours (shared with the curator-page toast).
    const FILTER_COLORS = {
        not_recommended: '#ec976c',
        informational: '#f1de74'
    };

    // Inline style for a filter label: a solid Steam colour for the single categories,
    // an orange→yellow gradient for "all except Recommended" (= both categories ignored).
    const FILTER_GRADIENT = 'linear-gradient(90deg, #ec976c, #f1de74)';
    function filterStyle(value) {
        if (value === 'all_but_recommended') {
            return `font-weight:700; background:${FILTER_GRADIENT}; -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color:transparent;`;
        }
        return `font-weight:700; color:${FILTER_COLORS[value] || 'var(--muted)'};`;
    }

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
    function currentCuratorId() {
        const m = location.pathname.match(/^\/curator\/(\d+)/);
        return m ? m[1] : null;
    }

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

        // Pause/Resume just flips the stored status flag (no drainer to pause yet);
        // Remove drops the job from the queue. Both are storage-only management ops —
        // the actual draining behaviour is wired in a later Phase-2 sub-step.
        _onAction(e) {
            const btn = e.target.closest('.queue-act');
            if (!btn) return;
            const id = btn.dataset.jobId;
            const act = btn.dataset.act;
            chrome.storage.local.get('ilap_curator_queue', (res) => {
                let jobs = Array.isArray(res.ilap_curator_queue) ? res.ilap_curator_queue.slice() : [];
                if (act === 'remove') {
                    jobs = jobs.filter(j => j.id !== id);
                } else if (act === 'pause') {
                    // Toggle paused ↔ running (a future drainer owns the real run loop;
                    // for now this just flips the flag so the indicator is reachable).
                    jobs = jobs.map(j => j.id === id
                        ? Object.assign({}, j, { status: j.status === 'paused' ? 'running' : 'paused' })
                        : j);
                }
                chrome.storage.local.set({ ilap_curator_queue: jobs });
            });
        }

        render(jobs) {
            if (!this.accordion) return;
            jobs = Array.isArray(jobs) ? jobs : [];

            if (jobs.length === 0) {
                this.accordion.hidden = true;
                this.accordion.open = false;
                return;
            }

            this.accordion.hidden = false;
            // Barber-pole indicator while any job is actively ignoring.
            this.accordion.classList.toggle('has-running', jobs.some(j => j.status === 'running'));
            if (this.chip) this.chip.textContent = jobs.length;
            const cur = currentCuratorId();
            if (this.list) this.list.innerHTML = jobs.map(j => this._row(j, cur)).join('');
            if (window.ILAP && window.ILAP.i18n) window.ILAP.i18n.applyDom(this.list);
        }

        _row(job, cur) {
            const name = esc(job.curatorName || job.curatorId || '');
            const total = job.total || 0;
            const done = Math.min(job.cursor || 0, total || job.cursor || 0);
            const status = esc(t(STATUS_LABELS[job.status] || 'queue_status_pending'));
            const statusColor = STATUS_COLORS[job.status];
            const isCurrent = !!cur && job.curatorId === cur;
            const filter = esc(t(FILTER_LABELS[job.filter] || 'filter_not_recommended'));
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
