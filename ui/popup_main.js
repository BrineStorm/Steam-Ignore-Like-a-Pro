// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Shared HTML-escaper (src/escape.js, loaded first in popup.html + content_scripts).
    const Sanitizer = window.ILAP.Sanitizer;
    const Settings = window.ILAP.Settings;
    const K = Settings.KEYS;

    const t = window.ILAP.t;

    // See the same pair in ui/popup_settings.js: the language droplist drives
    // the real <select> with its own synthetic `change`, and only the widget
    // surface (an OPEN shadow root on the Steam page) is reachable by page
    // script — the toolbar popup is a chrome-extension:// page nothing can
    // touch, which is also where selectOption() drives this select in tests.
    // The droplist's own event is recognised by identity and value, not by a
    // flag a page listener could fire inside of (see there).
    let selfPick = null;   // { ev, value }: the one dispatch in progress
    const isSelfPick = (e) => !!selfPick && e === selfPick.ev && e.target.value === selfPick.value;
    function dispatchPick(select, value) {
        const ev = new Event('change', { bubbles: true });
        selfPick = { ev, value };
        try { select.dispatchEvent(ev); } finally { selfPick = null; }
    }
    const isPageReachable = (root) => !!(root && root.host);

    // Master toggle off, for every direct child of `parent` the markup does not
    // mark `data-master-exempt`. What survives a disabled extension:
    //   • the IGNORE QUEUE applet, at full strength, so staged work can still be dropped;
    //   • the SETTINGS accordion, for the surface picker inside it;
    //   • the language chip in that summary, undimmed: its droplist inherits the
    //     chip's opacity and turns unreadable over the Steam page.
    // The dim goes per level, never on an ancestor: an ancestor's filter/opacity
    // can't be undone inside it, and nested opacity compounds.
    const isMasterExempt = (el) => el.hasAttribute('data-master-exempt');
    // The look only (`.master-dim`, popup.css), for a level that must stay clickable.
    const applyMasterDim = (parent, off) => {
        Array.from(parent.children).forEach(child => {
            child.classList.toggle('master-dim', off && !isMasterExempt(child));
        });
    };
    // The look plus `inert`, which is what actually takes a control away, keyboard
    // included. Behind both the wrapper (render below) and the settings rows
    // (handed to popup_settings.js).
    const applyMasterInert = (parent, off) => {
        applyMasterDim(parent, off);
        Array.from(parent.children).forEach(child => {
            child.inert = off && !isMasterExempt(child);
        });
    };

    // Compact chip label: primary subtag only (pt-BR -> PT, zh-TW -> ZH).
    const langCode = (lang) => String(lang || 'en').split('-')[0].toUpperCase();

    // The one mouse glyph, for both shortcut hints: the swipe chip (right button
    // lit, sized for a .kbd-key row) and the modifier hint (left button lit,
    // trailing the Ctrl+Click chips). Same body and wheel either way — which
    // button is lit, the class the CSS hooks and the rendered size are the only
    // differences, so they are arguments rather than a second drawing.
    const LIT = '#45A1FA';
    const UNLIT = '#171a21';
    const mouseSvg = (isRight, cls, w, h) => `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 14 48 54" width="${w}" height="${h}" fill="none" class="${cls}" aria-hidden="true">
          <rect x="4" y="18" width="40" height="46" rx="20" ry="20" fill="#1b2838" stroke="#3d4a5d" stroke-width="2"/>
          <path d="M4 28 C4 22 8 18 14 18 L23 18 L23 38 L4 38 Z" fill="${isRight ? UNLIT : LIT}"/>
          <line x1="24" y1="18" x2="24" y2="38" stroke="#3d4a5d" stroke-width="2"/>
          <path d="M25 18 L34 18 C40 18 44 22 44 28 L44 38 L25 38 Z" fill="${isRight ? LIT : UNLIT}"/>
          <rect x="21" y="22" width="6" height="12" rx="3" fill="#ffffff" opacity="0.85"/>
          <path d="M4 42 L4 46 C4 57 14 64 24 64 C34 64 44 57 44 46 L44 42 Z" fill="${UNLIT}"/>
        </svg>`;

    // The swipe and circle glyphs (ui/icons.js), at the hint row's size; the ring
    // sits in the swoosh's slot.
    const swooshSvg = (isRight, slot) => window.ILAP_Icons.swoosh(
        { isRight, gradientId: 'swoosh-' + slot, cls: 'sw-arrow', width: 30, height: 15 });
    const ringSvg = (slot) => window.ILAP_Icons.ring(
        { gradientId: 'ring-' + slot, cls: 'sw-arrow', size: 17 });

    // Build "Hold [mouse] & Swipe [swoosh]" from the localized label, dropping its
    // trailing text arrow in favour of the SVG motion glyph. `motion`: true/false
    // = swoosh right/left, 'circle' = the loop.
    function gestureChip(labelKey, motion, slot) {
        const stripped = t(labelKey).replace(/\s*[→←➜]\s*$/, '').trim();
        const sp = stripped.indexOf(' ');
        const first = sp === -1 ? stripped : stripped.slice(0, sp);
        const rest = sp === -1 ? '' : stripped.slice(sp + 1);
        let inner = `${Sanitizer.escapeHTML(first)}${mouseSvg(true, 'mouse-ico', 15, 21)}`;
        if (rest) inner += Sanitizer.escapeHTML(rest);
        inner += motion === 'circle' ? ringSvg(slot) : swooshSvg(motion, slot);
        return `<span class="kbd-key" style="margin-left:0;">${inner}</span>`;
    }

    function getShortcutHintHtml(key, slot) {
        if (key === 'swipeRight') return gestureChip('hold_and_swipe_right', true, slot);
        if (key === 'swipeLeft') return gestureChip('hold_and_swipe_left', false, slot);
        // The circle can carry an ignore now, so the hint has to be able to draw
        // it. Its own label ("Right-Click + Circle") already names the button, so
        // it goes through the same chip as the swipes — first word, mouse, rest.
        if (key === 'zigzag') return gestureChip('shortcut_zigzag', 'circle', slot);

        const names = { 'ctrlKey': 'Ctrl', 'shiftKey': 'Shift', 'altKey': 'Alt' };

        const safeKeyName = Sanitizer.escapeHTML(names[key] || key);
        const safeLeftClick = Sanitizer.escapeHTML(t('left_click'));
        return `<span class="kbd-key" style="margin-left:0;">${safeKeyName}</span> <span style="margin: 0 4px;">+</span> <span class="kbd-key">${safeLeftClick}</span> ${mouseSvg(false, 'mouse-icon', 16, 18)}`;
    }

    function updateBasicUI(root, data) {
        const isEnabled = Settings.isOn(data[K.MASTER]);

        const master = root.getElementById('master-toggle');
        if (master) master.checked = isEnabled;

        const wrapper = root.getElementById('ui-wrapper');
        if (wrapper) {
            wrapper.classList.toggle('disabled', !isEnabled);
            // The settings rows inside get theirs from popup_settings.js.
            applyMasterInert(wrapper, !isEnabled);
            // The SETTINGS summary stays clickable — it opens onto the surface
            // picker — so its label only dims, around the exempt language chip.
            const settingsSummary = root.querySelector('#settings-accordion > summary');
            if (settingsSummary) applyMasterDim(settingsSummary, !isEnabled);
        }

        const Stats = window.ILAP.StatsLogic;
        root.getElementById('count-link').textContent = data[Stats.COUNT_KEY] || 0;
        root.getElementById('last-game').textContent = data[Stats.LAST_KEY] || t('none');

        const defKey = Settings.normalizeShortcut(data[K.SHORTCUT]) || Settings.DEFAULTS.SHORTCUT;
        const platKey = Settings.normalizeShortcut(data[K.PLATFORM]) || Settings.DEFAULTS.PLATFORM;

        const safeIgnoreLabel = Sanitizer.escapeHTML(t('hint_ignore'));
        const safeAlreadyPlayedLabel = Sanitizer.escapeHTML(t('hint_already_played'));

        let hintHtml = `
            <div class="hint-line">
                <span class="hint-label">${safeIgnoreLabel}</span>
                ${getShortcutHintHtml(defKey, 'def')}
            </div>
        `;

        if (platKey !== 'off') {
            hintHtml += `
                <div class="hint-line" style="margin-top: 8px;">
                    <span class="hint-label" style="color: #3ca8fc;">${safeAlreadyPlayedLabel}</span>
                    ${getShortcutHintHtml(platKey, 'plat')}
                </div>
            `;
        }

        const hintContainer = root.getElementById('dynamic-hint');
        if (hintContainer) {
            hintContainer.innerHTML = hintHtml;
        }

        const history = data[Stats.HISTORY_KEY] || [];
        const historyDiv = root.getElementById('history-list');
        if (historyDiv) {
            if (history.length > 0) {
                // innerHTML needs sanitization
                historyDiv.innerHTML = history.slice(0, 3).map(i => {
                    const safeGameName = Sanitizer.escapeHTML(i.name);
                    return `<div class="history-entry">• ${safeGameName}</div>`;
                }).join('');
            } else {
                const safeEmpty = Sanitizer.escapeHTML(t('no_recent_history'));
                historyDiv.innerHTML = `<div class="history-entry"><i>${safeEmpty}</i></div>`;
            }
        }

        if (window.ILAP && window.ILAP.i18n) window.ILAP.i18n.applyDom(root);

        // Keep the quick language chip in sync with external changes.
        const chip = root.getElementById('lang-quick');
        if (chip && window.ILAP && window.ILAP.i18n) {
            const cur = window.ILAP.i18n.getLang();
            if (chip.value !== cur) chip.value = cur;
            const code = root.getElementById('lang-quick-code');
            if (code) code.textContent = langCode(cur);
        }
    }

    // The language chip in the SETTINGS summary. The native <select> holds the
    // value, invisible; the visible list is our own .select-menu, so the OS
    // dropdown never shows.
    function setupLangChip(root) {
        const chip = root.getElementById('lang-quick');
        const code = root.getElementById('lang-quick-code');
        if (!chip || !window.ILAP || !window.ILAP.i18n) return;

        // List shows full native names; the chip itself only ever shows the short code.
        chip.innerHTML = window.ILAP.i18n.getLanguages()
            .filter(l => l.translated)
            .map(l => {
                const label = l.beta ? `${l.name} (beta)` : l.name;
                return `<option value="${Sanitizer.escapeHTML(l.code)}">${Sanitizer.escapeHTML(label)}</option>`;
            })
            .join('');
        const cur = window.ILAP.i18n.getLang();
        chip.value = cur;
        if (code) code.textContent = langCode(cur);

        chip.addEventListener('change', (e) => {
            if (!(e.isTrusted || isSelfPick(e) || !isPageReachable(root))) return;
            if (code) code.textContent = langCode(e.target.value);
            chrome.storage.local.set({ [K.LANG]: e.target.value });
        });

        const wrap = chip.parentElement; // .lang-chip (position:relative anchor)
        const menu = document.createElement('div');
        menu.className = 'select-menu lang-menu';
        wrap.appendChild(menu);

        // The chip lives inside the SETTINGS <summary>: preventDefault stops the
        // native accordion toggle, stopPropagation keeps the exclusive-collapse
        // logic and the outside-click menu closer (SettingsManager) out of it.
        wrap.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.target.closest('.select-opt')) return; // picks are handled below
            const wasOpen = menu.classList.contains('open');
            root.querySelectorAll('.select-menu.open').forEach(m => m.classList.remove('open'));
            if (wasOpen) return;
            menu.innerHTML = Array.from(chip.options).map(opt =>
                `<div class="select-opt${opt.value === chip.value ? ' selected' : ''}" data-value="${Sanitizer.escapeHTML(opt.value)}">${Sanitizer.escapeHTML(opt.textContent)}</div>`
            ).join('');
            menu.classList.add('open');
            // Centre the current language in the scrollable list (menu.scrollTop,
            // NOT scrollIntoView — that would also scroll the popup body).
            const sel = menu.querySelector('.select-opt.selected');
            if (sel) menu.scrollTop = sel.offsetTop - (menu.clientHeight - sel.offsetHeight) / 2;
        });

        menu.addEventListener('click', (e) => {
            if (!e.isTrusted) return;   // a real pick; tests click this for real too
            const item = e.target.closest('.select-opt');
            if (!item) return;
            menu.classList.remove('open');
            const val = item.getAttribute('data-value');
            if (val !== chip.value) {
                chip.value = val;
                dispatchPick(chip, val);
            }
        });
    }

    // Storage is read by name, never with get(null): the ignore log and the
    // curator cache are most of it, and only the undo applet reads the log
    // (through IgnoreLog).

    // What the popup renders besides the queue: settings, surface, stats.
    const uiKeys = () => Object.values(K).concat(window.ILAP.Surface.KEY,
        [window.ILAP.StatsLogic.COUNT_KEY, window.ILAP.StatsLogic.HISTORY_KEY, window.ILAP.StatsLogic.LAST_KEY]);

    // The queue, the per-job cursor, skip-count and lease keys its jobs name,
    // the SW halt flag, plus `extraKeys`.
    function readQueueSnapshot(extraKeys, cb) {
        const Store = window.ILAP.Curator.Store;
        const Lease = window.ILAP.Curator.Lease;
        chrome.storage.local.get([Store.QUEUE_KEY, Store.SW_HALT_KEY].concat(extraKeys), (res) => {
            const jobs = Array.isArray(res[Store.QUEUE_KEY]) ? res[Store.QUEUE_KEY] : [];
            const jobKeys = [];
            for (const j of jobs) {
                jobKeys.push(Store.CURSOR_PREFIX + j.id, Store.SKIPPED_PREFIX + j.id, Lease.LOCK_PREFIX + j.curatorId);
            }
            if (jobKeys.length === 0) { cb(res); return; }
            chrome.storage.local.get(jobKeys, (more) => cb(Object.assign(res, more)));
        });
    }

    // Wire the popup UI against a query root: `document` for the browser popup
    // window, or a shadowRoot for the on-page widget. Both are views over the
    // same chrome.storage.local — the single source of truth.
    // `opts.isVisible` (widget only): while it answers false, storage changes are
    // not rendered, only noted; `show()` on the returned handle catches up. The
    // toolbar popup is visible for as long as it exists.
    function initPopup(root, opts) {
        const isVisible = (opts && opts.isVisible) || (() => true);
        const settings = window.ILAP_Settings.create(root, { applyMasterInert });
        const queue = window.ILAP_Queue.create(root);
        const Log = window.ILAP.IgnoreLog;
        const Store = window.ILAP.Curator.Store;
        const Lease = window.ILAP.Curator.Lease;
        const Stats = window.ILAP.StatsLogic;
        const undoService = new window.ILAP.UndoService({ store: Store, log: Log, maxJobs: Store.MAX_JOBS });
        const undo = window.ILAP_Undo.create(root, undoService);
        const renderUndo = () => Log.getLog().then((log) => undo.render(log));
        // Mid-drain the log changes 1-3 times a second, and each re-read is every
        // chunk: one trailing re-read per second is plenty for a count.
        let undoTimer = null;
        const renderUndoSoon = () => {
            if (undoTimer) return;
            undoTimer = setTimeout(() => { undoTimer = null; renderUndo(); }, 1000);
        };
        // The queue applet, and the one number outside it a drain moves. Two
        // entry points: `now` for anything a user did (stage, pause, remove, a
        // landed POST) and `soon` for drain PROGRESS, which arrives far faster
        // than it reads — see the listener below.
        const renderQueue = () => {
            readQueueSnapshot([K.MASTER, Stats.COUNT_KEY], (current) => {
                queue.render(current);
                // The one piece of the basic UI a drain does move: the total.
                // Value-only, so the markup and its CSS transitions survive —
                // and last in the callback, so a missing element can't cost the
                // queue applet its render.
                root.getElementById('count-link').textContent = current[Stats.COUNT_KEY] || 0;
            });
        };
        let queueTimer = null;
        const renderQueueNow = () => {
            clearTimeout(queueTimer);
            queueTimer = null;
            renderQueue();
        };
        const renderQueueSoon = () => {
            if (queueTimer) return;
            queueTimer = setTimeout(() => { queueTimer = null; renderQueue(); }, 1000);
        };

        // Set while hidden: something changed / the language among it.
        let stale = false;
        let staleLang = false;

        // Everything the popup shows. `langChanged`: rebuild the settings panel's
        // labels too (a rebuild mid-interaction kills its CSS transitions, so
        // only when the language may actually have moved).
        const renderAll = (current, langChanged) => {
            if (current[K.LANG]) window.ILAP.i18n.setLang(current[K.LANG]);
            // Queue renders AFTER the locale switch — its labels go through t(),
            // so rendering first would leave them in the previous language.
            queue.render(current);
            renderUndo();
            updateBasicUI(root, current);
            // Reflect external setting changes (e.g. EQ "Disable" → q_master=false)
            // onto the open settings panel. Value-only, preserves CSS transitions.
            settings.syncValues(current);
            if (langChanged && settings.relabel) settings.relabel(current);
        };

        const readAll = (cb) => readQueueSnapshot(uiKeys(), cb);

        // Settles once the first render has landed: the UI keys, the undo button
        // (the ignore log is its own read) and, if it restores open, the settings
        // panel (its own read too). The widget reveals its panel on this, so the
        // bare markup is never painted; the toolbar popup does not wait on it.
        let markReady;
        const ready = new Promise((resolve) => { markReady = resolve; });

        readAll((res) => {
            if (res[K.LANG]) window.ILAP.i18n.setLang(res[K.LANG]);

            const icon = root.getElementById('ilap-header-icon');
            if (icon) icon.src = chrome.runtime.getURL('assets/icons/icon48.png');

            setupLangChip(root);
            updateBasicUI(root, res);
            queue.render(res);
            const undoRendered = renderUndo();

            const accordion = root.getElementById('settings-accordion');
            const queueAcc = root.getElementById('queue-accordion');
            accordion.open = !!res[K.SETTINGS_OPEN];
            const settingsRendered = accordion.open ? settings.init() : null;
            // allSettled: a failed read must not keep the panel from ever opening.
            Promise.allSettled([undoRendered, settingsRendered]).then(() => markReady());

            // The two applets are mutually exclusive: opening one collapses the other.
            // We only act on the open transition, so closing the other can't loop back.
            accordion.addEventListener('toggle', () => {
                chrome.storage.local.set({ [K.SETTINGS_OPEN]: accordion.open });
                if (accordion.open) {
                    settings.init();
                    if (queueAcc) queueAcc.open = false;
                }
            });

            if (queueAcc) {
                queueAcc.addEventListener('toggle', () => {
                    if (queueAcc.open) accordion.open = false;
                });
            }

            // Collapse the sibling SYNCHRONOUSLY on the summary click (shared helper;
            // see wireExclusiveDetails in popup_settings.js for why in-frame). The
            // `toggle` handlers above still own persistence + lazy settings.init()
            // (and the lang-chip open path), so those keep working. The language chip
            // sits in the SETTINGS summary and owns its own click.
            const wireExclusive = window.ILAP_Settings.wireExclusiveDetails;
            wireExclusive(accordion, queueAcc, '.lang-chip');
            wireExclusive(queueAcc, accordion, '.lang-chip');

            // Real user input only: in the on-page widget this panel lives in an
            // open shadow root, where page script could otherwise forge a
            // `change` and disable the extension without the user seeing it.
            // Nothing here dispatches `change` at this checkbox.
            root.getElementById('master-toggle').addEventListener('change', (e) => {
                if (!e.isTrusted) return;
                chrome.storage.local.set({ [K.MASTER]: e.target.checked });
            });

            const rootEl = root.getElementById('popup-root');
            setTimeout(() => rootEl && rootEl.classList.remove('no-transition'), 100);
        });

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            // A closed widget panel renders nothing; show() catches up on open.
            if (!isVisible()) {
                stale = true;
                if (changes[K.LANG]) staleLang = true;
                return;
            }
            // Three paths, by what a key feeds. A key none of them names (the
            // gate's stamps, the widget's own state, the MI pulses) renders nothing.
            //  - settings, surface, history: the whole popup;
            //  - the queue and its drain progress, and the total: the queue applet
            //    and the count only — rebuilding every other panel's markup for a
            //    moving number is pure waste;
            //  - the ignore log: the undo applet, throttled.
            const keys = Object.keys(changes || {});
            const fullKeys = uiKeys().filter(k => k !== Stats.COUNT_KEY);
            const isQueueKey = (k) => k === Store.QUEUE_KEY
                || k === Store.PULSE_KEY
                || k === Store.SW_HALT_KEY
                || k === Stats.COUNT_KEY
                || k.indexOf(Store.CURSOR_PREFIX) === 0
                || k.indexOf(Store.SKIPPED_PREFIX) === 0
                || k.indexOf(Lease.LOCK_PREFIX) === 0;
            const isProgressKey = (k) => k.indexOf(Store.CURSOR_PREFIX) === 0
                || k.indexOf(Store.SKIPPED_PREFIX) === 0;
            if (keys.some(k => fullKeys.includes(k))) {
                readAll((current) => renderAll(current, !!changes[K.LANG]));
                return;
            }
            if (keys.some(Log.isLogKey)) renderUndoSoon();
            const touched = keys.filter(isQueueKey);
            if (!touched.length) return;
            // Drain PROGRESS is the one write this panel cannot keep up with. A
            // dedupe skip sends no POST, so it is not paced by the rate gate
            // (curator/drainer.js says so in as many words): a curator job over a
            // mostly-ignored list advances the cursor as fast as storage answers,
            // and each advance moved one number in one row through a full
            // innerHTML rebuild of the list. Those collapse into one trailing
            // render a second, like the undo applet's count. Everything else here
            // is a user action or a landed POST and stays immediate.
            if (touched.every(isProgressKey)) renderQueueSoon();
            else renderQueueNow();
        });

        return {
            ready,
            // The widget panel opened: render whatever changed while it was closed.
            show() {
                if (!stale) return;
                const langChanged = staleLang;
                stale = staleLang = false;
                readAll((current) => renderAll(current, langChanged));
            }
        };
    }

    window.ILAP_Popup = { init: initPopup };

    // The toolbar popup in widget mode: a pointer at the on-page widget, a button
    // that moves the interface here, and the aggregate drain progress — the one
    // place that shows it with no Steam page open.
    function renderPopupStub(mount) {
        mount.innerHTML = `
            <div id="ilap-popup-stub">
                <img src="${chrome.runtime.getURL('assets/icons/icon48.png')}" alt="">
                <p id="ilap-stub-msg" data-i18n="popup_stub_message"></p>
                <div id="ilap-stub-progress" hidden>
                    <span id="ilap-stub-progress-text"></span>
                    <div id="ilap-stub-halt" hidden></div>
                </div>
                <span id="ilap-stub-btnwrap">
                    <button type="button" id="ilap-stub-switch" data-i18n="popup_stub_switch"></button>
                </span>
            </div>`;
        if (window.ILAP && window.ILAP.i18n) window.ILAP.i18n.applyDom(mount);

        const btn = mount.querySelector('#ilap-stub-switch');
        btn.addEventListener('click', () => {
            chrome.storage.local.set({ [window.ILAP.Surface.KEY]: 'popup' });
        });

        // Aggregate "done / total" over EVERY queued job — pendings included,
        // curator and undo jobs alike (one number, not a per-job breakdown; the
        // full applet lives in the widget and in popup mode). Hidden while the
        // queue is empty. The ilap_sw_halt hint surfaces here too: with no
        // Steam tab open this stub is the only place it can be seen.
        const Store = window.ILAP.Curator.Store;
        const progress = mount.querySelector('#ilap-stub-progress');
        const progressText = mount.querySelector('#ilap-stub-progress-text');
        const haltHint = mount.querySelector('#ilap-stub-halt');
        const renderProgress = () => {
            readQueueSnapshot([], (res) => {
                const jobs = Array.isArray(res[Store.QUEUE_KEY]) ? res[Store.QUEUE_KEY] : [];
                if (jobs.length === 0) { progress.hidden = true; return; }
                let done = 0;
                let total = 0;
                for (const j of jobs) {
                    const size = j.total || (Array.isArray(j.appids) ? j.appids.length : 0);
                    const cur = res[Store.CURSOR_PREFIX + j.id];
                    total += size;
                    done += Math.min(Number.isFinite(cur) ? cur : (j.cursor || 0), size);
                }
                progressText.textContent = `${t('ignore_queue')}: ${done} / ${total}`;
                haltHint.hidden = !res[Store.SW_HALT_KEY];
                if (!haltHint.hidden) haltHint.textContent = t('queue_sw_halt');
                progress.hidden = false;
            });
        };
        renderProgress();
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            const touched = Object.keys(changes || {}).some((k) =>
                k === Store.QUEUE_KEY || k === Store.SW_HALT_KEY
                || k.indexOf(Store.CURSOR_PREFIX) === 0);
            if (touched) renderProgress();
        });
    }

    // Browser-popup bootstrap: mount the shared markup into the popup window and
    // wire it against `document`. On a Steam page there is no mount point, so this
    // is a no-op there — the widget mounts and inits its own shadow root instead.
    // The view depends on the surface mode: in widget mode the popup is only a
    // signpost (stub) pointing at the on-page widget; in popup mode it hosts the
    // full UI. A surface flip simply reloads the window — the popup is stateless,
    // so re-bootstrapping beats swapping live views (and their listeners) in place.
    function bootstrapPopupWindow() {
        const mount = document.getElementById('ilap-popup-mount');
        if (!mount || mount.dataset.ilapMounted) return;
        mount.dataset.ilapMounted = '1';

        const Surface = window.ILAP.Surface;
        chrome.storage.local.get({ [Surface.KEY]: 'widget', [K.LANG]: null, ilap_update_glow: false }, (res) => {
            if (res[K.LANG]) window.ILAP.i18n.setLang(res[K.LANG]);
            const mode = Surface.resolve(res[Surface.KEY], navigator.userAgent);
            if (mode === 'popup') {
                mount.innerHTML = window.ILAP_PopupMarkup;
                initPopup(document);
                // One-shot post-update welcome (armed by src/migrate.js on the
                // popup-migration update only): a 5 s gold wash over the popup.
                if (res.ilap_update_glow) {
                    const rootEl = document.getElementById('popup-root');
                    if (rootEl) rootEl.classList.add('update-glow'); // animation ends transparent; no cleanup needed
                }
            } else {
                renderPopupStub(mount);
            }
            // One-shot, whatever this bootstrap rendered.
            if (res.ilap_update_glow) chrome.storage.local.set({ ilap_update_glow: false });
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local') return;
                if (!changes[Surface.KEY]) return;
                if (Surface.resolve(changes[Surface.KEY].newValue, navigator.userAgent) !== mode) {
                    location.reload();
                }
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrapPopupWindow);
    } else {
        bootstrapPopupWindow();
    }

})();