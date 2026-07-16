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

    const MAX_JOBS = 3;          // cap the queue at 3 jobs
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
    // before it reaches storage. Falls back to a minimal local strip if utils.js
    // somehow isn't present.
    const clean = (s) => (window.ILAP && window.ILAP.sanitizeName)
        ? window.ILAP.sanitizeName(s)
        : String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, 120);

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
            /* Popup surface mode: the button stays in place but locked — greyed,
               flat, plain cursor; our own inline tooltip (below) explains the escape.
               pointer-events:none so hovering the (disabled) button hit-tests the
               wrap itself — a disabled control's :hover propagation is engine-
               dependent, and the tip reveal must not hang on it. */
            #${BTN_ID}.ilap-locked, #${BTN_ID}.ilap-locked:hover {
                background-color: #3d4450 !important; background-image: none !important;
                box-shadow: none !important; color: #8f98a0 !important;
                cursor: default; opacity: 1; filter: grayscale(1) !important;
                pointer-events: none;
            }
            /* Our tooltip for the locked button: a single line under the button
               (not the browser's little square). Right-anchored: the button sits
               near the right edge of the curator header, so a long localized
               nowrap line must grow leftward into the page, not off-screen. */
            .ilap-locked-tip {
                display: none; position: absolute; top: calc(100% + 6px); right: 0;
                background: #16202d; color: #c7d5e0; border: 1px solid #2a3848;
                border-radius: 6px; padding: 7px 10px; white-space: nowrap;
                font: 400 11px "Motiva Sans", Arial, sans-serif; line-height: 1.3;
                box-shadow: 0 6px 16px rgba(0,0,0,.5); z-index: 2147483000; pointer-events: none;
            }
            .ilap-curator-ctl.ilap-locked-ctl:hover .ilap-locked-tip { display: block; }
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
            /* Post-add job actions: a separator, then Pause/Resume + Remove rows.
               The icon is centered over the filter rows' 8px dot column (13px
               glyph, negative side margins) so both row kinds align. */
            .ilap-curator-sep { height: 1px; background: rgba(255,255,255,.09); }
            .ilap-act-ico { display: inline-flex; flex-shrink: 0; margin: 0 -2.5px; }
            .ilap-act-ico svg { display: block; }
            .ilap-curator-opt.ilap-act-del:hover { background: rgba(211,47,47,.18); }
            /* Bottom-right push notification shown when a curator is added. */
            .ilap-curator-toast {
                position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
                display: flex; align-items: center; gap: 10px; max-width: 320px;
                background: #16202d; color: #fff; border: 1px solid #45A1FA; border-left: 3px solid #45A1FA;
                border-radius: 8px; padding: 12px 15px; box-shadow: 0 8px 24px rgba(0,0,0,.6);
                font: 600 13px "Motiva Sans", Arial, sans-serif; line-height: 1.4;
                transform: translateY(16px); opacity: 0;
                transition: transform .3s cubic-bezier(.2,.9,.3,1), opacity .3s ease;
            }
            .ilap-curator-toast.show { transform: translateY(0); opacity: 1; }
            .ilap-curator-toast img { width: 22px; height: 22px; border-radius: 4px; display: block; flex-shrink: 0; }
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

    // Bottom-right push notification that slides in, then fades out. When the message
    // has a "{type}" placeholder, the category name is highlighted bold in its colour.
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
        const toast = document.createElement('div');
        toast.className = 'ilap-curator-toast';
        toast.innerHTML = `<img src="${ICON_URL}" alt=""><span>${html}</span>`;
        document.body.appendChild(toast);
        requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 350);
        }, duration || 3100);
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
            </button>
            <span class="ilap-locked-tip" id="ilap-locked-tip" role="tooltip"></span>`;

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

        const renderMenu = (job) => {
            const activeFilter = job ? job.filter : null;
            let html = FILTERS.map(f => {
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
    // `isLocked()` is re-checked on every interaction: the surface can flip to popup
    // mode (in this or another window) while the dropdown is already open, so a pick
    // must be refused even if the menu is still visibly open at click time.
    function wireMenu(wrap, btn, menu, isLocked) {
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
            if (btn.disabled || isLocked()) return;
            menu.classList.contains('open') ? close() : open();
        });

        menu.addEventListener('click', (e) => {
            if (!e.isTrusted) return; // real clicks only — a page script can't stage a bulk job
            const opt = e.target.closest('.ilap-curator-opt');
            if (!opt) return;
            close();
            if (isLocked()) return; // popup mode flipped in mid-open: refuse the stage
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
        const sync = () => chrome.storage.local.get('ilap_curator_queue', (res) => {
            const q = Array.isArray(res.ilap_curator_queue) ? res.ilap_curator_queue : [];
            const job = q.find(j => j.curatorId === curatorId());
            const text = job ? t('curator_added_state') : t('curator_add_to_queue');
            btn.dataset.label = text;
            if (!btn.disabled) {
                const lbl = btn.querySelector('.ilap-cur-label');
                if (lbl) lbl.textContent = text;
            }
            renderMenu(job || null);
            syncBtnWidth(btn, menu);
        });
        sync();
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.ilap_curator_queue) sync();
        });
        // A language change re-derives the same things a queue change does
        // (button label + menu option labels), so it rides the same sync.
        window.ILAP.i18n.onLangChange(sync);
    }

    let service = null; // EnqueueService, assembled in boot() once deps are present

    // Owns the injected curator-button lifecycle: the injection handle plus the
    // login and surface gates that decide whether it's shown. Kept as one small
    // object (state private to the closure) so boot() reads as assembly — seed the
    // surface, settle login, react to a live surface flip — with no free-floating
    // module state.
    function createButtonController() {
        let injectedCtl = null; // { wrap, btn, menu } once injected; kept for the live surface switch
        let loginOk = false;
        let surfaceOn = true;
        let locked = false;     // popup surface mode → button visible but not-allowed

        // Reflect the current lock state onto the injected button: greyed + tooltip
        // + disabled (so the dropdown can't be opened), and force the dropdown shut
        // so a menu left open across a live flip can't stage a job.
        function applyLock() {
            if (!injectedCtl) return;
            const { wrap, btn, menu } = injectedCtl;
            const tip = wrap.querySelector('.ilap-locked-tip');
            if (locked) {
                menu.classList.remove('open');
                btn.disabled = true;
                btn.classList.add('ilap-locked');
                wrap.classList.add('ilap-locked-ctl');
                // aria-describedby reaches the (display:none) tip text for screen
                // readers — the hover-only visual alone is invisible to AT.
                btn.setAttribute('aria-describedby', 'ilap-locked-tip');
                if (tip) tip.textContent = t('curator_locked_popup', { keys: window.ILAP.Surface.ESCAPE_HOTKEY_LABEL });
            } else {
                btn.disabled = false;
                btn.classList.remove('ilap-locked');
                wrap.classList.remove('ilap-locked-ctl');
                btn.removeAttribute('aria-describedby');
            }
        }

        function inject(report) {
            if (report.querySelector('#' + BTN_ID)) return;
            injectStyle();
            const { wrap, btn } = buildButton(report);
            const { menu, renderMenu } = buildMenu();
            wireMenu(wrap, btn, menu, () => locked);
            wireStorageSync(btn, menu, renderMenu);
            injectedCtl = { wrap, btn, menu };
            applyLock();
            // Keep the locked-state tooltip in the live language too (no-op
            // while unlocked — applyLock only writes the tip when locked).
            window.ILAP.i18n.onLangChange(applyLock);
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
            // Seed the effective surface at boot (before login settles) — no side effect.
            setSurface(on) { surfaceOn = on; locked = !on; },
            // Login gate settled positive: remember it and inject (locked in popup mode).
            onLogin() { loginOk = true; start(); },
            // Live surface switch: popup mode locks the button in place (greyed +
            // tooltip, dropdown forced shut), widget mode unlocks/injects it.
            applySurface(on) {
                surfaceOn = on;
                locked = !on;
                if (injectedCtl) { applyLock(); return; }
                if (loginOk) start();
            }
        };
    }

    function boot() {
        if (!curatorId()) return;          // no-op on every non-curator store page
        const Surface = window.ILAP.Surface;

        // Assemble the enqueue service with its real deps (DIP: pick() no longer
        // reaches into the Store/Enumerator singletons itself). If the Phase-2
        // curator scripts aren't present, `service` stays null and pick() no-ops.
        const C = window.ILAP.Curator;
        if (C && C.Store && C.Enumerator && C.EnqueueService) {
            service = new C.EnqueueService({
                store: C.Store, enumerator: C.Enumerator, maxJobs: MAX_JOBS
            });
        }

        const ctl = createButtonController();

        // Surface gate: in popup mode the curator queue must stay empty, so the
        // staging control is locked (greyed + tooltip) rather than removed; a live
        // mode switch locks/unlocks it in place.
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[Surface.KEY]) {
                ctl.applySurface(Surface.resolve(changes[Surface.KEY].newValue, navigator.userAgent) === 'widget');
            }
        });

        chrome.storage.local.get({ [Surface.KEY]: 'widget' }, (data) => {
            ctl.setSurface(Surface.resolve(data[Surface.KEY], navigator.userAgent) === 'widget');
            // Login gate: staging an ignore job makes no sense without a Steam
            // session, so the control isn't injected at all on a logged-out page
            // (same SteamAuth policy as the widget lock — header DOM first, live
            // probe only when there is no header to read).
            window.ILAP.SteamAuth.resolveLogin().then((ok) => { if (ok) ctl.onLogin(); });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
