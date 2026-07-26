// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Phase-2 scaffolding: on a curator page, inject a single "Add to ignore queue"
    // button just before the Options gear in `.nav_right_side > .curator_report`.
    // Clicking the button drops its OWN filter menu out of it; picking an option is
    // what stages the job into chrome.storage.local (`ilap_curator_queue`). The
    // popup/widget "Ignore Queue" applet renders that staged job. Once a job is
    // staged, the same droplist also carries the applet's job actions —
    // Pause/Resume + Remove — so the job can be controlled right where it was
    // staged. Enumeration and draining are NOT wired here — button + menu only.

    const t = (k, p) => (window.ILAP && window.ILAP.t) ? window.ILAP.t(k, p) : k;

    const BTN_ID = 'ilap-curator-enqueue';
    const STYLE_ID = 'ilap-curator-style';

    // Convex azure button — gradient + inset top highlight (promo slide-05 mock).
    const BTN_BG = 'linear-gradient(180deg, #3aa0ec, #1f7fd6)';
    const BTN_BG_HOVER = 'linear-gradient(180deg, #4bacf2, #2b8ce0)';
    const ICON_URL = chrome.runtime.getURL('assets/icons/icon48.png');

    // Per-category glowing bullet in the dropdown (promo slide-05 mock: red /
    // yellow / yellow→red gradient for the combined filter).
    const DOT_STYLES = {
        not_recommended: 'background:#ff6a4d; box-shadow:0 0 9px #ff6a4d;',
        informational: 'background:#f1de74; box-shadow:0 0 9px #f1de74;',
        all_but_recommended: 'background:linear-gradient(90deg,#f1de74,#ff6a4d); box-shadow:0 0 9px rgba(255,150,80,.75);'
    };

    // Post-add droplist action rows (same glyphs as the queue applet's row
    // buttons in ui/popup_queue.js — presentation constants, not shared logic;
    // the two files live in different script worlds). Colours match the applet's
    // hover fills: pause yellow, play green, delete red (menu's red-dot shade).
    const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';
    const ICON_PLAY = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
    const ICON_TRASH = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9zm4 2v8h1v-8h-1zm3 0v8h1v-8h-1z"/></svg>';

    // Filter vocabulary + label colours are shared with the popup applet (see
    // src/curator/filters.js, loaded before this script).
    const Filters = window.ILAP_Filters;
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
        if (!m) return clean('Curator ' + id);
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
                overflow: hidden; padding: 0;
                box-shadow: 0 24px 62px rgba(2,8,20,.62), 0 0 0 1px rgba(0,0,0,.4) inset;
                white-space: nowrap;
            }
            .ilap-curator-menu.open { display: block; }
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
            .ilap-opt-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
            .ilap-opt-tag { margin-left: auto; padding-left: 14px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; white-space: nowrap; }
            .ilap-opt-tag.is-active { color: #7ad13f; }
            .ilap-opt-tag.is-switch { color: #45A1FA; opacity: 0; transition: opacity .12s ease; }
            .ilap-curator-opt:hover .ilap-opt-tag.is-switch { opacity: 1; }
            /* Soft re-stage warning: the user recently UNDID this curator's
               ignores — staging again is allowed (never blocked), just flagged. */
            .ilap-curator-warn {
                display: flex; align-items: center; gap: 8px;
                padding: 8px 15px; color: #ffd21a;
                font: 500 11.5px "Motiva Sans", Arial, sans-serif;
                border-bottom: 1px solid rgba(255,255,255,.05);
                white-space: normal; max-width: 300px; line-height: 1.35;
            }
            /* Post-add job actions: a separator, then Pause/Resume + Remove rows.
               The icon is centered over the filter rows' 8px dot column (13px
               glyph, negative side margins) so both row kinds align. */
            .ilap-curator-sep { height: 1px; background: rgba(255,255,255,.09); }
            .ilap-act-ico { display: inline-flex; flex-shrink: 0; margin: 0 -2.5px; }
            .ilap-act-ico svg { display: block; }
            .ilap-curator-opt.ilap-act-del:hover { background: rgba(211,47,47,.18); }
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
        window.ILAP.showToast(html, duration);
    }

    // Pick a filter from the dropdown: add a new job, or — if this curator is
    // already queued — switch the existing job's filter in place. Staging +
    // resolution (cache-vs-enumerate → `pending`) is owned by the injectable
    // EnqueueService (built in boot, serialized through Store.mutateQueue); this
    // stays the thin UI layer — gather the page-derived inputs, react to the
    // outcome with the toast/flash, and kick off resolution.
    function pick(value, btn) {
        const id = curatorId();
        if (!id || !service) return;
        const name = curatorName(id);
        const url = location.origin + location.pathname;
        service.stage(id, name, url, value).then((outcome) => {
            if (!outcome) return;
            if (outcome.kind === 'full') { showToast('curator_toast_full', null, 4500); return; }
            if (outcome.kind === 'switched') {
                showToast('curator_toast_switched', value);
            } else {
                flash(btn, t('curator_added'));
                showToast('curator_toast_added', value);
            }
            service.resolve(id, outcome.jobId, outcome.name, value).then((res) => {
                // Enumeration produced no drainable list (fetch/parse failure, or
                // nothing under this filter) — the job was dropped, so tell the user
                // instead of leaving them with a silently vanished button state.
                if (res && res.error) showToast('curator_toast_error', null, 4500);
            });
        });
    }

    // Post-add droplist action: Pause/Resume or Remove the job staged for THIS
    // curator — the exact effect of the queue applet's row buttons. The service
    // re-reads the job inside the serialized queue mutation, so a click raced by
    // another window (job already removed / already toggled there) degrades to a
    // no-op; the storage sync then redraws this menu to whatever actually won.
    function jobAction(act) {
        const id = curatorId();
        if (!id || !service) return;
        if (act === 'remove') service.remove(id);
        else if (act === 'pause') service.togglePause(id);
    }

    // Build the control (logo + label) and place it just before the
    // Options gear (the first <a> in the report). Returns the wrapper + button.
    function buildButton(report) {
        const label = t('curator_add_to_queue');
        const wrap = document.createElement('span');
        wrap.className = 'ilap-curator-ctl';
        wrap.innerHTML = `
            <button type="button" id="${BTN_ID}">
                <img class="ilap-cur-logo" src="${ICON_URL}" alt="">
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
    // renderMenu takes the queued job (or null): once this curator is queued it
    // marks the job's filter Active, offers the others a "Switch" hint on hover,
    // and appends the job-action rows (Pause/Resume by stored intent + Remove).
    // Every queue change re-renders — even while the menu is OPEN — so two
    // windows can never keep diverging add-/added-variants of this droplist.
    function buildMenu() {
        const menu = document.createElement('div');
        menu.className = 'ilap-curator-menu';
        document.body.appendChild(menu);

        const renderMenu = (job, undoneAgoMs) => {
            const activeFilter = job ? job.filter : null;
            // Soft ping-pong flag: this curator's ignores were rolled back via
            // undo within the warning window. Informational only — the rows
            // below stay fully clickable (a re-stage right after an undo is a
            // legitimate "picked the wrong filter" flow).
            let html = '';
            if (!job && undoneAgoMs > 0) {
                const hours = Math.max(1, Math.round(undoneAgoMs / 3600000));
                html += `<div class="ilap-curator-warn">⚠ ${esc(t('undo_restage_warning', { h: hours }))}</div>`;
            }
            html += FILTERS.map(f => {
                const isActive = activeFilter === f.value;
                let tag = '';
                if (activeFilter != null) {
                    tag = isActive
                        ? `<span class="ilap-opt-tag is-active">${esc(t('curator_active'))}</span>`
                        : `<span class="ilap-opt-tag is-switch">${esc(t('curator_switch'))}</span>`;
                }
                return `<div class="ilap-curator-opt${isActive ? ' active' : ''}" data-value="${f.value}"><span class="ilap-opt-dot" style="${DOT_STYLES[f.value]}"></span><span>${esc(t(f.key))}</span>${tag}</div>`;
            }).join('');
            if (job) {
                const paused = job.status === 'paused';
                html += '<div class="ilap-curator-sep"></div>'
                    + `<div class="ilap-curator-opt" data-act="pause"><span class="ilap-act-ico" style="color:${paused ? '#7ad13f' : '#ffd21a'}">${paused ? ICON_PLAY : ICON_PAUSE}</span><span>${esc(t(paused ? 'queue_resume' : 'queue_pause'))}</span></div>`
                    + `<div class="ilap-curator-opt ilap-act-del" data-act="remove"><span class="ilap-act-ico" style="color:#ff6a4d">${ICON_TRASH}</span><span>${esc(t('queue_remove'))}</span></div>`;
            }
            menu.innerHTML = html;
        };
        renderMenu(null);
        return { menu, renderMenu };
    }

    // Wire open/close, option picking, and dismissal (outside click + scroll/resize
    // reposition guard — the fixed menu would otherwise detach from the button).
    function wireMenu(wrap, btn, menu) {
        const close = () => { menu.classList.remove('open'); };
        const open = () => {
            const r = btn.getBoundingClientRect();
            menu.style.top = (r.bottom + 9) + 'px';
            menu.style.left = r.left + 'px';
            menu.style.minWidth = r.width + 'px';
            menu.classList.add('open');
        };

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!e.isTrusted) return; // real clicks only — a page script can't open the menu
            if (btn.disabled) return;
            menu.classList.contains('open') ? close() : open();
        });

        menu.addEventListener('click', (e) => {
            if (!e.isTrusted) return; // real clicks only — a page script can't stage a bulk job
            const opt = e.target.closest('.ilap-curator-opt');
            if (!opt) return;
            close();
            const act = opt.getAttribute('data-act');
            if (act) { jobAction(act); return; }
            pick(opt.getAttribute('data-value'), btn);
        });

        document.addEventListener('click', (e) => {
            if (!menu.contains(e.target) && !wrap.contains(e.target)) close();
        });
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
    }

    // The button spans the full dropdown width (promo slide-05 mock). The menu is
    // display:none while closed, so render it invisibly for one layout pass to
    // measure; re-run after every renderMenu — option labels (locale) and the
    // Active/Switch tags change its natural width.
    function syncBtnWidth(btn, menu) {
        const wasOpen = menu.classList.contains('open');
        if (!wasOpen) { menu.style.visibility = 'hidden'; menu.classList.add('open'); }
        // Measure the menu's NATURAL width: the min-width left over from a
        // previous open() reflects the button, and feeding it back into the
        // button would let the two ratchet each other wider — it also pins the
        // menu too wide after a re-render shrank its content (locale switch).
        menu.style.minWidth = '';
        const w = menu.offsetWidth;
        if (!wasOpen) { menu.classList.remove('open'); menu.style.visibility = ''; }
        if (w) btn.style.minWidth = w + 'px';
        // A menu re-rendered while OPEN must keep spanning the (possibly wider)
        // button — same rule open() applies.
        if (wasOpen) menu.style.minWidth = btn.getBoundingClientRect().width + 'px';
    }

    // Reflect already-queued state (button label + dropdown Active/Switch + the
    // post-add Pause/Remove rows) now and whenever the queue changes (here, in
    // the popup applet, or in another tab/window). The re-render also hits an
    // OPEN menu, so a queue change elsewhere swaps this droplist's variant live.
    function wireStorageSync(btn, menu, renderMenu) {
        // Optional, like the drainer's log hooks: without the module the button
        // still works, only the soft re-stage warning is skipped.
        const Log = window.ILAP.IgnoreLog;
        // Recently-undone window for the soft re-stage warning.
        const WARN_WINDOW_MS = 48 * 3600000;
        const keys = Log ? ['ilap_curator_queue', Log.LOG_KEY] : ['ilap_curator_queue'];
        const sync = () => chrome.storage.local.get(keys, (res) => {
            const q = Array.isArray(res.ilap_curator_queue) ? res.ilap_curator_queue : [];
            const job = q.find(j => j.curatorId === curatorId());
            const text = job ? t('curator_added_state') : t('curator_add_to_queue');
            btn.dataset.label = text;
            if (!btn.disabled) {
                const lbl = btn.querySelector('.ilap-cur-label');
                if (lbl) lbl.textContent = text;
            }
            const now = Date.now();
            const undoneAt = Log ? Log.lastUndoneForCurator(
                res[Log.LOG_KEY] || [], curatorId(), WARN_WINDOW_MS, now) : 0;
            renderMenu(job || null, undoneAt > 0 ? now - undoneAt : 0);
            syncBtnWidth(btn, menu);
        });
        sync();
        chrome.storage.onChanged.addListener((changes, area) => {
            // Deliberately NOT keyed on the log: the drainer writes it 1–3×/s
            // mid-drain and each sync re-measures the menu. The warning's inputs
            // change meaningfully only when an undo job finishes — which removes
            // the job from the queue and lands here anyway.
            if (area === 'local' && changes.ilap_curator_queue) sync();
        });
        // A language change re-derives the same things a queue change does
        // (button label + menu option labels), so it rides the same sync.
        window.ILAP.i18n.onLangChange(sync);
    }

    let service = null; // EnqueueService, assembled in boot() once deps are present

    // Owns the injected curator-button lifecycle: the injection handle plus the
    // login gate that decides whether it's shown. The button is deliberately NOT
    // surface-gated: since the SW drain landed, the queue is stageable and
    // manageable from either surface (the popup hosts the same applet), so the
    // mode only decides where the UI lives, not what is allowed.
    function createButtonController() {
        function inject(report) {
            if (report.querySelector('#' + BTN_ID)) return;
            injectStyle();
            const { wrap, btn } = buildButton(report);
            const { menu, renderMenu } = buildMenu();
            wireMenu(wrap, btn, menu);
            wireStorageSync(btn, menu, renderMenu);
        }

        function tryInject() {
            const report = document.querySelector('.nav_right_side > .curator_report');
            if (!report) return false;
            inject(report);
            return true;
        }

        function start() {
            if (tryInject()) return;
            // The curator chrome can render after load; watch briefly, then give up.
            const obs = new MutationObserver(() => { if (tryInject()) obs.disconnect(); });
            obs.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(() => obs.disconnect(), 10000);
        }

        return {
            // Login gate settled positive: inject.
            onLogin() { start(); }
        };
    }

    function boot() {
        if (!curatorId()) return;          // no-op on every non-curator store page

        // Assemble the enqueue service with its real deps (DIP: pick() no longer
        // reaches into the Store/Enumerator singletons itself). If the Phase-2
        // curator scripts aren't present, `service` stays null and pick() no-ops.
        const C = window.ILAP.Curator;
        if (C && C.Store && C.Enumerator && C.EnqueueService) {
            service = new C.EnqueueService({
                store: C.Store, enumerator: C.Enumerator, maxJobs: C.Store.MAX_JOBS
            });
        }

        const ctl = createButtonController();

        // Login gate: staging an ignore job makes no sense without a Steam
        // session, so the control isn't injected at all on a logged-out page
        // (same SteamAuth policy as the widget lock — header DOM first, live
        // probe only when there is no header to read).
        window.ILAP.SteamAuth.resolveLogin().then((ok) => { if (ok) ctl.onLogin(); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
