// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Phase-2 scaffolding: on a curator page, inject a single "Add to ignore queue"
    // button just before the Options gear in `.nav_right_side > .curator_report`.
    // Clicking the button drops its OWN filter menu out of it; picking an option is
    // what stages the job into chrome.storage.local (`ilap_curator_queue`). The
    // popup/widget "Ignore Queue" applet renders that staged job. Enumeration and
    // draining are NOT wired here yet — this only places the button + its menu.

    const t = (k, p) => (window.ILAP && window.ILAP.t) ? window.ILAP.t(k, p) : k;

    const MAX_JOBS = 3;          // cap the queue at 3 jobs
    const CONFIRM_THRESHOLD = 25; // ask before queueing more than this many games
    const BTN_ID = 'ilap-curator-enqueue';
    const STYLE_ID = 'ilap-curator-style';

    const BTN_BG = '#2a6cc6';        // darker "serious" blue for the button
    const BTN_BG_HOVER = '#3a7cd6';
    const ICON_URL = chrome.runtime.getURL('assets/icons/icon48.png');

    // Filter vocabulary + label colours are shared with the popup applet (see
    // src/curator/filters.js, loaded before this script).
    const Filters = window.ILAP_Filters;
    const FILTERS = Filters.FILTERS;
    const typeStyle = (value) => Filters.colorStyle(value);

    // Shared HTML-escaper (src/escape.js, loaded before this script).
    const esc = window.ILAP.Sanitizer.escapeHTML;

    // /curator/<id>-<slug>/ → numeric id, or null on any other store page.
    function curatorId() {
        const m = location.pathname.match(/^\/curator\/(\d+)/);
        return m ? m[1] : null;
    }

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
            .ilap-curator-ctl { position: relative; display: inline-flex; align-items: center; margin-right: 8px; vertical-align: middle; }
            /* ILAP logo inside the button, marking this as an extension control. */
            .ilap-cur-logo { width: 18px; height: 18px; border-radius: 4px; display: block; }
            #${BTN_ID} {
                display: inline-flex; align-items: center; gap: 7px;
                /* Force a FLAT colour: Steam's button gradient sheen otherwise lightens
                   the fill. Kill background-image, the inset highlight box-shadow and filter. */
                background-color: ${BTN_BG} !important; background-image: none !important;
                box-shadow: none !important; filter: none !important;
                color: #fff !important; border: none; cursor: pointer;
                font: 700 12px "Motiva Sans", Arial, sans-serif; padding: 0 12px; height: 28px;
                border-radius: 3px; white-space: nowrap;
            }
            #${BTN_ID}:hover { background-color: ${BTN_BG_HOVER} !important; background-image: none !important; }
            #${BTN_ID}:disabled { opacity: .7; cursor: default; }
            #${BTN_ID} .ilap-cur-caret { font-size: 9px; opacity: .85; transition: transform .15s ease; }
            .ilap-curator-ctl.open #${BTN_ID} .ilap-cur-caret { transform: rotate(180deg); }
            /* Menu lives on <body> (position:fixed) so no Steam ancestor stacking
               context / overflow can clip it or push it under the .page_desc below. */
            .ilap-curator-menu {
                display: none; position: fixed; z-index: 2147483000;
                background: #16202d; border: 1px solid #2a3848; border-radius: 8px; padding: 4px;
                box-shadow: 0 8px 20px rgba(0,0,0,.55); white-space: nowrap;
            }
            .ilap-curator-menu.open { display: block; }
            .ilap-curator-opt {
                display: flex; align-items: center; justify-content: space-between; gap: 14px;
                padding: 8px 11px; border-radius: 6px; cursor: pointer; color: #c7d5e0;
                font: 600 12px "Motiva Sans", Arial, sans-serif;
            }
            .ilap-curator-opt.active { background: #1d3a59; color: #fff; }
            .ilap-curator-opt:hover { background: #22303f; color: #fff; }
            .ilap-opt-tag { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; white-space: nowrap; }
            .ilap-opt-tag.is-active { color: #7ad13f; }
            .ilap-opt-tag.is-switch { color: #45A1FA; opacity: 0; transition: opacity .12s ease; }
            .ilap-curator-opt:hover .ilap-opt-tag.is-switch { opacity: 1; }
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
    // already queued — switch the existing job's filter in place. Either way the
    // job is staged as `enumerating`, then `resolveJob` resolves its appids (from
    // the retention cache, or the ~4 batched reads) and flips it to `pending`.
    function pick(value, btn) {
        const id = curatorId();
        if (!id) return;
        chrome.storage.local.get('ilap_curator_queue', (res) => {
            const queue = Array.isArray(res.ilap_curator_queue) ? res.ilap_curator_queue.slice() : [];
            const idx = queue.findIndex(j => j.curatorId === id);

            if (idx >= 0) {
                if (queue[idx].filter === value) return; // already this type — no-op
                const jobId = queue[idx].id;
                const name = queue[idx].curatorName;
                // Switching filter changes the appid set, so re-resolve from
                // scratch; already-ignored games are skipped instantly by the
                // drainer's userdata dedupe, so progress isn't really lost.
                queue[idx] = Object.assign({}, queue[idx], {
                    filter: value, status: 'enumerating', appids: [], cursor: 0, total: 0
                });
                chrome.storage.local.set({ ilap_curator_queue: queue }, () => {
                    showToast('curator_toast_switched', value);
                    resolveJob(id, jobId, name, value);
                });
                return;
            }

            if (queue.length >= MAX_JOBS) { showToast('curator_toast_full', null, 4500); return; }
            const name = curatorName(id);
            const jobId = 'job_' + id + '_' + Date.now();
            queue.push({
                id: jobId,
                curatorId: id,
                curatorName: name,
                curatorUrl: location.origin + location.pathname,
                filter: value,
                appids: [],   // resolved by resolveJob
                cursor: 0,
                total: 0,
                status: 'enumerating',
                addedAt: Date.now()
            });
            chrome.storage.local.set({ ilap_curator_queue: queue }, () => {
                flash(btn, t('curator_added'));
                showToast('curator_toast_added', value);
                resolveJob(id, jobId, name, value);
            });
        });
    }

    // Resolve a staged job's appids and flip it to `pending` so the drainer can
    // start. Uses the 7-day retention cache when fresh (0 network), otherwise
    // enumerates the curator and caches the result. Confirms before queueing a
    // large batch; honours removal mid-enumeration.
    async function resolveJob(id, jobId, name, filter) {
        const C = window.ILAP && window.ILAP.Curator;
        if (!C || !C.Enumerator || !C.Store) return;
        const Enum = C.Enumerator, Store = C.Store;
        try {
            let apps;
            const cache = await Store.getCache(id);
            if (cache && Store.isFresh(cache, Date.now())) {
                apps = cache.apps;
            } else {
                const result = await Enum.enumerate(id);
                await Store.putCache(id, { total: result.total, name, apps: result.apps });
                apps = result.apps;
            }

            // Bail if the user removed the job while we were enumerating.
            if (!(await Store.getQueue()).some(j => j.id === jobId)) return;

            const appids = Enum.filterAppids(apps, filter);
            if (appids.length > CONFIRM_THRESHOLD
                && !window.confirm(t('curator_confirm', { n: appids.length }))) {
                await Store.removeJob(jobId);
                return;
            }
            await Store.updateJob(jobId, {
                appids, total: appids.length, cursor: 0, status: 'pending'
            });
        } catch (e) {
            // Enumeration failed — leave the job idle (0/0) so the user can remove
            // or re-add it; never auto-ignore on a half-resolved list.
            await Store.updateJob(jobId, { status: 'pending', appids: [], total: 0 });
        }
    }

    // Build the split control (logo + label + caret) and place it just before the
    // Options gear (the first <a> in the report). Returns the wrapper + button.
    function buildButton(report) {
        const label = t('curator_add_to_queue');
        const wrap = document.createElement('span');
        wrap.className = 'ilap-curator-ctl';
        wrap.innerHTML = `
            <button type="button" id="${BTN_ID}">
                <img class="ilap-cur-logo" src="${ICON_URL}" alt="">
                <span class="ilap-cur-label">${esc(label)}</span>
                <span class="ilap-cur-caret">▼</span>
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
    // renderMenu marks the queued filter Active and offers the others a "Switch"
    // hint on hover once this curator is queued.
    function buildMenu() {
        const menu = document.createElement('div');
        menu.className = 'ilap-curator-menu';
        document.body.appendChild(menu);

        const renderMenu = (activeFilter) => {
            menu.innerHTML = FILTERS.map(f => {
                const isActive = activeFilter === f.value;
                let tag = '';
                if (activeFilter != null) {
                    tag = isActive
                        ? `<span class="ilap-opt-tag is-active">${esc(t('curator_active'))}</span>`
                        : `<span class="ilap-opt-tag is-switch">${esc(t('curator_switch'))}</span>`;
                }
                return `<div class="ilap-curator-opt${isActive ? ' active' : ''}" data-value="${f.value}"><span>${esc(t(f.key))}</span>${tag}</div>`;
            }).join('');
        };
        renderMenu(null);
        return { menu, renderMenu };
    }

    // Wire open/close, option picking, and dismissal (outside click + scroll/resize
    // reposition guard — the fixed menu would otherwise detach from the button).
    function wireMenu(wrap, btn, menu) {
        const close = () => { menu.classList.remove('open'); wrap.classList.remove('open'); };
        const open = () => {
            const r = btn.getBoundingClientRect();
            menu.style.top = (r.bottom + 4) + 'px';
            menu.style.left = r.left + 'px';
            menu.style.minWidth = r.width + 'px';
            menu.classList.add('open');
            wrap.classList.add('open'); // rotates the caret
        };

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btn.disabled) return;
            menu.classList.contains('open') ? close() : open();
        });

        menu.addEventListener('click', (e) => {
            const opt = e.target.closest('.ilap-curator-opt');
            if (!opt) return;
            close();
            pick(opt.getAttribute('data-value'), btn);
        });

        document.addEventListener('click', (e) => {
            if (!menu.contains(e.target) && !wrap.contains(e.target)) close();
        });
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
    }

    // Reflect already-queued state (button label + dropdown Active/Switch) now and
    // whenever the queue changes (here, in the popup applet, or in another tab).
    function wireStorageSync(btn, renderMenu) {
        const sync = () => chrome.storage.local.get('ilap_curator_queue', (res) => {
            const q = Array.isArray(res.ilap_curator_queue) ? res.ilap_curator_queue : [];
            const job = q.find(j => j.curatorId === curatorId());
            const text = job ? t('curator_added_state') : t('curator_add_to_queue');
            btn.dataset.label = text;
            if (!btn.disabled) {
                const lbl = btn.querySelector('.ilap-cur-label');
                if (lbl) lbl.textContent = text;
            }
            renderMenu(job ? job.filter : null);
        });
        sync();
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.ilap_curator_queue) sync();
        });
    }

    function inject(report) {
        if (report.querySelector('#' + BTN_ID)) return;
        injectStyle();
        const { wrap, btn } = buildButton(report);
        const { menu, renderMenu } = buildMenu();
        wireMenu(wrap, btn, menu);
        wireStorageSync(btn, renderMenu);
    }

    function tryInject() {
        const report = document.querySelector('.nav_right_side > .curator_report');
        if (!report) return false;
        inject(report);
        return true;
    }

    function boot() {
        if (!curatorId()) return;          // no-op on every non-curator store page
        if (tryInject()) return;
        // The curator chrome can render after load; watch briefly, then give up.
        const obs = new MutationObserver(() => { if (tryInject()) obs.disconnect(); });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => obs.disconnect(), 10000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
