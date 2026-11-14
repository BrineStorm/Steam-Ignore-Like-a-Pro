// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.Curator = window.ILAP.Curator || {};

    // How long the menu takes to fade out after a pick.
    const FADE_MS = 500;

    // The button's states its one width has to fit: Add, Added with the square,
    // the post-pick flash.
    const FIT_STATES = [['curator_add_to_queue', false], ['curator_added_state', true], ['curator_added', true]];

    const isShown = (menu) => menu.classList.contains('open') && !menu.classList.contains('closing');

    // The filter menu of the curator button: what its rows say, where it sits,
    // the button's width, and the mouse's and the keyboard's way through it. What
    // a pick or a cross does is the caller's (curator/main.js).
    //   t(key, params), esc(text)   the panel's language, src/escape.js
    //   filters                     window.ILAP_Filters (src/curator/filters.js)
    function createButtonMenu({ t, esc, filters }) {
        // `queued`: the filters of this curator's queued jobs. `types`: the review
        // types they cover (ILAP_Filters.coveredTypes). A queued filter is
        // highlighted, and one those jobs cover is locked ("All except Recommended"
        // queued locks the two others, both of those queued locks it). Both kinds
        // take no pick until the job is removed or runs to its end. A queued one has
        // the "In queue" pill and a cross that removes its job from here; Pause lives
        // in the queue applet.
        function rowsHtml(queued, types, undoneAgoMs) {
            // Soft ping-pong flag: this curator's ignores were rolled back via
            // undo within the warning window. Informational only — the rows
            // below stay fully clickable (a re-stage right after an undo is a
            // legitimate "picked the wrong filter" flow).
            let html = '';
            if (!types.size && undoneAgoMs > 0) {
                const hours = Math.max(1, Math.round(undoneAgoMs / 3600000));
                html += `<div class="ilap-curator-warn">⚠ ${esc(t('undo_restage_warning', { h: hours }))}</div>`;
            }
            const remove = esc(t('queue_remove'));
            const pill = `<span class="ilap-opt-pill">${esc(t('curator_in_queue'))}</span>`;
            // The rows and the cross are the menu's items for the keyboard too
            // (wire: arrows, Enter, Escape). A queued or locked row takes
            // no pick and the arrows pass it. A locked one is aria-disabled; a
            // queued one is not, its cross inside it is live.
            const cross = (name) => `<span class="ilap-opt-del" data-act="remove" role="menuitem" tabindex="-1" title="${remove}" aria-label="${remove}: ${name}">✕</span>`;
            return html + filters.FILTERS.map(f => {
                const own = queued.has(f.value);
                const locked = !own && !filters.filterToAdd(types, f.value);
                const state = own ? ' active' : locked ? ' locked' : '';
                const name = esc(t(f.key));
                return `<div class="ilap-curator-opt${state}" role="menuitem" tabindex="-1"${locked ? ' aria-disabled="true"' : ''} data-value="${f.value}"><span class="ilap-opt-dot" style="${filters.fillStyle(f.value)}"></span><span class="ilap-opt-name">${name}${own ? pill : ''}</span>${own ? cross(name) : ''}</div>`;
            }).join('');
        }

        // On <body> (position:fixed), so no Steam ancestor stacking context or
        // overflow can clip it. Returns the menu + its renderer.
        // Every queue change re-renders — even while the menu is OPEN — so two
        // windows can never keep diverging add-/added-variants of this droplist.
        function build() {
            const menu = document.createElement('div');
            menu.className = 'ilap-curator-menu';
            menu.setAttribute('role', 'menu');
            menu.setAttribute('aria-label', t('curator_add_to_queue'));
            document.body.appendChild(menu);

            const render = (queued, types, undoneAgoMs) => {
                menu.innerHTML = rowsHtml(queued, types, undoneAgoMs);
            };
            render(new Set(), new Set(), 0);
            return { menu, render };
        }

        // The width of the menu's plain rows (no pill, no cross), read off an
        // invisible copy so the menu's own min-width (synced to the button) never
        // feeds back into the button.
        function rowsWidth() {
            const probe = document.createElement('div');
            probe.className = 'ilap-curator-menu open';
            probe.style.visibility = 'hidden';
            probe.innerHTML = filters.FILTERS.map(f => `<div class="ilap-curator-opt"><span class="ilap-opt-dot"></span><span class="ilap-opt-name">${esc(t(f.key))}</span></div>`).join('');
            document.body.appendChild(probe);
            const w = probe.getBoundingClientRect().width;
            probe.remove();
            return w;
        }

        // One fixed width for the button: the widest of its own states and of the
        // menu's rows, so a pick or a queue change never moves it. A change that
        // still moves it (a language switch, Steam's webfont arriving) animates
        // over 0.3 s.
        function fitWidth(btn) {
            const lbl = btn.querySelector('.ilap-cur-label');
            const square = btn.querySelector('.ilap-cur-sq');
            const first = !btn.style.width;
            const from = btn.getBoundingClientRect().width;
            // A running animation would override the auto width being measured.
            btn.getAnimations().forEach(a => a.cancel());
            const text = lbl.textContent, sqHidden = square.hidden;
            btn.style.width = 'auto';
            let w = rowsWidth();
            for (const [key, sq] of FIT_STATES) {
                lbl.textContent = t(key);
                square.hidden = !sq;
                w = Math.max(w, btn.getBoundingClientRect().width);
            }
            lbl.textContent = text;
            square.hidden = sqHidden;
            w = Math.ceil(w);
            btn.style.width = w + 'px';
            if (first || Math.abs(from - w) < 0.5) return;
            if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
            btn.animate([{ width: from + 'px' }, { width: w + 'px' }], { duration: 300, easing: 'ease' });
        }

        // Under the button, left edges aligned, at least as wide as the button. The
        // menu can be wider (a queued row's pill and cross) and then grows to the
        // right, or to the left when the window ends first.
        function place(btn, menu) {
            const r = btn.getBoundingClientRect();
            menu.style.top = (r.bottom + 9) + 'px';
            // The fitted width, not r.width, which lags while the width animates.
            menu.style.minWidth = (parseFloat(btn.style.width) || r.width) + 'px';
            const room = document.documentElement.clientWidth - 8;
            menu.style.left = Math.max(8, Math.min(r.left, room - menu.offsetWidth)) + 'px';
        }

        // Wire open/close, option picking, the cross on a queued row, and dismissal
        // (outside click + scroll/resize reposition guard — the fixed menu would
        // otherwise detach from the button).
        //   redraw()         draws the menu from the queue as it is now, as it opens
        //   onPick(value)    a row was picked
        //   onRemove(value)  a queued row's cross was pressed
        function wire({ wrap, btn, menu, signal, redraw, onPick, onRemove }) {
            let fadeTimer = 0;
            btn.setAttribute('aria-haspopup', 'menu');
            btn.setAttribute('aria-expanded', 'false');
            const close = () => {
                clearTimeout(fadeTimer);
                menu.classList.remove('open', 'closing');
                btn.setAttribute('aria-expanded', 'false');
            };
            // The keyboard's way through the menu (Section 508): the rows that take
            // a pick and the crosses, in order. It sits on <body>, away from the
            // button, so Tab never reaches it: the button opens it onto its first item.
            const items = () => [...menu.querySelectorAll('.ilap-curator-opt:not(.active):not(.locked), .ilap-opt-del')];
            const focusItem = (i) => {
                const all = items();
                if (all.length) all[(i + all.length) % all.length].focus();
            };
            // A fading menu counts as closed: the button opens it again at once.
            const fadeOut = () => {
                menu.classList.add('closing');
                clearTimeout(fadeTimer);
                fadeTimer = setTimeout(close, FADE_MS);
            };
            const open = () => {
                close();
                redraw();
                menu.classList.add('open');
                btn.setAttribute('aria-expanded', 'true');
                place(btn, menu);
            };
            signal.addEventListener('abort', () => clearTimeout(fadeTimer), { once: true });

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!e.isTrusted) return; // real clicks only — a page script can't open the menu
                if (btn.disabled) return;
                const shown = isShown(menu);
                shown ? close() : open();
                if (!shown && e.detail === 0) focusItem(0);   // Enter or Space on the button
            });
            btn.addEventListener('keydown', (e) => {
                if (!e.isTrusted || e.key !== 'ArrowDown' || btn.disabled) return;
                e.preventDefault();
                if (!isShown(menu)) open();
                focusItem(0);
            });

            // A row picked, or a cross pressed, by a real click or a real key.
            // `byKey`: after a pick the focus goes back to the button, after a
            // removal to the same row once the sync has redrawn the menu.
            let refocus = null;
            const activate = (target, byKey) => {
                const opt = target.closest('.ilap-curator-opt');
                if (!opt) return;
                const value = opt.getAttribute('data-value');
                // The cross: that filter's job leaves the queue. The menu stays open,
                // and the storage sync redraws it (what the job locked is free again).
                if (target.closest('[data-act="remove"]')) {
                    if (byKey) refocus = value;
                    onRemove(value);
                    return;
                }
                if (opt.classList.contains('active') || opt.classList.contains('locked')) return;
                fadeOut();
                onPick(value);
                if (byKey) btn.focus();
            };
            menu.addEventListener('click', (e) => {
                if (!e.isTrusted) return; // real clicks only — a page script can't stage a bulk job
                activate(e.target, false);
            });
            menu.addEventListener('keydown', (e) => {
                if (!e.isTrusted) return; // real keys only, as the clicks
                const i = items().indexOf(document.activeElement);
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    focusItem(i + (e.key === 'ArrowDown' ? 1 : -1));
                } else if (e.key === 'Home' || e.key === 'End') {
                    e.preventDefault();
                    focusItem(e.key === 'Home' ? 0 : -1);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    close();
                    btn.focus();
                } else if (e.key === 'Tab') {
                    close();
                } else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) {
                    e.preventDefault();
                    activate(document.activeElement, true);
                }
            });
            const redrawn = new MutationObserver(() => {
                if (refocus === null || !menu.classList.contains('open')) return;
                const row = menu.querySelector(`.ilap-curator-opt[data-value="${refocus}"]`);
                refocus = null;
                if (row && !row.matches('.active, .locked')) row.focus();
                else if (items().length) focusItem(0);
                else btn.focus();
            });
            redrawn.observe(menu, { childList: true });
            signal.addEventListener('abort', () => redrawn.disconnect(), { once: true });

            // These outlive the button's nodes: bound to the injection's AbortController
            // so a master-toggle removal takes them along.
            document.addEventListener('click', (e) => {
                if (!menu.contains(e.target) && !wrap.contains(e.target)) close();
            }, { signal });
            window.addEventListener('scroll', close, { capture: true, signal });
            window.addEventListener('resize', close, { signal });
        }

        return { rowsHtml, build, fitWidth, place, wire, isShown };
    }

    window.ILAP.Curator.createButtonMenu = createButtonMenu;
})();
