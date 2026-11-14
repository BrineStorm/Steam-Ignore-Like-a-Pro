// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // On a curator page: an "Add to ignore queue" button before the Options gear
    // in `.nav_right_side > .curator_report`, with its own filter menu. Picking a
    // filter stages a job through the EnqueueService, which also resolves its app
    // list; a queued filter's row in the same menu has the cross that removes its
    // job (Pause lives in the queue applet). Draining is the drainer's (curator/drainer.js).
    // The button's look is in button-style.js, the menu's rows and keys in menu.js.

    const t = window.ILAP.t;

    const ButtonStyle = window.ILAP.Curator.ButtonStyle;
    const BTN_ID = ButtonStyle.BTN_ID;
    const ICON_URL = chrome.runtime.getURL('assets/icons/icon48.png');

    // Filter vocabulary + label colours are shared with the popup applet (see
    // src/curator/filters.js, loaded before this script).
    const Filters = window.ILAP_Filters;
    const Store = window.ILAP.Curator.Store;
    const typeStyle = (value) => Filters.colorStyle(value);

    // Shared HTML-escaper (src/escape.js, loaded before this script).
    const esc = window.ILAP.Sanitizer.escapeHTML;

    const Menu = window.ILAP.Curator.createButtonMenu({ t, esc, filters: Filters });

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

    function flash(btn, text) {
        const lbl = btn.querySelector('.ilap-cur-label');
        lbl.textContent = text;
        // Disabled, the button lets go of a keyboard focus: it takes it back after.
        const had = document.activeElement === btn;
        btn.disabled = true;
        setTimeout(() => {
            lbl.textContent = btn.dataset.label;
            btn.disabled = false;
            if (had && document.activeElement === document.body) btn.focus();
        }, 1600);
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

    // What a resolve() answered: an empty result drops the job, so the user is
    // told instead of left with a silently vanished button state. A short one is
    // a job that covers only what was read, said out loud because its row would
    // otherwise look like a complete curator with a small catalogue, and re-adding
    // is what finishes it. `curator`: its name, for a job this page did not stage
    // (adoptOrphans): the page may be any page.
    function reportResolved(res, curator) {
        const say = (key, ms) => window.ILAP.showToast((curator ? curator + ': ' : '') + t(key), ms);
        if (res && res.error) say('curator_toast_error', 4500);
        else if (res && res.partial) say('curator_toast_partial', 5000);
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
            // For the frame on the pages of the games it ignores (list-frame.js).
            window.ILAP.Curator.DoneMarks.noteListName(id, name).catch(swallow);
            return service.resolve(id, outcome.jobId, outcome.name, outcome.filter).then((res) => reportResolved(res));
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
                <span class="ilap-cur-div"></span>
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
    // Every subscription is bound to `signal`, like the menu's listeners: aborting
    // the injection's controller is the whole unsubscribe, whatever channels this adds.
    function wireStorageSync(btn, menu, renderMenu, signal) {
        const square = btn.querySelector('.ilap-cur-sq');
        wireSquareTip(square, signal);
        const Log = window.ILAP.IgnoreLog;
        // Recently-undone window for the soft re-stage warning.
        const WARN_WINDOW_MS = 48 * 3600000;
        // When this curator's ignores were last rolled back, null until read. The
        // whole log is read once, and again only as a rollback job leaves the
        // queue: every gesture in any tab writes the queue, and the log moves 1-3
        // times a second in a drain.
        let undoneAt = null;
        const readUndone = async () => {
            if (undoneAt === null) {
                undoneAt = Log.lastUndoneForCurator(await Log.getLog(), curatorId(), WARN_WINDOW_MS, Date.now());
            }
            return undoneAt;
        };
        // Aborted = injection removed. The subscriptions go with it; this guard
        // covers a read still in flight at that moment.
        const sync = () => chrome.storage.local.get([Store.QUEUE_KEY], async (res) => {
            const undone = await readUndone();
            if (signal.aborted) return;
            const q = Array.isArray(res[Store.QUEUE_KEY]) ? res[Store.QUEUE_KEY] : [];
            const id = curatorId();
            const types = Filters.coveredTypes(q, id);
            const queued = new Set(Filters.curatorJobs(q, id).map(j => j.filter));
            // Not Recommended red, Informational yellow, both the gradient.
            const cover = Filters.coverFilter(types);
            square.hidden = !cover;
            square.setAttribute('style', cover ? Filters.fillStyle(cover) : '');
            square.dataset.tip = cover ? t(Filters.labelKey(cover)) : '';
            const text = cover ? t('curator_added_state') : t('curator_add_to_queue');
            btn.dataset.label = text;
            if (!btn.disabled) {
                const lbl = btn.querySelector('.ilap-cur-label');
                if (lbl) lbl.textContent = text;
            }
            const ago = Date.now() - undone;
            renderMenu(queued, types, undone > 0 && ago <= WARN_WINDOW_MS ? ago : 0);
            // A language switch refits the button, so an open menu is placed again.
            if (menu.classList.contains('open')) Menu.place(btn, menu);
        });
        sync();
        // The width depends on the language and the font only, never on the
        // queue. The first fit can run on the fallback face, before Steam's webfont.
        const fit = () => { if (!signal.aborted) Menu.fitWidth(btn); };
        fit();
        document.fonts.ready.then(fit);
        // Not keyed on the log: the drainer writes it 1-3 times a second mid-drain
        // and each sync re-measures the menu. The warning's input changes when an
        // undo job finishes, which removes the job from the queue and lands here.
        const onChanged = (changes, area) => {
            if (area !== 'local' || !changes[Store.QUEUE_KEY]) return;
            if (Store.undoJobLeft(changes[Store.QUEUE_KEY])) undoneAt = null;
            sync();
        };
        chrome.storage.onChanged.addListener(onChanged);
        // A language change re-derives the same things a queue change does
        // (button label + menu option labels), so it rides the same sync.
        window.ILAP.i18n.onLangChange(sync);
        window.ILAP.i18n.onLangChange(fit);
        // Re-injected on every master flip, so these must not leak.
        signal.addEventListener('abort', () => {
            chrome.storage.onChanged.removeListener(onChanged);
            window.ILAP.i18n.offLangChange(sync);
            window.ILAP.i18n.offLangChange(fit);
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
            ButtonStyle.inject();
            const { wrap, btn } = buildButton(report);
            const { menu, render } = Menu.build();
            const ac = new AbortController();
            // The menu is drawn as it opens, from the queue as it is then, and
            // live while it is open. Shut or fading, a change waits: a pick
            // never stamps "In queue" on the row it fades out with.
            let last = null;
            const draw = (...args) => {
                last = args;
                if (Menu.isShown(menu)) render(...args);
            };
            Menu.wire({
                wrap, btn, menu, signal: ac.signal,
                redraw: () => { if (last) render(...last); },
                onPick: (value) => pick(service, value, btn),
                onRemove: (value) => {
                    const id = curatorId();
                    if (!id) return;
                    service.removeQueued(id, value)
                        .catch((err) => console.warn('[ILAP] curator job removal failed:', err));
                },
            });
            wireStorageSync(btn, menu, draw, ac.signal);
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
            ButtonStyle.remove();   // inject() puts it back with the button
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
        const C = window.ILAP.Curator;
        const service = new C.EnqueueService({
            store: C.Store, cache: C.Cache, enumerator: C.Enumerator, filters: Filters, maxJobs: C.Store.MAX_JOBS
        });

        // Any store page takes over a job a closed tab left without its list.
        // With the master off or signed out, Steam is not asked.
        service.adoptOrphans(async () => !(await window.ILAP.IgnoreGate.stopVerdict()))
            .then(answers => answers.forEach(a => reportResolved(a.res, a.name)))
            .catch((e) => console.warn('[ILAP] curator job adoption failed:', e));

        if (!curatorId()) return;          // the button is a curator page's alone

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
