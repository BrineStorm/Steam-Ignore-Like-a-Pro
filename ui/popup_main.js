// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Shared HTML-escaper (src/escape.js, loaded first in popup.html + content_scripts).
    const Sanitizer = window.ILAP.Sanitizer;
    const Settings = window.ILAP.Settings;
    const K = Settings.KEYS;

    const t = window.ILAP.t;

    // The language droplist drives the real <select> with its own synthetic
    // `change`, like the settings droplists: one guard for both, in
    // ui/popup_settings.js (the reasoning is there).
    const { dispatchPick, isSelfPick, isPageReachable } = window.ILAP_Settings;

    // How long an open queue takes to fold away before SETTINGS opens in its
    // place. Matches #queue-accordion.solo-collapse.handoff in popup.css.
    const QUEUE_HANDOFF_MS = 280;

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
    // es-419 is the one exception: ES is already Spain's chip.
    const langCode = (lang) => lang === 'es-419' ? 'LA'
        : String(lang || 'en').split('-')[0].toUpperCase();

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

    // A history entry's source as a glyph, in the hint card's colours: Manual
    // Ignore's two reasons as a stick fading in toward their default swipe
    // direction like the card's swoosh (red right, blue left, popup.css
    // .hist-stick), the two queue automators as the Undo button's turning
    // arrow, in the lime of a job that is ignoring, fading in from its tail. An unknown or legacy source draws nothing and keeps its slot.
    const histStick = (cls) => `<span class="hist-stick ${cls}" aria-hidden="true"></span>`;
    // Drawn as the arc in six 45° pieces, each more opaque than the last: a
    // linear gradient cannot follow a ring, it would fade one side backwards.
    // The ring runs counter-clockwise from 9 o'clock to 12, where the head sits.
    const HIST_LOOP = (() => {
        const pt = (deg) => {
            const r = deg * Math.PI / 180;
            return `${(12 + 7 * Math.cos(r)).toFixed(2)} ${(14 + 7 * Math.sin(r)).toFixed(2)}`;
        };
        let arcs = '';
        for (let i = 0; i < 6; i++) {
            const from = 180 - 45 * i;
            arcs += `<path d="M${pt(from)} A7 7 0 0 0 ${pt(from - 45)}" fill="none" stroke="#48ff00" stroke-width="2.2" opacity="${(0.15 + 0.17 * i).toFixed(2)}"/>`;
        }
        return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' + arcs
            + '<path d="M12.6 2.2 6.4 7l6.2 4.8z" fill="#48ff00"/></svg>';
    })();
    // A finished job's entry has its glyph from the queue: a built-in list as
    // the lists glyph, a curator as a square in its filter's colour, an undo as
    // the list with the green Undo arrow, a bundle as its two capsules.
    function sourceIcon(entry) {
        const S = window.ILAP.StatsLogic.SOURCE;
        const source = entry && entry.source;
        if (source === S.MI_DEFAULT) return histStick('is-ignore');
        if (source === S.MI_PLAYED) return histStick('is-played');
        if (source === S.DQ || source === S.EQ) return HIST_LOOP;
        if (source === S.PRESET) return `<span class="hist-glyph">${window.ILAP_Icons.LIST}</span>`;
        if (source === S.BUNDLE) return `<span class="hist-glyph">${window.ILAP_Icons.BUNDLE}</span>`;
        if (source === S.CURATOR) return `<span class="hist-square" style="${window.ILAP_Filters.fillStyle(entry.filter)}"></span>`;
        if (source === S.UNDO) return `<span class="hist-glyph">${window.ILAP_Icons.UNIGNORE}</span>`;
        return '';
    }

    // An entry's text, unescaped. A game shows its name; a finished job is
    // drawn in this language with its kind in front, so it never reads as a game.
    function historyLabel(entry) {
        const S = window.ILAP.StatsLogic.SOURCE;
        if (entry.source === S.PRESET) return t('history_list', { name: window.ILAP_Presets.label(entry.presetKey) });
        if (entry.source === S.CURATOR) return t('history_curator', { name: entry.name });
        if (entry.source === S.BUNDLE) return t('history_bundle', { name: entry.name });
        if (entry.source === S.UNDO) {
            const scope = entry.scope;
            if (!scope || !(Number(scope.n) > 0)) return t('history_unignore');
            const key = scope.unit === 'h' ? 'history_unignore_hours' : scope.unit === 'd' ? 'history_unignore_days' : 'history_unignore_last';
            return t(key, { n: Number(scope.n) });
        }
        return String(entry.name || '');
    }

    // The same text as escaped HTML. A finished job's kind ("Ignore:",
    // "Curator:", "Un-ignore", up to the first colon in every language) is set
    // in grey before the rest. A game's name is left whole.
    function historyLabelHtml(entry) {
        const S = window.ILAP.StatsLogic.SOURCE;
        const text = historyLabel(entry);
        if (![S.PRESET, S.CURATOR, S.BUNDLE, S.UNDO].includes(entry.source)) return Sanitizer.escapeHTML(text);
        const m = text.match(/^[^:：]*[:：]/);
        const kind = m ? m[0] : text;
        return `<span class="hist-kind">${Sanitizer.escapeHTML(kind)}</span>${Sanitizer.escapeHTML(text.slice(kind.length))}`;
    }

    // The link an entry opens, as data attributes: its game, else its curator,
    // else its bundle. Numeric ids only, since the URL is built from them
    // (openHistoryEntry).
    const BUNDLE_PATH = /^(bundle|sub)\/\d+$/;
    function historyLink(entry) {
        if (/^\d+$/.test(String(entry.appid))) return { appid: String(entry.appid) };
        if (/^\d+$/.test(String(entry.curatorId))) return { curatorId: String(entry.curatorId) };
        if (BUNDLE_PATH.test(String(entry.bundle))) return { bundle: String(entry.bundle) };
        return {};
    }

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
        // The circle can carry an ignore now, so the hint has to be able to draw
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
        renderTotal(root, data);
        const lastName = data[Stats.LAST_KEY];

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
                <div class="hint-line">
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
        // The closed box shows the newest entry, with its icon, while that
        // entry is the name it shows. The list then goes on from the next one,
        // so the box and the list show four different games.
        const boxed = !!history[0] && history[0].name === lastName;
        root.getElementById('last-game').innerHTML = boxed ? historyLabelHtml(history[0]) : Sanitizer.escapeHTML(lastName || t('none'));
        // The box opens its entry's page too, like the list's entries.
        const lastRow = root.getElementById('last-ignored-row');
        if (lastRow) {
            delete lastRow.dataset.appid;
            delete lastRow.dataset.curatorId;
            delete lastRow.dataset.bundle;
            Object.assign(lastRow.dataset, boxed ? historyLink(history[0]) : {});
        }
        const lastSrc = root.getElementById('last-src');
        if (lastSrc) lastSrc.innerHTML = boxed ? sourceIcon(history[0]) : '';
        const listed = history.slice(boxed ? 1 : 0, boxed ? 4 : 3);
        // Nothing past the box: no list to drop down, and no chevron promising one.
        const trigger = root.querySelector('.history-trigger');
        if (trigger) trigger.classList.toggle('no-more', boxed && listed.length === 0);
        const historyDiv = root.getElementById('history-list');
        if (historyDiv) {
            if (listed.length > 0) {
                // innerHTML needs sanitization. An entry that knows its game
                // or its curator opens that store page on a click (openHistoryEntry).
                historyDiv.innerHTML = listed.map(i => {
                    const safeName = historyLabelHtml(i);
                    const to = historyLink(i);
                    const link = to.appid ? ` data-appid="${to.appid}"` : to.curatorId ? ` data-curator-id="${to.curatorId}"`
                        : to.bundle ? ` data-bundle="${to.bundle}"` : '';
                    return `<div class="history-entry"${link}><span class="hist-bullet" aria-hidden="true">•</span><span class="hist-name">${safeName}</span><span class="hist-src">${sourceIcon(i)}</span></div>`;
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
                const label = l.beta ? `${l.name}` : l.name;
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
                    Lease.LOCK_PREFIX + j.curatorId);
            }
            if (jobKeys.length === 0) { cb(res); return; }
            chrome.storage.local.get(jobKeys, (more) => cb(Object.assign(res, more)));
        });
    }

    // A click on a history entry, or on the box above the list, opens its
    // game's (or its curator's) store page in a new tab. The URL is built from
    // the entry's numeric id, and only a real click counts: in the widget this
    // list sits in an open shadow root on a Steam page (the same rule as the
    // queue's curator square, popup_queue.js).
    function openHistoryEntry(e) {
        if (!e.isTrusted) return;
        const entry = e.target.closest('.history-entry, #last-ignored-row');
        if (!entry) return;
        const { appid, curatorId, bundle } = entry.dataset;
        const url = /^\d+$/.test(appid || '') ? 'https://store.steampowered.com/app/' + appid + '/'
            : /^\d+$/.test(curatorId || '') ? 'https://store.steampowered.com/curator/' + curatorId + '/'
            : BUNDLE_PATH.test(bundle || '') ? 'https://store.steampowered.com/' + bundle + '/' : null;
        if (url) window.open(url, '_blank', 'noopener');
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
        // Add in the lists menu flies the list into the queue's job count, which
        // holds its old number until it lands.
        const presets = window.ILAP_Presets.create(root, { holdCount: () => queue.holdCount() });
        const Log = window.ILAP.IgnoreLog;
        const Store = window.ILAP.Curator.Store;
        const Lease = window.ILAP.Curator.Lease;
        const Stats = window.ILAP.StatsLogic;
        const undoService = new window.ILAP.UndoService({ store: Store, log: Log, maxJobs: Store.MAX_JOBS });
        const undo = window.ILAP_Undo.create(root, undoService);
        const renderUndo = () => Log.getLog().then((log) => undo.render(log));
        const historyList = root.getElementById('history-list');
        if (historyList) historyList.addEventListener('click', openHistoryEntry);
        const lastRow = root.getElementById('last-ignored-row');
        if (lastRow) lastRow.addEventListener('click', openHistoryEntry);
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
            // sits in the SETTINGS summary and owns its own click, the lists icon
            // the same in the queue's.
            const wireExclusive = window.ILAP_Settings.wireExclusiveDetails;
            // SETTINGS opens only once an open queue has folded away (the
            // .handoff duration in popup.css).
            wireExclusive(accordion, queueAcc, '.lang-chip', QUEUE_HANDOFF_MS);
            wireExclusive(queueAcc, accordion, '.lang-chip, .preset-chip');

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
            // Apart from those, the queue and the lists' done marks redraw an open
            // lists menu.
            const keys = Object.keys(changes || {});
            if (keys.some(k => k === Store.QUEUE_KEY || k.indexOf(Store.PRESET_DONE_PREFIX) === 0)) {
                presets.refresh();
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
                || k.indexOf(Lease.LOCK_PREFIX) === 0;
            const isProgressKey = (k) => k.indexOf(Store.CURSOR_PREFIX) === 0
                || k.indexOf(Store.SKIPPED_PREFIX) === 0
                || k.indexOf(Store.WISHLISTED_PREFIX) === 0;
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
                // A page click hides the panel without reaching the dropdowns'
                // closer (it listens on this root), so one left open would
                // greet the next open. Accordions keep their state; menus don't.
                root.querySelectorAll('.select-menu.open').forEach(m => m.classList.remove('open'));
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