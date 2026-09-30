// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Undo applet: the ⟲ button left of the Last-Ignored chip and its droplist —
    // "un-ignore the last X" by count (a −[ ]+ stepper around a digits-only input
    // clamped to what the log can actually undo) or by time (X hours/days). Staging goes
    // through UndoService into the shared curator queue; the drainer does the
    // rest. Like the rest of the popup, this renders from full storage snapshots
    // pushed by popup_main — the menu DOM is built once (in the markup), renders
    // only update values/disabled states, so a re-render can't eat an open menu.

    const t = window.ILAP.t;

    const Log = window.ILAP.IgnoreLog;

    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    const MSG_HIDE_MS = 2600;

    // Held stepper: first auto-repeat after HOLD_DELAY_MS, then one every
    // HOLD_TICK_MS with a step that grows the longer the button is held — a
    // five-digit undoable total has to be reachable without 20 000 clicks.
    const HOLD_DELAY_MS = 400;
    const HOLD_TICK_MS = 70;
    // [held for less than ms, step]; past the last threshold the step is HOLD_STEP_MAX.
    const HOLD_STEPS = [[1200, 1], [2400, 5], [4000, 25]];
    const HOLD_STEP_MAX = 100;
    const holdStep = (heldMs) => {
        const band = HOLD_STEPS.find(([ms]) => heldMs < ms);
        return band ? band[1] : HOLD_STEP_MAX;
    };

    class UndoManager {
        // `service`: the UndoService to stage through, or null when this surface
        // cannot stage (the Go buttons stay disabled).
        constructor(root, service) {
            this.root = root;
            this.btn = root.getElementById('undo-btn');
            this.menu = root.getElementById('undo-menu');
            if (!this.btn || !this.menu) return;

            this.tip = root.getElementById('undo-tip');

            this.countInput = root.getElementById('undo-count');
            this.timeInput = root.getElementById('undo-time');
            this.minus = root.getElementById('undo-minus');
            this.plus = root.getElementById('undo-plus');
            this.goCount = root.getElementById('undo-go-count');
            this.goTime = root.getElementById('undo-go-time');
            this.unitH = root.getElementById('undo-unit-h');
            this.unitD = root.getElementById('undo-unit-d');
            this.msg = root.getElementById('undo-msg');

            this.service = service;

            this.undoableMax = 0;   // clamp ceiling for the count input (its pale hint)
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

            // Digits only, clamped to [1..undoableMax] — typing stays the classic
            // path, the steppers are just a second way in.
            this.countInput.addEventListener('input', () => {
                this.countInput.value = this._cleanNumber(this.countInput.value, this.undoableMax);
                this._syncControls();
            });
            this.timeInput.addEventListener('input', () => {
                this.timeInput.value = this._cleanNumber(this.timeInput.value, 9999);
                this._syncControls();
            });
            // Double-clicking the empty field takes the whole undoable list: the pale
            // placeholder is the total, so it doubles as its own "select all". Not a
            // single click — that is how you click in to type, and it must not arm Go
            // for a rollback of everything.
            this.countInput.addEventListener('dblclick', () => {
                if (this.countInput.value || !this.undoableMax) return;
                this.countInput.value = String(this.undoableMax);
                this.countInput.select();
                this._syncControls();
            });
            this._wireStep(this.minus, -1);
            this._wireStep(this.plus, 1);
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

        // One stepper button: click steps by 1, holding auto-repeats with a
        // growing step. Keyboard activation (Enter/Space) arrives as a click with
        // detail 0 — no pointerdown — so it gets its own single step.
        //
        // NO isTrusted guard here, and that is not an oversight. The rule is that
        // every control which WRITES anything refuses a synthetic event, and the
        // two that write are the Go buttons below. These steppers, and the
        // double-click-to-fill on the field, only move a number inside this panel
        // — and the page could set `countInput.value` directly anyway, since the
        // widget's shadow root is open, so a guard here would buy nothing while
        // looking like it bought something. The boundary that matters is Go:
        // whatever ends up in the field, no rollback is staged without a real
        // click there.
        _wireStep(btn, dir) {
            let delay = null, tick = null, pressedAt = 0;
            const stop = () => {
                if (delay) { clearTimeout(delay); delay = null; }
                if (tick) { clearInterval(tick); tick = null; }
            };
            btn.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || btn.disabled) return;
                // A second pointer on the same button (another finger) must not
                // orphan the first press's timers.
                stop();
                this._step(dir);
                pressedAt = Date.now();
                delay = setTimeout(() => {
                    tick = setInterval(() => {
                        if (btn.disabled) { stop(); return; }
                        this._step(dir * holdStep(Date.now() - pressedAt));
                    }, HOLD_TICK_MS);
                }, HOLD_DELAY_MS);
            });
            // Leaving the button ends a mouse hold before any release elsewhere could;
            // touch keeps implicit capture, so its release lands on the button anyway.
            ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, stop));
            btn.addEventListener('click', (e) => { if (e.detail === 0 && !btn.disabled) this._step(dir); });
        }

        // Never below zero and never above the undoable total: stepping past 1
        // empties the field rather than going negative, and a negative can't be
        // typed either (_cleanNumber drops the sign with every other non-digit).
        _step(delta) {
            const cur = parseInt(this.countInput.value, 10) || 0;
            const next = Math.min(Math.max(cur + delta, delta > 0 ? 1 : 0), Math.max(this.undoableMax, 0));
            this.countInput.value = next > 0 ? String(next) : '';
            this._syncControls();
        }

        _cleanNumber(value, max) {
            const digits = String(value || '').replace(/\D/g, '').replace(/^0+/, '');
            if (!digits) return '';
            return String(Math.min(parseInt(digits, 10), Math.max(max, 1)));
        }

        _open() {
            if (this.btn.disabled) return;
            // Re-clamp against the freshest log before showing the total.
            Log.getLog().then((log) => {
                this._applyCount(Log.undoableCount(log));
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
            // The total lives inside the field as its pale hint: the bare number.
            // The field and the steppers have no visible label, hence the aria ones
            // (re-set on every render, so they follow a language switch).
            this.countInput.placeholder = String(count);
            this.countInput.setAttribute('aria-label', t('undo_count_label'));
            this.minus.setAttribute('aria-label', t('undo_step_down'));
            this.plus.setAttribute('aria-label', t('undo_step_up'));
            // Re-clamp a value typed before the ceiling moved.
            this.countInput.value = this._cleanNumber(this.countInput.value, count);
            this._syncControls();
        }

        _syncControls() {
            const canStage = !!this.service;
            const n = parseInt(this.countInput.value, 10) || 0;
            this.minus.disabled = n <= 0;
            this.plus.disabled = n >= this.undoableMax;
            this.goCount.disabled = !canStage || !(n > 0);
            this.goTime.disabled = !canStage || !(parseInt(this.timeInput.value, 10) > 0);
        }

        // Renders from the ignore log itself (IgnoreLog.getLog — it is chunked
        // across keys, so a storage snapshot is not the shape to hand it).
        // Deliberately NOT surface-gated: staging works from either surface — the
        // mode only decides where the UI lives.
        render(log) {
            if (!this.btn) return;
            const count = Log ? Log.undoableCount(log || []) : 0;

            const disabled = !this.service || count === 0;
            this.btn.disabled = disabled;
            if (disabled) this.menu.classList.remove('open');
            const tipText = count === 0 ? t('undo_empty') : t('undo_button_title');
            if (this.tip) this.tip.textContent = tipText;
            this.btn.setAttribute('aria-label', tipText);

            this._applyCount(count);
        }
    }

    window.ILAP_Undo = { create: (root, service) => new UndoManager(root, service) };

})();
