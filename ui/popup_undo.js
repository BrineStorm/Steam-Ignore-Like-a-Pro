// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Undo applet: the ⟲ button left of the Last-Ignored chip and its droplist.
    // Games: "un-ignore the last X" by count (a −[ ]+ stepper around a digits-only
    // input clamped to what the log can actually undo) or by time (X hours/days),
    // the row picked by its radio mark, one Un-ignore for it. Staging goes
    // through UndoService into the shared curator queue; the drainer does the
    // rest. Creators: the account's ignored creators (src/creators.js) and an
    // Un-ignore that queues Steam's creator rollback. The tab line shows only
    // while there is one. Like the rest of the popup, this renders from full storage snapshots
    // pushed by popup_main — the menu DOM is built once (in the markup), renders
    // only update values/disabled states, so a re-render can't eat an open menu.

    const t = window.ILAP.t;

    // How long the open menu's height takes to follow a pane switch, as the
    // pane fades in (popup.css .undo-pane-in), and as long as a fold.
    const FOLD_MS = window.ILAP_Tabs.FOLD_MS;
    const fold = window.ILAP_Tabs.fold;
    const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
        // cannot stage (the Go buttons stay disabled). `opts.log`: the ignore log
        // (src/ignore-log.js). `opts.showQueue()`: opens the queue drawer, where a
        // staged rollback shows up.
        // `opts.unignoreCreator(clanid, name)`: queues a creator's rollback,
        // resolves to the store's outcome. `opts.holdCount()` and
        // `opts.flyToQueue(row, from)`: the queue's (popup_queue.js holdCount, flyIn).
        constructor(root, service, opts) {
            if (!opts || !opts.log) throw new TypeError('[ILAP] UndoManager needs opts.log');
            this.root = root;
            this.log = opts.log;
            this.showQueue = opts.showQueue || (() => {});
            this.unignoreCreator = opts.unignoreCreator || null;
            this.holdCount = opts.holdCount || (() => () => {});
            this.flyToQueue = opts.flyToQueue || (() => Promise.resolve());
            this.btn = root.getElementById('undo-btn');
            this.menu = root.getElementById('undo-menu');
            if (!this.btn || !this.menu) return;

            this.tip = root.getElementById('undo-tip');

            this.countInput = root.getElementById('undo-count');
            this.timeInput = root.getElementById('undo-time');
            this.minus = root.getElementById('undo-minus');
            this.plus = root.getElementById('undo-plus');
            this.pickCount = root.getElementById('undo-pick-count');
            this.pickTime = root.getElementById('undo-pick-time');
            this.go = root.getElementById('undo-go');
            this.tabs = root.getElementById('undo-tabs');
            this.tabGames = root.getElementById('undo-tab-games');
            this.tabCreators = root.getElementById('undo-tab-creators');
            this.paneGames = root.getElementById('undo-pane-games');
            this.paneCreators = root.getElementById('undo-pane-creators');
            this.creatorSelect = root.getElementById('undo-creator');
            this.creatorDisplay = root.getElementById('undo-creator-display');
            this.goCreator = root.getElementById('undo-go-creator');
            this.creators = new Map();   // clanid -> name, as the account has them
            this.unitH = root.getElementById('undo-unit-h');
            this.unitD = root.getElementById('undo-unit-d');
            this.msg = root.getElementById('undo-msg');

            this.service = service;

            this.undoableMax = 0;   // clamp ceiling for the count input (its pale hint)

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
            // Escape shuts the menu from anywhere in it, and focus goes back to the button.
            const onEscape = (e) => {
                if (e.key !== 'Escape' || !this.menu.classList.contains('open')) return;
                e.stopPropagation();
                this._close();
                this.btn.focus();
            };
            this.btn.addEventListener('keydown', onEscape);
            this.menu.addEventListener('keydown', onEscape);

            // Digits only, clamped to [1..undoableMax] — typing stays the classic
            // path, the steppers are just a second way in.
            // Typing in a row picks it and empties the other, so the one
            // Un-ignore never acts on a number the user is not looking at.
            this.countInput.addEventListener('input', () => {
                this.countInput.value = this._cleanNumber(this.countInput.value, this.undoableMax);
                this._pick('count');
            });
            this.timeInput.addEventListener('input', () => {
                this.timeInput.value = this._cleanNumber(this.timeInput.value, 9999);
                this._pick('time');
            });
            this.pickCount.addEventListener('change', () => this._pick('count', true));
            this.pickTime.addEventListener('change', () => this._pick('time', true));
            // A click into a field picks its row too, before anything is typed.
            this.countInput.addEventListener('focus', () => this._pick('count', true));
            this.timeInput.addEventListener('focus', () => this._pick('time', true));
            // Double-clicking the empty field takes the whole undoable list: the pale
            // placeholder is the total, so it doubles as its own "select all". Not a
            // single click — that is how you click in to type, and it must not arm Go
            // for a rollback of everything.
            this.countInput.addEventListener('dblclick', () => {
                if (this.countInput.value || !this.undoableMax) return;
                this.countInput.value = String(this.undoableMax);
                this.countInput.select();
                this._pick('count');
            });
            this._wireStep(this.minus, -1);
            this._wireStep(this.plus, 1);
            const pickUnit = (h) => {
                this.unitH.classList.toggle('selected', h);
                this.unitD.classList.toggle('selected', !h);
                this.unitH.setAttribute('aria-pressed', String(h));
                this.unitD.setAttribute('aria-pressed', String(!h));
                this._pick('time', true);
            };
            this.unitH.addEventListener('click', () => pickUnit(true));
            this.unitD.addEventListener('click', () => pickUnit(false));

            this.go.addEventListener('click', (e) => {
                if (!e.isTrusted) return;
                if (this.pickCount.checked) {
                    const n = parseInt(this.countInput.value, 10);
                    if (n > 0) this._stage(() => this.service.stageLastN(n), this.countInput.closest('.undo-row'));
                    return;
                }
                const n = parseInt(this.timeInput.value, 10);
                if (n > 0) {
                    const unit = this.unitH.classList.contains('selected') ? 'h' : 'd';
                    this._stage(() => this.service.stageSince(n, unit), this.timeInput.closest('.undo-row'));
                }
            });

            this._wireTabs();
            window.ILAP.PopupSelect.enhanceSelect(this.creatorSelect.closest('.select-shell'),
                this.creatorSelect, 'creator', this.root, (id) => this._creatorLabel(id));
            // The list opens down and must end above the panel's foot: below it
            // the toolbar window has nothing, and the list would be cut off.
            const shell = this.creatorSelect.closest('.select-shell');
            shell.querySelector('.select-display').addEventListener('click', () => {
                const panel = this.root.getElementById('popup-root');
                const menu = shell.querySelector('.select-menu');
                if (!panel || !menu) return;
                const room = panel.getBoundingClientRect().bottom - shell.getBoundingClientRect().bottom - 12;
                menu.style.maxHeight = Math.max(64, Math.floor(room)) + 'px';
            });
            this.creatorSelect.addEventListener('change', () => this._syncCreator());
            this.goCreator.addEventListener('click', (e) => {
                if (!e.isTrusted || !this.unignoreCreator) return;
                const id = this.creatorSelect.value;
                if (!this.creators.has(id)) return;
                this._stageCreator(() => this.unignoreCreator(id, this.creators.get(id)), this.goCreator.closest('.undo-row'));
            });
        }

        // The row the one Un-ignore acts on. `keep`: picked without typing, so
        // the other row's number stays.
        _pick(which, keep) {
            const count = which === 'count';
            this.pickCount.checked = count;
            this.pickTime.checked = !count;
            if (!keep) {
                const other = count ? this.timeInput : this.countInput;
                if (other.value) other.value = '';
            }
            this._syncControls();
        }

        // Games | Creators: one tab stop, the arrows move between the two.
        _wireTabs() {
            this.tabGames.addEventListener('click', () => this._selectTab(false));
            this.tabCreators.addEventListener('click', () => this._selectTab(true));
            this.tabs.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                this._selectTab(this.tabGames.getAttribute('aria-selected') === 'true', true);
            });
        }

        // `also`: one more change to the menu, made with the switch.
        _selectTab(creators, focus, also) {
            this.tabGames.setAttribute('aria-selected', String(!creators));
            this.tabCreators.setAttribute('aria-selected', String(creators));
            this.tabGames.tabIndex = creators ? -1 : 0;
            this.tabCreators.tabIndex = creators ? 0 : -1;
            const was = this.paneGames.hidden ? this.paneCreators : this.paneGames;
            this._morph(() => {
                this.paneGames.hidden = creators;
                this.paneCreators.hidden = !creators;
                const now = creators ? this.paneCreators : this.paneGames;
                // The pane coming in fades in where the other one was.
                if (now !== was && this.menu.classList.contains('open')) {
                    now.classList.remove('undo-pane-in');
                    void now.offsetWidth;
                    now.classList.add('undo-pane-in');
                }
                this._dropMsg();
                if (also) also();
            });
            if (focus) (creators ? this.tabCreators : this.tabGames).focus();
        }

        // Makes `mutate`'s change to the open menu, its height going from the
        // old one to the new in FOLD_MS instead of in one frame.
        _morph(mutate) {
            const menu = this.menu;
            if (!menu.classList.contains('open') || reduceMotion() || !menu.animate) { mutate(); return; }
            const from = menu.getBoundingClientRect().height;
            if (this._morphAnim) this._morphAnim.cancel();
            mutate();
            const to = menu.getBoundingClientRect().height;
            if (Math.abs(from - to) < 0.5) return;
            const anim = this._morphAnim = menu.animate([
                { height: from + 'px', overflow: 'hidden' }, { height: to + 'px', overflow: 'hidden' },
            ], { duration: FOLD_MS, easing: 'ease' });
            anim.onfinish = () => { if (this._morphAnim === anim) this._morphAnim = null; };
        }

        _creatorLabel(id) {
            return this.creators.get(id) || id;
        }

        // The droplist's display and its button, after a pick or a render.
        _syncCreator() {
            const id = this.creatorSelect.value;
            this.creatorDisplay.textContent = id ? this._creatorLabel(id) : '';
            this.goCreator.disabled = !this.unignoreCreator || !this.creators.has(id);
        }

        // The account's ignored creators, sorted by name. The last one gone
        // takes the tab line with it, and the menu is Games alone again.
        _renderCreators(creators) {
            this.creators = new Map(Array.from(creators).sort((a, b) =>
                String(a[1] || a[0]).localeCompare(String(b[1] || b[0]))));
            // The line folds in and out. With the Creators pane open it goes
            // with the switch back to Games.
            const show = this.creators.size > 0;
            if (!show && this.tabCreators.getAttribute('aria-selected') === 'true') {
                this._selectTab(false, false, () => { if (this.tabs._ilapFold) this.tabs._ilapFold.cancel(); this.tabs.hidden = true; });
            } else if (this.menu.classList.contains('open')) {
                fold(this.tabs, show);
            } else {
                this.tabs.hidden = !show;
            }
            const keep = this.creatorSelect.value;
            const ids = Array.from(this.creators.keys());
            const current = Array.from(this.creatorSelect.options).map(o => o.value);
            if (ids.join(',') !== current.join(',')) {
                this.creatorSelect.textContent = '';
                for (const id of ids) {
                    const opt = document.createElement('option');
                    opt.value = id;
                    this.creatorSelect.appendChild(opt);
                }
            }
            // Names may arrive after the ids (src/creators.js reads them).
            for (const opt of this.creatorSelect.options) opt.textContent = this._creatorLabel(opt.value);
            this.creatorSelect.value = this.creators.has(keep) ? keep : (ids[0] || '');
            this._syncCreator();
        }

        async _stageCreator(start, row) {
            const fly = this._takeRow(row);
            const release = this.holdCount();
            let outcome;
            try {
                outcome = await start();
            } catch (e) {
                console.warn('[ILAP] creator un-ignore failed:', e);
                release(false);
                return;
            }
            if (outcome && outcome.kind === 'added') { await this._flyAway(fly, release); return; }
            release(false);
            this._showMsg(t('creator_queue_stuck'));
        }

        // Where a row stood and a copy of it with its numbers, taken before the
        // menu goes.
        _takeRow(row) {
            if (!row) return null;
            const copy = row.cloneNode(true);
            const inputs = row.querySelectorAll('input');
            copy.querySelectorAll('input').forEach((el, i) => {
                const src = inputs[i];
                el.setAttribute('value', src.value);
                // The field is drawn by `.undo-menu input` and its id, which the
                // copy flying outside the menu has neither: its look goes inline,
                // or it flies as a white browser field.
                const cs = getComputedStyle(src);
                for (const p of ['background-color', 'color', 'border', 'border-radius', 'font-size', 'font-weight',
                    'font-family', 'text-align', 'padding', 'box-sizing']) el.style.setProperty(p, cs.getPropertyValue(p));
                const r = src.getBoundingClientRect();
                el.style.width = r.width + 'px';
                el.style.height = r.height + 'px';
            });
            return { copy, from: row.getBoundingClientRect() };
        }

        // A staged rollback: its row flies into the job count in place of a
        // message under the menu (the message did not fit the panel's
        // height), the menu shuts as it goes, and the queue opens on
        // the new job once it has landed.
        async _flyAway(fly, release) {
            this._dropMsg();
            this._close();
            if (fly) await this.flyToQueue(fly.copy, fly.from);
            release(true);
            this.showQueue();
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
            this.log.getLog().then((log) => {
                this._applyCount(this.log.undoableCount(log));
                this.menu.classList.add('open');
                this.btn.setAttribute('aria-expanded', 'true');
            }).catch((e) => console.warn('[ILAP] undo log read failed:', e));
        }

        _close() {
            this.menu.classList.remove('open');
            this.btn.setAttribute('aria-expanded', 'false');
            this._showMsg(null);
        }

        // Nothing awaits this (the Go buttons call it): in the widget, a rejected
        // storage call (an extension update) ends here as one warn line.
        async _stage(start, row) {
            const fly = this._takeRow(row);
            // The count holds its number until the row lands.
            const release = this.holdCount();
            let outcome;
            try {
                outcome = await start();
            } catch (e) {
                console.warn('[ILAP] undo staging failed:', e);
                release(false);
                return;
            }
            if (!outcome) { release(false); return; }
            if (outcome.kind === 'added') { await this._flyAway(fly, release); return; }
            release(false);
            const key = outcome.kind === 'exists' ? 'undo_msg_exists'
                : outcome.kind === 'full' ? 'undo_msg_full'
                : 'undo_msg_empty';
            this._showMsg(t(key));
        }

        // The message folds in under the menu and out of it. A new text in
        // its place takes the menu's height from the old one's.
        _showMsg(text) {
            if (!this.msg) return;
            const el = this.msg;
            if (!text) { fold(el, false); return; }
            if (!el.hidden && !el._ilapFold) {
                if (el.textContent !== text) this._morph(() => { el.textContent = text; });
            } else {
                el.textContent = text;
                fold(el, true);
            }
        }

        // The message off at once, inside a change _morph moves.
        _dropMsg() {
            if (!this.msg) return;
            if (this.msg._ilapFold) { this.msg._ilapFold.cancel(); this.msg._ilapFold = null; this.msg.style.overflow = ''; }
            this.msg.hidden = true;
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
            const picked = this.pickCount.checked ? n : (parseInt(this.timeInput.value, 10) || 0);
            this.go.disabled = !canStage || !(picked > 0);
        }

        // Renders from the ignore log itself (IgnoreLog.getLog — it is chunked
        // across keys, so a storage snapshot is not the shape to hand it).
        // Deliberately NOT surface-gated: staging works from either surface — the
        // mode only decides where the UI lives.
        // `creators`: Map clanid -> name of the creators the account ignores, as
        // the user sees them (Creators.effective).
        render(log, creators) {
            if (!this.btn) return;
            const count = this.log.undoableCount(log || []);
            this._renderCreators(creators || new Map());

            const disabled = !this.service || (count === 0 && this.creators.size === 0);
            this.btn.disabled = disabled;
            if (disabled) this.menu.classList.remove('open');
            const tipText = count === 0 && this.creators.size === 0 ? t('undo_empty') : t('undo_button_title');
            if (this.tip) this.tip.textContent = tipText;
            this.btn.setAttribute('aria-label', tipText);

            this._applyCount(count);
        }
    }

    window.ILAP_Undo = { create: (root, service, opts) => new UndoManager(root, service, opts) };

})();
