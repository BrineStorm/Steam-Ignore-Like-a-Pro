// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // On a curator page: an "Add to ignore queue" button before the Options gear
    // in `.nav_right_side > .curator_report`, with its own filter menu. Picking a
    // filter stages a job through the EnqueueService, which also resolves its app
    // list; a queued filter's row in the same menu has the cross that removes its
    // job (Pause lives in the queue applet). Draining is the drainer's (curator/drainer.js).

    const t = window.ILAP.t;

    const BTN_ID = 'ilap-curator-enqueue';
    const STYLE_ID = 'ilap-curator-style';

    // Convex azure button — gradient + inset top highlight (promo slide-05 mock).
    const BTN_BG = 'linear-gradient(180deg, #3aa0ec, #1f7fd6)';
    const BTN_BG_HOVER = 'linear-gradient(180deg, #4bacf2, #2b8ce0)';
    const ICON_URL = chrome.runtime.getURL('assets/icons/icon48.png');
    // How long the menu takes to fade out after a pick.
    const FADE_MS = 500;

    // Filter vocabulary + label colours are shared with the popup applet (see
    // src/curator/filters.js, loaded before this script).
    const Filters = window.ILAP_Filters;
    const Store = window.ILAP.Curator.Store;
    const FILTERS = Filters.FILTERS;
    const typeStyle = (value) => Filters.colorStyle(value);

    // Shared HTML-escaper (src/escape.js, loaded before this script).
    const esc = window.ILAP.Sanitizer.escapeHTML;

    // /curator/<id>-<slug>/ → numeric id, or null on any other store page.
    // Shared parser (src/curator/filters.js) so main.js and the popup applet agree.
    const curatorId = () => Filters.curatorIdFromPath(location.pathname);

    // Boundary normalizer: the curator name comes from a third-party page (or a
    // crafted URL slug) and is persisted, so reduce it to bounded plain text
    // before it reaches storage (src/escape.js, loaded before this script).
    const clean = window.ILAP.Sanitizer.sanitizeName;

    function curatorName(id) {
        const el = document.querySelector('.curator_name');
        const name = el && el.textContent ? el.textContent.trim() : '';
        if (name) return clean(name);
        // Fall back to the URL slug so the job always has a readable label.
        const m = location.pathname.match(/^\/curator\/\d+-(.+?)\/?$/);
        if (!m) return clean(id);
        let slug;
        try { slug = decodeURIComponent(m[1]); } catch (e) { slug = m[1]; }
        return clean(slug.replace(/-/g, ' '));
    }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            /* Top-align with the curator tabs (Featured/Lists/About). Those tabs
               start at the nav bar's top edge, but .curator_report adds a 6px
               padding-top, so a vertical-align:middle control sits ~6px lower and
               its 32px height then stretches the whole nav bar row. vertical-align:
               top + margin-top:-6px cancels that padding so the button's top edge
               lines up with the tabs and it no longer drags the row taller. */
            .ilap-curator-ctl { position: relative; display: inline-flex; align-items: center; margin-right: 8px; vertical-align: top; margin-top: -6px; }
            /* ILAP logo inside the button, marking this as an extension control. */
            .ilap-cur-logo { width: 22px; height: 22px; border-radius: 6px; display: block; }
            #${BTN_ID} {
                display: inline-flex; align-items: center; gap: 9px;
                /* Convex look: our own gradient + inset top highlight + drop shadow.
                   !important overrides Steam's default button skin. */
                background-color: transparent !important;
                background-image: ${BTN_BG} !important;
                box-shadow: 0 10px 26px rgba(20,90,170,.5), inset 0 1px 0 rgba(255,255,255,.28) !important;
                filter: none !important;
                color: #fff !important; border: none; cursor: pointer;
                font: 700 14px "Motiva Sans", Arial, sans-serif; padding: 0 13px; height: 36px;
                border-radius: 9px; white-space: nowrap;
            }
            #${BTN_ID}:hover { background-image: ${BTN_BG_HOVER} !important; }
            #${BTN_ID}:disabled { opacity: .7; cursor: default; }
            /* What this curator has in the queue, before "Added": a square in the
               filter's colour, as on the job's strip in the queue applet. */
            .ilap-cur-sq { width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0; position: relative; }
            .ilap-cur-sq[hidden], .ilap-cur-div[hidden] { display: none; }
            /* The bar between the logo and the square, shown with the square. */
            .ilap-cur-div { width: 1px; height: 18px; flex-shrink: 0; background: rgba(255,255,255,.35); }
            .ilap-cur-sq::after { content: ''; position: absolute; inset: -4px; }
            /* The square's tip, drawn like the applet's (popup.css .queue-filter-tip).
               On <body> and fixed, like the menu, so no Steam ancestor clips it. */
            .ilap-cur-tip {
                visibility: hidden; opacity: 0;
                position: fixed; z-index: 2147483001;
                width: max-content; max-width: 220px; padding: 5px 8px;
                background: #101a26; color: #c7d5e0; border: 1px solid #45A1FA; border-radius: 6px;
                box-shadow: 0 4px 15px rgba(0,0,0,0.8);
                font: 600 11px/1.35 "Motiva Sans", Arial, sans-serif;
                pointer-events: none; transition: opacity .2s, visibility .2s; transition-delay: 0s;
            }
            .ilap-cur-tip.show { visibility: visible; opacity: 1; transition-delay: .4s; }
            /* Menu lives on <body> (position:fixed) so no Steam ancestor stacking
               context / overflow can clip it or push it under the .page_desc below. */
            .ilap-curator-menu {
                display: none; position: fixed; z-index: 2147483000;
                /* border-box so min-width (synced to the button) is the FULL box:
                   under content-box the 1px borders would land outside it and the
                   open menu would sit 2px wider than the button it must match. */
                box-sizing: border-box;
                background: linear-gradient(180deg, #1b2a3c, #131e2a);
                border: 1px solid rgba(102,192,244,.3); border-radius: 12px;
                padding: 0;
                box-shadow: 0 24px 62px rgba(2,8,20,.62), 0 0 0 1px rgba(0,0,0,.4) inset;
                white-space: nowrap;
            }
            .ilap-curator-menu.open { display: block; }
            /* After a pick the menu fades out (wireMenu fadeOut), and takes no
               clicks while it does. */
            .ilap-curator-menu.closing { opacity: 0; pointer-events: none; transition: opacity ${FADE_MS}ms ease; }
            @media (prefers-reduced-motion: reduce) { .ilap-curator-menu.closing { transition: none; } }
            /* No overflow clip (a queued row's pill hangs over its edge), so the
               end rows round their own backgrounds into the menu's corners. */
            .ilap-curator-menu > :first-child { border-radius: 11px 11px 0 0; }
            .ilap-curator-menu > :last-child { border-radius: 0 0 11px 11px; }
            .ilap-curator-opt {
                display: flex; align-items: center; gap: 11px;
                height: 36px; padding: 0 15px; cursor: pointer; color: #c7d5e0;
                font: 500 13.5px "Motiva Sans", Arial, sans-serif;
                border-bottom: 1px solid rgba(255,255,255,.05);
            }
            .ilap-curator-opt:last-child { border-bottom: 0; }
            .ilap-curator-opt:hover { background: rgba(102,192,244,.12); color: #fff; }
            .ilap-curator-opt.active {
                background: linear-gradient(90deg, rgba(66,135,245,.30), rgba(66,135,245,.08));
                color: #fff; font-weight: 700;
            }
            /* Each filter's square, the one the button and the queue applet show. */
            .ilap-opt-dot { width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0; }
            /* A filter already in the queue (.active) and one the queued jobs
               cover (.locked) take no pick. A queued one wears the "In queue" pill
               and the cross that removes its job; a locked one is only dimmed. */
            .ilap-curator-opt.active, .ilap-curator-opt.locked { cursor: default; }
            .ilap-curator-opt.locked { color: #6b7a88; }
            .ilap-curator-opt.locked:hover { background: none; color: #6b7a88; }
            .ilap-curator-opt.locked .ilap-opt-dot { opacity: .45; }
            /* Stamped in one place on every queued row, left of the cross, over
               the end of a long name, out of the flow. A third of it hangs over the
               row below (under the menu's edge on the last row). */
            .ilap-curator-opt.active { position: relative; }
            .ilap-opt-pill {
                position: absolute; right: 36px; bottom: -5px; z-index: 2;
                padding: 2px 5px; border-radius: 3px; white-space: nowrap; pointer-events: none;
                background: linear-gradient(90deg, #06bfff, #2d73ff); color: #fff;
                box-shadow: 0 1px 4px rgba(0,0,0,.45);
                font: 700 8px/1 "Motiva Sans", Arial, sans-serif;
                text-transform: uppercase; letter-spacing: .4px;
            }
            .ilap-opt-del {
                display: inline-flex; align-items: center; justify-content: center;
                width: 20px; height: 20px; margin: 0 -5px 0 auto; border-radius: 4px;
                color: #8f98a0; font: 700 12px/1 Arial, sans-serif; cursor: pointer;
            }
            .ilap-opt-del:hover { color: #ff6a4d; background: rgba(211,47,47,.18); }
            /* Soft re-stage warning: the user recently UNDID this curator's
               ignores — staging again is allowed (never blocked), just flagged. */
            .ilap-curator-warn {
                display: flex; align-items: center; gap: 8px;
                padding: 8px 15px; color: #ffd21a;
                font: 500 11.5px "Motiva Sans", Arial, sans-serif;
                border-bottom: 1px solid rgba(255,255,255,.05);
                white-space: normal; max-width: 300px; line-height: 1.35;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function flash(btn, text) {
        const lbl = btn.querySelector('.ilap-cur-label');
        lbl.textContent = text;
        btn.disabled = true;
        setTimeout(() => { lbl.textContent = btn.dataset.label; btn.disabled = false; }, 1600);
    }

    const filterKey = (value) => Filters.labelKey(value);

    // Message layer over the shared bottom-right push card (src/toast.js): when
    // the message has a "{type}" placeholder, the category name is highlighted
    // bold in its colour; everything else is plain escaped text.
    function showToast(msgKey, value, duration) {
        const tpl = t(msgKey);
        let html;
        if (value != null && tpl.indexOf('{type}') !== -1) {
            const parts = tpl.split('{type}');
            html = esc(parts[0] || '')
                + `<b style="${typeStyle(value)}">${esc(t(filterKey(value)))}</b>`
                + esc(parts[1] || '');
        } else {
            html = esc(tpl);
        }
        // The markup variant on purpose: `html` above is assembled here, with
        // every interpolated part already escaped.
        window.ILAP.showToastHtml(html, duration);
    }

    // Pick a filter: add a job for what the queue lacks of it (with one review
    // type queued, the other one, EnqueueService.stage). The service owns staging
    // and resolution; this gathers the page inputs and answers with the toast and
    // the flash.
    function pick(service, value, btn) {
        const id = curatorId();
        if (!id) return;
        const name = curatorName(id);
        // Nothing awaits a pick: a rejected storage call (an extension update
        // leaves this page's script running with no storage) ends here as one
        // warn line.
        const swallow = (e) => console.warn('[ILAP] curator pick failed:', e);
        service.stage(id, name, value).then((outcome) => {
            if (!outcome) return;
            if (outcome.kind === 'full') { showToast('curator_toast_full', null, 4500); return; }
            flash(btn, t('curator_added'));
            showToast('curator_toast_added', outcome.filter);
            return service.resolve(id, outcome.jobId, outcome.name, outcome.filter).then((res) => {
                // Enumeration produced no drainable list (fetch/parse failure, or
                // nothing under this filter) — the job was dropped, so tell the user
                // instead of leaving them with a silently vanished button state.
                if (res && res.error) showToast('curator_toast_error', null, 4500);
                // Or it produced a SHORT one: a read died part-way, so the job is
                // real but covers only what was read. Said out loud, because the
                // row would otherwise look like a complete curator with a small
                // catalogue — and re-adding is what finishes the job.
                else if (res && res.partial) showToast('curator_toast_partial', null, 5000);
            });
        }).catch(swallow);
    }

    // Build the control (logo + square + label) and place it just before the
    // Options gear (the first <a> in the report). Returns the wrapper + button.
    function buildButton(report) {
        const label = t('curator_add_to_queue');
        const wrap = document.createElement('span');
        wrap.className = 'ilap-curator-ctl';
        wrap.innerHTML = `
            <button type="button" id="${BTN_ID}">
                <img class="ilap-cur-logo" src="${ICON_URL}" alt="">
                <span class="ilap-cur-div" hidden></span>
                <span class="ilap-cur-sq" hidden></span>
                <span class="ilap-cur-label">${esc(label)}</span>
            </button>`;

        const gear = report.querySelector('a');
        if (gear) report.insertBefore(wrap, gear);
        else report.appendChild(wrap);

        const btn = wrap.querySelector('#' + BTN_ID);
        btn.dataset.label = label;
        return { wrap, btn };
    }

    // Create the filter dropdown on <body> (position:fixed, so no Steam ancestor
    // stacking context / overflow can clip it). Returns the menu + its renderer.
    // renderMenu takes the filters of this curator's queued jobs and the review
    // types they cover (ILAP_Filters.coveredTypes). A queued filter is
    // highlighted, and one those jobs cover is locked ("All except Recommended"
    // queued locks the two others, both of those queued locks it). Both kinds
    // take no pick until the job is removed or runs to its end. A queued one has
    // the "In queue" pill and a cross that removes its job from here; Pause lives
    // in the queue applet.
    // Every queue change re-renders — even while the menu is OPEN — so two
    // windows can never keep diverging add-/added-variants of this droplist.
    function buildMenu() {
        const menu = document.createElement('div');
        menu.className = 'ilap-curator-menu';
        document.body.appendChild(menu);

        const renderMenu = (queued, types, undoneAgoMs) => {
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
            const cross = `<span class="ilap-opt-del" data-act="remove" role="button" title="${remove}" aria-label="${remove}">✕</span>`;
            html += FILTERS.map(f => {
                const own = queued.has(f.value);
                const locked = !own && !Filters.filterToAdd(types, f.value);
                const state = own ? ' active' : locked ? ' locked' : '';
                return `<div class="ilap-curator-opt${state}" data-value="${f.value}"><span class="ilap-opt-dot" style="${Filters.fillStyle(f.value)}"></span><span class="ilap-opt-name">${esc(t(f.key))}${own ? pill : ''}</span>${own ? cross : ''}</div>`;
            }).join('');
            menu.innerHTML = html;
        };
        renderMenu(new Set(), new Set(), 0);
        return { menu, renderMenu };
    }

    // Under the button, left edges aligned, at least as wide as the button. The
    // menu can be wider (a queued row's pill and cross) and then grows to the
    // right, or to the left when the window ends first.
    function placeMenu(btn, menu) {
        const r = btn.getBoundingClientRect();
        menu.style.top = (r.bottom + 9) + 'px';
        menu.style.minWidth = r.width + 'px';
        const room = document.documentElement.clientWidth - 8;
        menu.style.left = Math.max(8, Math.min(r.left, room - menu.offsetWidth)) + 'px';
    }

    // Wire open/close, option picking, the cross on a queued row, and dismissal
    // (outside click + scroll/resize reposition guard — the fixed menu would
    // otherwise detach from the button).
    function wireMenu(wrap, btn, menu, signal, service) {
        let fadeTimer = 0;
        const close = () => {
            clearTimeout(fadeTimer);
            menu.classList.remove('open', 'closing');
        };
        // A fading menu counts as closed: the button opens it again at once.
        const fadeOut = () => {
            menu.classList.add('closing');
            clearTimeout(fadeTimer);
            fadeTimer = setTimeout(close, FADE_MS);
        };
        const open = () => {
            close();
            menu.classList.add('open');
            placeMenu(btn, menu);
        };
        signal.addEventListener('abort', () => clearTimeout(fadeTimer), { once: true });

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!e.isTrusted) return; // real clicks only — a page script can't open the menu
            if (btn.disabled) return;
            const shown = menu.classList.contains('open') && !menu.classList.contains('closing');
            shown ? close() : open();
        });

        menu.addEventListener('click', (e) => {
            if (!e.isTrusted) return; // real clicks only — a page script can't stage a bulk job
            const opt = e.target.closest('.ilap-curator-opt');
            if (!opt) return;
            // The cross: that filter's job leaves the queue. The menu stays open,
            // and the storage sync redraws it (what the job locked is free again).
            if (e.target.closest('[data-act="remove"]')) {
                const id = curatorId();
                if (id) {
                    service.removeQueued(id, opt.getAttribute('data-value'))
                        .catch((err) => console.warn('[ILAP] curator job removal failed:', err));
                }
                return;
            }
            if (opt.classList.contains('active') || opt.classList.contains('locked')) return;
            fadeOut();
            pick(service, opt.getAttribute('data-value'), btn);
        });

        // These outlive the button's nodes: bound to the injection's AbortController
        // so a master-toggle removal takes them along.
        document.addEventListener('click', (e) => {
            if (!menu.contains(e.target) && !wrap.contains(e.target)) close();
        }, { signal });
        window.addEventListener('scroll', close, { capture: true, signal });
        window.addEventListener('resize', close, { signal });
    }

    // The square's tip: the queued filter's name, in a box over the square after
    // the applet's hover delay. Its text is the square's data-tip (set by the
    // sync), read on each hover so a change elsewhere shows on the next one.
    function wireSquareTip(square, signal) {
        const tip = document.createElement('div');
        tip.className = 'ilap-cur-tip';
        tip.setAttribute('role', 'tooltip');
        document.body.appendChild(tip);
        square.addEventListener('mouseenter', () => {
            tip.textContent = square.dataset.tip || '';
            const r = square.getBoundingClientRect();
            tip.style.left = r.left + 'px';
            tip.style.top = (r.top - tip.offsetHeight - 4) + 'px';
            tip.classList.add('show');
        }, { signal });
        square.addEventListener('mouseleave', () => tip.classList.remove('show'), { signal });
        signal.addEventListener('abort', () => tip.remove(), { once: true });
    }

    // Reflect already-queued state (button label + the square of what is queued
    // + the menu's queued and locked rows) now and whenever the queue changes
    // (here, in the popup applet, in another tab/window, or a job that ran to its
    // end). The re-render also hits an
    // OPEN menu, so a queue change elsewhere swaps this droplist's variant live.
    // Every subscription is bound to `signal`, like wireMenu's listeners: aborting
    // the injection's controller is the whole unsubscribe, whatever channels this adds.
    function wireStorageSync(btn, menu, renderMenu, signal) {
        const square = btn.querySelector('.ilap-cur-sq');
        wireSquareTip(square, signal);
        // Optional, like the drainer's log hooks: without the module the button
        // still works, only the soft re-stage warning is skipped.
        const Log = window.ILAP.IgnoreLog;
        // Recently-undone window for the soft re-stage warning.
        const WARN_WINDOW_MS = 48 * 3600000;
        const readLog = () => (Log ? Log.getLog() : Promise.resolve([]));
        // Aborted = injection removed. The subscriptions go with it; this guard
        // covers a read still in flight at that moment.
        const sync = () => chrome.storage.local.get([Store.QUEUE_KEY], async (res) => {
            const log = await readLog();
            if (signal.aborted) return;
            const q = Array.isArray(res[Store.QUEUE_KEY]) ? res[Store.QUEUE_KEY] : [];
            const id = curatorId();
            const types = Filters.coveredTypes(q, id);
            const queued = new Set(Filters.curatorJobs(q, id).map(j => j.filter));
            // Not Recommended red, Informational yellow, both the gradient.
            const cover = Filters.coverFilter(types);
            square.hidden = !cover;
            btn.querySelector('.ilap-cur-div').hidden = !cover;
            square.setAttribute('style', cover ? Filters.fillStyle(cover) : '');
            square.dataset.tip = cover ? t(Filters.labelKey(cover)) : '';
            const text = cover ? t('curator_added_state') : t('curator_add_to_queue');
            btn.dataset.label = text;
            if (!btn.disabled) {
                const lbl = btn.querySelector('.ilap-cur-label');
                if (lbl) lbl.textContent = text;
            }
            const now = Date.now();
            const undoneAt = Log ? Log.lastUndoneForCurator(log, curatorId(), WARN_WINDOW_MS, now) : 0;
            renderMenu(queued, types, undoneAt > 0 ? now - undoneAt : 0);
            // The button follows its label, so an open menu is placed again.
            if (menu.classList.contains('open')) placeMenu(btn, menu);
        });
        sync();
        // Deliberately NOT keyed on the log: the drainer writes it 1–3×/s
        // mid-drain and each sync re-measures the menu. The warning's inputs
        // change meaningfully only when an undo job finishes — which removes
        // the job from the queue and lands here anyway.
        const onChanged = (changes, area) => {
            if (area === 'local' && changes[Store.QUEUE_KEY]) sync();
        };
        chrome.storage.onChanged.addListener(onChanged);
        // A language change re-derives the same things a queue change does
        // (button label + menu option labels), so it rides the same sync.
        window.ILAP.i18n.onLangChange(sync);
        // Re-injected on every master flip, so these must not leak.
        signal.addEventListener('abort', () => {
            chrome.storage.onChanged.removeListener(onChanged);
            window.ILAP.i18n.offLangChange(sync);
        }, { once: true });
    }

    // Owns the injected curator-button lifecycle: the injection handle plus the
    // two gates that decide whether it's shown — the login gate and the master
    // toggle. The button is deliberately NOT surface-gated: the queue is
    // stageable and manageable from either surface, drained by the SW too (the
    // popup hosts the same applet), so the mode only decides where the UI lives,
    // not what is allowed.
    function createButtonController(service) {
        // The live injection ({ wrap, menu, ac }), or null.
        let handle = null;
        let obs = null;
        let loggedIn = false;
        let masterOn = null;   // unknown until the first storage read — inject nothing yet

        function inject(report) {
            if (report.querySelector('#' + BTN_ID)) return;
            injectStyle();
            const { wrap, btn } = buildButton(report);
            const { menu, renderMenu } = buildMenu();
            const ac = new AbortController();
            wireMenu(wrap, btn, menu, ac.signal, service);
            wireStorageSync(btn, menu, renderMenu, ac.signal);
            handle = { wrap, menu, ac };
        }

        function tryInject() {
            const report = document.querySelector('.nav_right_side > .curator_report');
            if (!report) return false;
            inject(report);
            return true;
        }

        // Takes the observer to stop, so a give-up timer from an EARLIER start
        // (master flipped off and on inside the window) can't clear the current one.
        function stopObserver(o = obs) {
            if (!o) return;
            o.disconnect();
            if (obs === o) obs = null;
        }

        function start() {
            if (handle || obs) return;
            if (tryInject()) return;
            // The curator chrome can render after load; watch briefly, then give up.
            const o = new MutationObserver(() => { if (tryInject()) stopObserver(o); });
            obs = o;
            o.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(() => stopObserver(o), 10000);
        }

        function remove() {
            stopObserver();
            if (!handle) return;
            handle.ac.abort();   // every listener and subscription of the injection
            handle.wrap.remove();
            handle.menu.remove();   // lives on <body>, not inside the wrapper
            const style = document.getElementById(STYLE_ID);
            if (style) style.remove();   // injectStyle() puts it back with the button
            handle = null;
        }

        function apply() {
            if (loggedIn && masterOn === true) start();
            else remove();
        }

        return {
            // Login gate settled positive: inject.
            onLogin() { loggedIn = true; apply(); },
            // The global master toggle: off removes the control, on puts it back.
            // Already-staged jobs are untouched.
            setMaster(on) { masterOn = on; apply(); }
        };
    }

    function boot() {
        if (!curatorId()) return;          // no-op on every non-curator store page

        const C = window.ILAP.Curator;
        const service = new C.EnqueueService({
            store: C.Store, enumerator: C.Enumerator, maxJobs: C.Store.MAX_JOBS
        });
        const ctl = createButtonController(service);

        // Login gate: staging an ignore job makes no sense without a Steam
        // session, so the control isn't injected at all on a logged-out page
        // (same SteamAuth policy as the widget lock — header DOM first, live
        // probe only when there is no header to read).
        window.ILAP.SteamAuth.resolveLogin().then((ok) => { if (ok) ctl.onLogin(); });

        // Master gate, resolved and then followed live (no reload needed).
        const setMaster = (on) => ctl.setMaster(on);
        window.ILAP.MasterSwitch.watch({ onInit: setMaster, onChange: setMaster });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
