// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Undo applet: the ⟲ button left of the Last-Ignored chip and its droplist —
    // "un-ignore the last X" by count (preset chips + a digits-only input clamped
    // to what the log can actually undo) or by time (X hours/days). Staging goes
    // through UndoService into the shared curator queue; the drainer does the
    // rest. Like the rest of the popup, this renders from full storage snapshots
    // pushed by popup_main — the menu DOM is built once (in the markup), renders
    // only update values/disabled states, so a re-render can't eat an open menu.

    const t = (k, p) => (window.ILAP && window.ILAP.t) ? window.ILAP.t(k, p) : k;

    const Log = window.ILAP.IgnoreLog;
    const Store = window.ILAP.Curator && window.ILAP.Curator.Store;

    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    const MSG_HIDE_MS = 2600;

    class UndoManager {
        constructor(root) {
            this.root = root;
            this.btn = root.getElementById('undo-btn');
            this.menu = root.getElementById('undo-menu');
            if (!this.btn || !this.menu) return;

            this.tip = root.getElementById('undo-tip');

            this.countInput = root.getElementById('undo-count');
            this.timeInput = root.getElementById('undo-time');
            this.ofLabel = root.getElementById('undo-of');
            this.goCount = root.getElementById('undo-go-count');
            this.goTime = root.getElementById('undo-go-time');
            this.unitH = root.getElementById('undo-unit-h');
            this.unitD = root.getElementById('undo-unit-d');
            this.msg = root.getElementById('undo-msg');

            this.service = (window.ILAP.UndoService && Store && Log)
                ? new window.ILAP.UndoService({ store: Store, log: Log, maxJobs: Store.MAX_JOBS })
                : null;

            this.undoableMax = 0;   // clamp ceiling for the count input ("of N")
            this._msgTimer = null;

            this._wire();
        }

        _wire() {
            this.btn.addEventListener('click', (e) => {
                if (!e.isTrusted) return; // real clicks only — same rule as the queue applet
                e.stopPropagation();
                this.menu.classList.contains('open') ? this._close() : this._open();
            });
            // Outside click closes; the menu itself must not bubble up to the closer.
            this.menu.addEventListener('click', (e) => e.stopPropagation());
            // The closer listens on DOCUMENT, not the root: in the widget the root
            // is a shadow root, and a click elsewhere on the Steam page never
            // enters it — the menu would stay open. composedPath() sees through
            // the shadow retargeting, so button/menu clicks are still recognized
            // as "inside" from the document level.
            this._outsideClose = (e) => {
                if (!this.menu.classList.contains('open')) return;
                const path = e.composedPath ? e.composedPath() : [e.target];
                if (path.indexOf(this.btn) !== -1 || path.indexOf(this.menu) !== -1) return;
                this._close();
            };
            document.addEventListener('click', this._outsideClose);

            // Digits only, clamped to [1..undoableMax]; chips fill the input.
            this.countInput.addEventListener('input', () => {
                this.countInput.value = this._cleanNumber(this.countInput.value, this.undoableMax);
                this._syncControls();
            });
            this.timeInput.addEventListener('input', () => {
                this.timeInput.value = this._cleanNumber(this.timeInput.value, 9999);
                this._syncControls();
            });
            this.menu.querySelectorAll('.undo-chip[data-n]').forEach(chip => {
                chip.addEventListener('click', () => {
                    this.countInput.value = this._cleanNumber(chip.dataset.n, this.undoableMax);
                    this._syncControls();
                });
            });
            const pickUnit = (h) => {
                this.unitH.classList.toggle('selected', h);
                this.unitD.classList.toggle('selected', !h);
            };
            this.unitH.addEventListener('click', () => pickUnit(true));
            this.unitD.addEventListener('click', () => pickUnit(false));

            this.goCount.addEventListener('click', (e) => {
                if (!e.isTrusted) return;
                const n = parseInt(this.countInput.value, 10);
                if (n > 0) this._stage(this.service.stageLastN(n));
            });
            this.goTime.addEventListener('click', (e) => {
                if (!e.isTrusted) return;
                const n = parseInt(this.timeInput.value, 10);
                if (n > 0) {
                    const unit = this.unitH.classList.contains('selected') ? HOUR_MS : DAY_MS;
                    this._stage(this.service.stageSince(n * unit));
                }
            });
        }

        _cleanNumber(value, max) {
            const digits = String(value || '').replace(/\D/g, '').replace(/^0+/, '');
            if (!digits) return '';
            return String(Math.min(parseInt(digits, 10), Math.max(max, 1)));
        }

        _open() {
            if (this.btn.disabled) return;
            // Re-clamp against the freshest log before showing "of N".
            chrome.storage.local.get(Log.LOG_KEY, (res) => {
                this._applyCount(Log.undoableCount(res[Log.LOG_KEY] || []));
                this.menu.classList.add('open');
                this.btn.setAttribute('aria-expanded', 'true');
            });
        }

        _close() {
            this.menu.classList.remove('open');
            this.btn.setAttribute('aria-expanded', 'false');
            this._showMsg(null);
        }

        async _stage(outcomePromise) {
            const outcome = await outcomePromise;
            if (!outcome) return;
            if (outcome.kind === 'added') {
                this._showMsg(t('undo_msg_added', { n: outcome.total }), true);
                // Reveal the staged job: the queue applet un-hides on the queue
                // change; opening it collapses SETTINGS via the existing toggles.
                const acc = this.root.getElementById('queue-accordion');
                if (acc) acc.open = true;
                this._msgTimer = setTimeout(() => this._close(), MSG_HIDE_MS);
                return;
            }
            const key = outcome.kind === 'exists' ? 'undo_msg_exists'
                : outcome.kind === 'full' ? 'undo_msg_full'
                : 'undo_msg_empty';
            this._showMsg(t(key));
        }

        _showMsg(text, ok) {
            if (this._msgTimer) { clearTimeout(this._msgTimer); this._msgTimer = null; }
            if (!this.msg) return;
            this.msg.hidden = !text;
            this.msg.textContent = text || '';
            this.msg.classList.toggle('ok', !!ok);
        }

        _applyCount(count) {
            this.undoableMax = count;
            if (this.ofLabel) this.ofLabel.textContent = t('undo_of_n', { n: count });
            // Re-clamp a value typed before the ceiling moved.
            this.countInput.value = this._cleanNumber(this.countInput.value, count);
            this._syncControls();
        }

        _syncControls() {
            const canStage = !!this.service;
            this.goCount.disabled = !canStage || !(parseInt(this.countInput.value, 10) > 0);
            this.goTime.disabled = !canStage || !(parseInt(this.timeInput.value, 10) > 0);
        }

        // Full storage snapshot, same contract as the queue applet's render().
        // Deliberately NOT surface-gated: since the SW drain landed, staging works
        // from either surface — the mode only decides where the UI lives.
        render(store) {
            if (!this.btn) return;
            store = store || {};
            const count = Log ? Log.undoableCount(store[Log.LOG_KEY] || []) : 0;

            const disabled = !this.service || count === 0;
            this.btn.disabled = disabled;
            if (disabled) this.menu.classList.remove('open');
            const tipText = count === 0 ? t('undo_empty') : t('undo_button_title');
            if (this.tip) this.tip.textContent = tipText;
            this.btn.setAttribute('aria-label', tipText);

            this._applyCount(count);
        }
    }

    window.ILAP_Undo = { create: (root) => new UndoManager(root) };

})();
