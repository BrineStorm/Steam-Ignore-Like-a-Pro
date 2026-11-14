// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Shared HTML-escaper (src/escape.js, loaded first in popup.html + content_scripts).
    const Sanitizer = window.ILAP.Sanitizer;
    const Settings = window.ILAP.Settings;
    const K = Settings.KEYS;

    const t = window.ILAP.t;

    // Master toggle off, for every direct child of `parent` the markup does not
    // mark `data-master-exempt`. What survives a disabled extension: the tab
    // line and its panel, so staged work can still be dropped, the surface
    // picker is in reach and the language can change. Only the lists button
    // goes dead (ListPanes.setMasterOff).
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

    // The one mouse glyph, for both shortcut hints: the swipe chip (right button
    // lit, sized for a .kbd-key row) and the modifier hint (left button lit,
    // trailing the Ctrl+Click chips). Same body and wheel either way — which
    // button is lit, the class the CSS hooks and the rendered size are the only
    // differences, so they are arguments rather than a second drawing. Each
    // part is lit from above (a gradient down it, a gloss over the buttons) so
    // the mouse reads as a body. The two buttons are the two halves of the
    // body's top, cut by its outline, so the lit one and the dark one are the
    // same size. The body has softly rounded top corners and a round bottom.
    // The ids take the hint's slot, like the swoosh's.
    const BODY = 'M6 28 C6 22 10 18 16 18 L32 18 C38 18 42 22 42 28 L42 46 C42 57 33 64 24 64 C15 64 6 57 6 46 Z';
    const mouseSvg = (isRight, cls, w, h, slot) => {
        const id = (part) => `mouse-${slot}-${part}`;
        const lit = `url(#${id('lit')})`, unlit = `url(#${id('unlit')})`;
        return `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 14 48 54" width="${w}" height="${h}" fill="none" class="${cls}" aria-hidden="true">
          <defs>
            <clipPath id="${id('shape')}"><path d="${BODY}"/></clipPath>
            <linearGradient id="${id('lit')}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a6d6ff"/><stop offset=".5" stop-color="#45A1FA"/><stop offset="1" stop-color="#2163ad"/></linearGradient>
            <linearGradient id="${id('unlit')}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a4555"/><stop offset="1" stop-color="#161b23"/></linearGradient>
            <linearGradient id="${id('palm')}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#232a35"/><stop offset="1" stop-color="#06080b"/></linearGradient>
            <linearGradient id="${id('wheel')}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#9aabbd"/><stop offset=".5" stop-color="#ffffff"/><stop offset="1" stop-color="#8496aa"/></linearGradient>
            <linearGradient id="${id('gloss')}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".35"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
          </defs>
          <g clip-path="url(#${id('shape')})">
            <rect x="4" y="18" width="20" height="22" fill="${isRight ? unlit : lit}"/>
            <rect x="24" y="18" width="20" height="22" fill="${isRight ? lit : unlit}"/>
            <rect x="4" y="40" width="40" height="24" fill="url(#${id('palm')})"/>
            <rect x="4" y="18" width="40" height="11" fill="url(#${id('gloss')})"/>
            <path d="M9 47 C10 55 16 60 24 61" stroke="#ffffff" stroke-opacity=".12" stroke-width="1.5" stroke-linecap="round"/>
          </g>
          <path d="M24 18 V40 M6 40 H42" stroke="#0a1017" stroke-width="1.6"/>
          <rect x="21" y="22" width="6" height="12" rx="3" fill="url(#${id('wheel')})" stroke="#0a1017" stroke-width=".8"/>
          <path d="${BODY}" stroke="#4a5b71" stroke-width="2"/>
        </svg>`;
    };

    // The swipe and circle glyphs (ui/icons.js), at the hint row's size; the ring
    // sits in the swoosh's slot.
    const swooshSvg = (isRight, slot) => window.ILAP_Icons.swoosh(
        { isRight, gradientId: 'swoosh-' + slot, cls: 'sw-arrow', width: 30, height: 15 });
    const ringSvg = (slot) => window.ILAP_Icons.ring(
        { gradientId: 'ring-' + slot, cls: 'sw-arrow', size: 17 });

    // Build "Hold [mouse] & Swipe [swoosh]" from the localized label, dropping its
    // trailing text arrow in favour of the SVG motion glyph. `motion`: true/false
    // = swoosh right/left, 'circle' = the loop. The mouse goes after the first
    // word, so a two-word verb is joined by a no-break space (tr "Basılı tut").
    function gestureChip(labelKey, motion, slot) {
        const stripped = t(labelKey).replace(/\s*[→←➜]\s*$/, '').trim();
        const sp = stripped.indexOf(' ');
        const first = sp === -1 ? stripped : stripped.slice(0, sp);
        const rest = sp === -1 ? '' : stripped.slice(sp + 1);
        let inner = `${Sanitizer.escapeHTML(first)}${mouseSvg(true, 'mouse-ico', 15, 21, slot)}`;
        if (rest) inner += Sanitizer.escapeHTML(rest);
        inner += motion === 'circle' ? ringSvg(slot) : swooshSvg(motion, slot);
        return `<span class="kbd-key" style="margin-left:0;">${inner}</span>`;
    }

    function getShortcutHintHtml(key, slot) {
        if (key === 'swipeRight') return gestureChip('hold_and_swipe_right', true, slot);
        if (key === 'swipeLeft') return gestureChip('hold_and_swipe_left', false, slot);
        // The circle can be bound to an ignore, so the hint has to be able to draw
        // it. Its own label ("Right-Click + Circle") already names the button, so
        // it goes through the same chip as the swipes — first word, mouse, rest.
        if (key === 'zigzag') return gestureChip('shortcut_zigzag', 'circle', slot);

        const names = { 'ctrlKey': 'Ctrl', 'shiftKey': 'Shift', 'altKey': 'Alt' };

        const safeKeyName = Sanitizer.escapeHTML(names[key] || key);
        const safeLeftClick = Sanitizer.escapeHTML(t('left_click'));
        return `<span class="kbd-key" style="margin-left:0;">${safeKeyName}</span> <span style="margin: 0 4px;">+</span> <span class="kbd-key">${safeLeftClick}</span> ${mouseSvg(false, 'mouse-icon', 16, 18, slot)}`;
    }

    // When Steam's list was last read: the time alone today, with the date before.
    function formatReadTime(ts) {
        const d = new Date(ts);
        const lang = window.ILAP.i18n.getLang();
        return d.toDateString() === new Date().toDateString()
            ? d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
            : d.toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' });
    }

    // The headline is the extension's own counter; the hover tip shows Steam's
    // whole list (StatsLogic.displayTotal), its number in bold, and when it was
    // read — or says it has not been read yet. Value and tip only, so the markup
    // survives.
    function renderTotal(root, data) {
        const Stats = window.ILAP.StatsLogic;
        const count = data[Stats.COUNT_KEY] || 0;
        const snapshot = data[Stats.TOTAL_KEY];
        const total = Stats.displayTotal(snapshot, count);
        root.getElementById('count-link').textContent = count;
        const tip = root.getElementById('count-tip');
        if (total === null) { tip.textContent = t('total_not_read'); return; }
        // Escaped with a stand-in for the number, which then becomes the <b>.
        const onSteam = Sanitizer.escapeHTML(t('total_on_steam', { n: '\u0001' })).replace('\u0001', `<b>${total}</b>`);
        tip.innerHTML = `${onSteam}<br>${Sanitizer.escapeHTML(t('total_read_at', { time: formatReadTime(snapshot.ts) }))}`;
    }

    // The Already Played line comes and goes with its shortcut. The card, and
    // the panel round it, grow or shrink to the new height over 0.3 s as the
    // line fades in or out, since nothing changes size in one frame. The
    // first render, the same number of lines and reduced motion
    // draw at once. A leaving line stays until the card has shrunk past it.
    const HINT_MS = 300;
    const hintAnims = new WeakMap();
    function renderHint(box, html, lines) {
        const live = hintAnims.get(box);
        if (live && live.html === html) return;
        const from = box.getBoundingClientRect().height;
        if (live) live.stop();
        const before = box.querySelectorAll('.hint-line').length;
        if (!before || before === lines || !box.animate
            || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            box.innerHTML = html;
            return;
        }
        let to, line;
        if (lines > before) {
            box.innerHTML = html;
            to = box.getBoundingClientRect().height;
            line = box.querySelector('.hint-line.is-played');
        } else {
            // From its full height (an interrupted grow is cut short above).
            line = box.querySelector('.hint-line.is-played');
            const gap = parseFloat(getComputedStyle(box).rowGap) || 0;
            to = box.getBoundingClientRect().height - (line ? line.getBoundingClientRect().height + gap : 0);
        }
        box.style.overflow = 'hidden';
        const grow = box.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: HINT_MS, easing: 'ease' });
        const fade = line && line.animate([{ opacity: lines > before ? 0 : 1 }, { opacity: lines > before ? 1 : 0 }],
            { duration: HINT_MS, easing: 'ease', fill: 'forwards' });
        let done = false;
        const stop = () => {
            if (done) return;
            done = true;
            hintAnims.delete(box);
            grow.cancel();
            if (fade) fade.cancel();
            box.style.overflow = '';
            if (lines < before) box.innerHTML = html;
        };
        hintAnims.set(box, { html, stop });
        grow.finished.then(stop, () => {});
    }

    function updateBasicUI(root, data) {
        const isEnabled = Settings.isOn(data[K.MASTER]);

        // The panel speaks its own language, whatever the Steam page around the
        // widget is in: screen readers pick their voice by it.
        const lang = window.ILAP.i18n.getLang();
        const shell = root.getElementById('ilap-shell');
        if (shell) shell.lang = lang;
        if (root === document) document.documentElement.lang = lang;

        const master = root.getElementById('master-toggle');
        if (master) master.checked = isEnabled;

        const wrapper = root.getElementById('ui-wrapper');
        if (wrapper) {
            wrapper.classList.toggle('disabled', !isEnabled);
            // The settings rows inside get theirs from popup_settings.js.
            applyMasterInert(wrapper, !isEnabled);
        }

        renderTotal(root, data);

        const defKey = Settings.normalizeShortcut(data[K.SHORTCUT]) || Settings.DEFAULTS.SHORTCUT;
        const platKey = Settings.normalizeShortcut(data[K.PLATFORM]) || Settings.DEFAULTS.PLATFORM;

        const safeIgnoreLabel = Sanitizer.escapeHTML(t('hint_ignore'));
        const safeAlreadyPlayedLabel = Sanitizer.escapeHTML(t('hint_already_played'));

        let hintHtml = `
            <div class="hint-line is-ignore">
                <span class="hint-label">${safeIgnoreLabel}</span>
                ${getShortcutHintHtml(defKey, 'def')}
            </div>
        `;

        if (platKey !== 'off') {
            hintHtml += `
                <div class="hint-line is-played">
                    <span class="hint-label">${safeAlreadyPlayedLabel}</span>
                    ${getShortcutHintHtml(platKey, 'plat')}
                </div>
            `;
        }

        const hintContainer = root.getElementById('dynamic-hint');
        if (hintContainer) {
            renderHint(hintContainer, hintHtml, platKey !== 'off' ? 2 : 1);
        }

        window.ILAP_History.render(root, data);

        if (window.ILAP && window.ILAP.i18n) window.ILAP.i18n.applyDom(root);
    }

    // Storage is read by name, never with get(null): the ignore log and the
    // curator cache are most of it, and only the undo applet reads the log
    // (through IgnoreLog).

    // Settings a store page keeps for itself: no panel shows them, and the shot
    // count moves with every game shot.
    const NOT_SHOWN = new Set([K.AI_SHOT_COUNT, K.AI_NOTE_COLLAPSED]);
    // What the popup renders besides the queue: settings, surface, stats.
    const uiKeys = () => Object.values(K).filter(k => !NOT_SHOWN.has(k)).concat(window.ILAP.Surface.KEY,
        [window.ILAP.StatsLogic.COUNT_KEY, window.ILAP.StatsLogic.TOTAL_KEY,
            window.ILAP.StatsLogic.HISTORY_KEY, window.ILAP.StatsLogic.LAST_KEY]);

    // The queue, the per-job cursor, skip-count and lease keys its jobs name,
    // the SW halt flag, plus `extraKeys`.
    function readQueueSnapshot(extraKeys, cb) {
        const Store = window.ILAP.Curator.Store;
        const Lease = window.ILAP.Curator.Lease;
        chrome.storage.local.get([Store.QUEUE_KEY, Store.SW_HALT_KEY].concat(extraKeys), (res) => {
            const jobs = Array.isArray(res[Store.QUEUE_KEY]) ? res[Store.QUEUE_KEY] : [];
            const jobKeys = [];
            for (const j of jobs) {
                jobKeys.push(Store.CURSOR_PREFIX + j.id, Store.SKIPPED_PREFIX + j.id, Store.WISHLISTED_PREFIX + j.id,
                    Store.OWNED_PREFIX + j.id, Lease.LOCK_PREFIX + j.curatorId);
            }
            if (jobKeys.length === 0) { cb(res); return; }
            chrome.storage.local.get(jobKeys, (more) => cb(Object.assign(res, more)));
        });
    }

    // What a panel reads of a module, by name: the rest stays out of its reach.
    const pick = (from, names) => Object.fromEntries(names.map(n => [n, from[n]]));

    // Wire the popup UI against a query root: `document` for the browser popup
    // window, or a shadowRoot for the on-page widget. Both are views over the
    // same chrome.storage.local — the single source of truth.
    // `opts.isVisible` (widget only): while it answers false, storage changes are
    // not rendered, only noted; `show()` on the returned handle catches up. The
    // toolbar popup is visible for as long as it exists.
    function initPopup(root, opts) {
        const isVisible = (opts && opts.isVisible) || (() => true);
        const Log = window.ILAP.IgnoreLog;
        const Store = window.ILAP.Curator.Store;
        const Lease = window.ILAP.Curator.Lease;
        const Marks = window.ILAP.Curator.DoneMarks;
        const Stats = window.ILAP.StatsLogic;
        const Creators = window.ILAP.Creators;
        // A language picked in the language tab folds it.
        const settings = window.ILAP_Settings.create(root, { applyMasterInert, foldLang: () => tabs.select(null) });
        // In the toolbar popup the lists drop down under the tab line where a
        // tab's pane opens, so the two take turns there, the one coming in
        // taking over the other's height (one move of the window).
        const dropDown = root === document;
        // Settings and the language grid render lazily, as their tabs open.
        const tabs = window.ILAP_Tabs.create(root, {
            onOpen: (name) => {
                return name === 'settings' ? settings.init()
                    : name === 'lang' ? settings.renderLang() : null;
            },
            takeOver: () => dropDown ? presets.foldNow() : 0,
            // An AI level moved with no tick is dropped as its tab shuts.
            onLeave: (name) => { if (name === 'ai') aiTab.dropDraft(); },
        });
        // The queue unrolls over whatever is out (a tab, in the toolbar popup
        // the lists). In the toolbar popup it shuts at a click on any button
        // of the tab line. In the widget it stays out: the lists' window moves
        // down out from under it, the lists button opens it under the queue,
        // and a tab of the line shuts the lists.
        const Filters = window.ILAP_Filters;
        const queue = window.ILAP_Queue.create(root, {
            store: pick(Store, ['QUEUE_KEY', 'SW_HALT_KEY', 'removeJob', 'updateJob']),
            settings: pick(Settings, ['KEYS', 'isOn']),
            rows: window.ILAP_QueueRows.create({
                store: pick(Store, ['JOB_TYPE', 'jobType', 'jobTraits', 'CURSOR_PREFIX', 'SKIPPED_PREFIX',
                    'WISHLISTED_PREFIX', 'OWNED_PREFIX']),
                lease: pick(Lease, ['LOCK_PREFIX']),
                filters: pick(Filters, ['fillStyle', 'labelKey']),
                presetLabel: window.ILAP_Presets.label,
            }),
            presetLabel: window.ILAP_Presets.label,
            // Only the on-page widget can be on a curator's page.
            currentCurator: () => Filters.curatorIdFromPath(location.pathname),
            onToggle: () => presets.follow(),
        });
        const tabline = root.getElementById('tabline');
        if (tabline) tabline.addEventListener('click', (e) => {
            const tab = e.isTrusted && e.target.closest('.tab');
            if (!tab) return;
            if (dropDown) queue.toggle(false);
            else if (tab.id !== 'lists-btn') presets.toggle(false);
        });
        // A + in the lists flies the list into the job count on the queue's
        // icon, which holds its old number until it lands.
        const presets = window.ILAP_Presets.create(root, {
            store: pick(Store, ['getQueue', 'stagePreset']),
            marks: pick(Marks, ['presetMarks', 'markPresetSeen']),
            loadPresets: () => window.ILAP.loadPresets(),
            aiGames: (data, keep) => window.ILAP.aiGames(data, keep),
            holdCount: () => queue.holdCount(),
            flyToQueue: (row, from) => queue.flyIn(row, from),
            queueFoot: () => queue.foot(),
            onOpen: () => {
                if (!dropDown) return 0;
                queue.toggle(false);
                return tabs.foldNow();
            },
        });
        // The AI tab. Its boxes as stored set what the AI lists count and queue.
        const aiTab = window.ILAP_AiTab.create(root, {
            onKeep: (keep) => presets.setKeep(keep),
            // Rebuilt in a new language: the tab panel follows its height.
            resizePane: (mutate) => tabs.resize(mutate),
        });
        // The extension's state reaches the lists button before the rest renders.
        const renderBasic = (data) => {
            presets.setMasterOff(!Settings.isOn(data[K.MASTER]));
            updateBasicUI(root, data);
            aiTab.render(data);
        };
        const undoService = new window.ILAP.UndoService({ store: Store, log: Log, maxJobs: Store.MAX_JOBS });
        // A rollback staged from the undo menu flies into the job count too.
        const undo = window.ILAP_Undo.create(root, undoService, {
            log: pick(Log, ['getLog', 'undoableCount']),
            showQueue: () => queue.toggle(true),
            holdCount: () => queue.holdCount(),
            flyToQueue: (row, from) => queue.flyIn(row, from),
            unignoreCreator: (clanid, name) => Store.enqueueCreator({ clanid, name, ignore: false }),
        });
        // The creators the account ignores, as the user sees them: the mirror
        // with the creator job's waiting entries over it.
        const readCreators = async () => {
            const { mirror, job, cursor } = await Creators.readState(Store);
            return Creators.effective(mirror, job, cursor);
        };
        const renderUndo = () => Promise.all([Log.getLog(), readCreators()])
            .then(([log, creators]) => undo.render(log, creators));
        window.ILAP_History.wire(root);
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
            readQueueSnapshot([K.MASTER, Stats.COUNT_KEY, Stats.TOTAL_KEY], (current) => {
                queue.render(current);
                // The one piece of the basic UI a drain does move: the total.
                // Value-only, so the markup and its CSS transitions survive —
                // and last in the callback, so a missing element can't cost the
                // queue applet its render.
                renderTotal(root, current);
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
            if (langChanged) {
                tabs.relabel();
                if (presets.isOpen) presets.refresh().catch(() => {});
            }
            renderBasic(current);
            // Reflect external setting changes (e.g. EQ "Disable" → q_master=false)
            // onto the open settings panel. Value-only, preserves CSS transitions.
            settings.syncValues(current);
            if (langChanged && settings.relabel) settings.relabel(current);
        };

        const readAll = (cb) => readQueueSnapshot(uiKeys(), cb);

        // Settles once the first render has landed: the UI keys, the undo button
        // (the ignore log is its own read) and the tab that was open last, with
        // its pane filled. The widget reveals its panel on this, so the bare
        // markup is never painted; the toolbar popup does not wait on it.
        let markReady;
        const ready = new Promise((resolve) => { markReady = resolve; });

        readAll((res) => {
            if (res[K.LANG]) window.ILAP.i18n.setLang(res[K.LANG]);

            const icon = root.getElementById('ilap-header-icon');
            if (icon) icon.src = chrome.runtime.getURL('assets/icons/icon48.png');

            tabs.relabel();
            renderBasic(res);
            queue.render(res);
            const undoRendered = renderUndo();
            // allSettled: a failed read must not keep the panel from ever opening.
            Promise.allSettled([undoRendered, tabs.restore()]).then(() => markReady());

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
            // Apart from those, the queue, the lists' done marks and their
            // dismissed dots redraw an open lists drawer.
            const keys = Object.keys(changes || {});
            if (presets.isOpen && keys.some(k => k === Store.QUEUE_KEY
                || k.indexOf(Marks.PRESET_DONE_PREFIX) === 0 || k.indexOf(Marks.PRESET_SEEN_PREFIX) === 0)) {
                presets.refresh().catch((e) => console.warn('[ILAP] built-in lists unavailable:', e));
            }
            const fullKeys = uiKeys().filter(k => k !== Stats.COUNT_KEY && k !== Stats.TOTAL_KEY);
            const isQueueKey = (k) => k === Store.QUEUE_KEY
                || k === Store.PULSE_KEY
                || k === Store.SW_HALT_KEY
                || k === Stats.COUNT_KEY
                || k === Stats.TOTAL_KEY
                || k.indexOf(Store.CURSOR_PREFIX) === 0
                || k.indexOf(Store.SKIPPED_PREFIX) === 0
                || k.indexOf(Store.WISHLISTED_PREFIX) === 0
                || k.indexOf(Store.OWNED_PREFIX) === 0
                || k.indexOf(Lease.LOCK_PREFIX) === 0;
            const isProgressKey = (k) => k.indexOf(Store.CURSOR_PREFIX) === 0
                || k.indexOf(Store.SKIPPED_PREFIX) === 0
                || k.indexOf(Store.WISHLISTED_PREFIX) === 0
                || k.indexOf(Store.OWNED_PREFIX) === 0;
            if (keys.some(k => fullKeys.includes(k))) {
                readAll((current) => renderAll(current, !!changes[K.LANG]));
                return;
            }
            // The creators tab follows the mirror and the creator job.
            if (keys.some(k => Log.isLogKey(k) || k === Creators.MIRROR_KEY || k === Store.QUEUE_KEY
                || k === Store.CURSOR_PREFIX + Store.CREATOR_JOB_ID)) renderUndoSoon();
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
                // A page click hides the panel without reaching the dropdowns'
                // closer (it listens on this root), so one left open would
                // greet the next open. The open tab keeps its state; menus don't.
                root.querySelectorAll('.select-menu.open').forEach(m => m.classList.remove('open'));
                // The queue and the lists, too: a click elsewhere on the page shuts them.
                queue.shutNow();
                presets.foldNow();
                // The panel shut over an AI level moved with no tick: dropped too.
                aiTab.dropDraft();
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
        // The line and the halt hint are set as the window opens, and fold in
        // and out after that: the window grows and shrinks with them.
        let shown = false;
        const show = (el, on) => { if (shown) window.ILAP_Tabs.fold(el, on); else el.hidden = !on; };
        const renderProgress = () => {
            readQueueSnapshot([], (res) => {
                const jobs = Array.isArray(res[Store.QUEUE_KEY]) ? res[Store.QUEUE_KEY] : [];
                if (jobs.length === 0) { show(progress, false); shown = true; return; }
                let done = 0;
                let total = 0;
                for (const j of jobs) {
                    const size = j.total || (Array.isArray(j.appids) ? j.appids.length : 0);
                    const cur = res[Store.CURSOR_PREFIX + j.id];
                    total += size;
                    done += Math.min(Number.isFinite(cur) ? cur : (j.cursor || 0), size);
                }
                progressText.textContent = `${t('ignore_queue')}: ${done} / ${total}`;
                if (res[Store.SW_HALT_KEY]) haltHint.textContent = t('queue_sw_halt');
                show(haltHint, !!res[Store.SW_HALT_KEY]);
                show(progress, true);
                shown = true;
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
            document.documentElement.lang = window.ILAP.i18n.getLang();
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