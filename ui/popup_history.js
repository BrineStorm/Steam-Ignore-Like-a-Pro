// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The panel's Recent history: the box with the newest entry and the list
    // that drops down from it, each entry with its source glyph, and the store
    // page a click on one opens. Rendered by popup_main.js from the stats keys
    // (StatsLogic.HISTORY_KEY, LAST_KEY).

    const Sanitizer = window.ILAP.Sanitizer;
    const t = window.ILAP.t;
    // The widget's history tooltip (wire): how far over the panel's foot it
    // ends, and the least it shows, about two entries.
    const HISTORY_FOOT_MARGIN = 8;
    const HISTORY_MIN_H = 64;

    // A history entry's source as a glyph, in the hint card's colours: Manual
    // Ignore's two reasons as a stick fading in toward their default swipe
    // direction like the card's swoosh (red right, blue left, popup.css
    // .hist-stick), the two queue automators as the Undo button's turning
    // arrow, in the green of a job that is ignoring, fading in from its tail. An unknown or legacy source draws nothing and keeps its slot.
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
    const histGlyph = (icon) => () => `<span class="hist-glyph">${window.ILAP_Icons[icon]}</span>`;
    function undoLabel(entry) {
        const scope = entry.scope;
        if (!scope || !(Number(scope.n) > 0)) return t('history_unignore');
        const key = scope.unit === 'h' ? 'history_unignore_hours' : scope.unit === 'd' ? 'history_unignore_days' : 'history_unignore_last';
        return t(key, { n: Number(scope.n) });
    }
    // What an entry of each source draws. A finished job has its glyph from the
    // queue (a built-in list as the lists glyph, a curator as a square in its
    // filter's colour, an undo as the list with the green Undo arrow, a bundle as
    // its two capsules) and its `label` drawn in this language with its kind in
    // front, so it never reads as a game. A game has no `label` and shows its name.
    // Null-prototype, as the key is a stored `source`.
    const S = window.ILAP.StatsLogic.SOURCE;
    const SOURCES = Object.assign(Object.create(null), {
        [S.MI_DEFAULT]: { icon: () => histStick('is-ignore') },
        [S.MI_PLAYED]: { icon: () => histStick('is-played') },
        [S.DQ]: { icon: () => HIST_LOOP },
        [S.EQ]: { icon: () => HIST_LOOP },
        [S.PRESET]: {
            icon: histGlyph('LIST'),
            label: (e) => t('history_list', { name: window.ILAP_Presets.label(e.presetKey) }),
        },
        [S.BUNDLE]: {
            icon: histGlyph('BUNDLE'),
            label: (e) => t('history_bundle', { name: e.name }),
        },
        [S.CURATOR]: {
            icon: (e) => `<span class="hist-square" style="${window.ILAP_Filters.fillStyle(e.filter)}"></span>`,
            label: (e) => t('history_curator', { name: e.name }),
        },
        [S.UNDO]: { icon: histGlyph('UNIGNORE'), label: undoLabel },
        [S.CREATOR]: {
            icon: histGlyph('CREATOR'),
            label: (e) => t(e.unignore ? 'history_creator_unignore' : 'history_creator', { name: e.name }),
        },
    });

    function sourceIcon(entry) {
        const view = entry && SOURCES[entry.source];
        return view ? view.icon(entry) : '';
    }

    // An entry's text, unescaped.
    function historyLabel(entry) {
        const view = SOURCES[entry.source];
        return view && view.label ? view.label(entry) : String(entry.name || '');
    }

    // The same text as escaped HTML. A finished job's kind ("Ignore:",
    // "Curator:", "Un-ignore", up to the first colon in every language) is set
    // in grey before the rest. A game's name is left whole.
    function historyLabelHtml(entry) {
        const text = historyLabel(entry);
        const view = SOURCES[entry.source];
        if (!view || !view.label) return Sanitizer.escapeHTML(text);
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

    // The history list's last markup, per panel (the popup window, the widget).
    const historyHtml = new WeakMap();

    // The box and the list from the stats keys in `data`.
    function render(root, data) {
        const Stats = window.ILAP.StatsLogic;
        const lastName = data[Stats.LAST_KEY];
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
            // A link while it opens a page. Focusable either way: focus shows the history.
            if (boxed && Object.keys(historyLink(history[0])).length) lastRow.setAttribute('role', 'link');
            else lastRow.removeAttribute('role');
        }
        const lastSrc = root.getElementById('last-src');
        if (lastSrc) lastSrc.innerHTML = boxed ? sourceIcon(history[0]) : '';
        const listed = history.slice(boxed ? 1 : 0, boxed ? 4 : 3);
        // Nothing past the box: no list to drop down, and no chevron promising one.
        const trigger = root.querySelector('.history-trigger');
        if (trigger) trigger.classList.toggle('no-more', boxed && listed.length === 0);
        const historyDiv = root.getElementById('history-list');
        if (!historyDiv) return;
        let html;
        if (listed.length > 0) {
            // innerHTML needs sanitization. An entry that knows its game
            // or its curator opens that store page on a click (openHistoryEntry).
            html = listed.map(i => {
                const safeName = historyLabelHtml(i);
                const to = historyLink(i);
                const link = (to.appid ? ` data-appid="${to.appid}"` : to.curatorId ? ` data-curator-id="${to.curatorId}"`
                    : to.bundle ? ` data-bundle="${to.bundle}"` : '') + (Object.keys(to).length ? ' role="link" tabindex="0"' : '');
                return `<div class="history-entry"${link}><span class="hist-bullet" aria-hidden="true">•</span><span class="hist-name">${safeName}</span><span class="hist-src">${sourceIcon(i)}</span></div>`;
            }).join('');
        } else {
            const safeEmpty = Sanitizer.escapeHTML(t('no_recent_history'));
            html = `<div class="history-entry"><i>${safeEmpty}</i></div>`;
        }
        // Rebuilt only when it changed: a re-render of the same list keeps
        // the keyboard focus on its entry.
        if (historyHtml.get(historyDiv) !== html) {
            historyDiv.innerHTML = html;
            historyHtml.set(historyDiv, html);
        }
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

    // The box's and the list's listeners, once per panel.
    function wire(root) {
        const historyList = root.getElementById('history-list');
        // Enter on a focused entry opens it as a click does (they are links).
        const openOnEnter = (e) => { if (e.key === 'Enter') openHistoryEntry(e); };
        if (historyList) {
            historyList.addEventListener('click', openHistoryEntry);
            historyList.addEventListener('keydown', openOnEnter);
        }
        const lastRow = root.getElementById('last-ignored-row');
        if (lastRow) {
            lastRow.addEventListener('click', openHistoryEntry);
            lastRow.addEventListener('keydown', openOnEnter);
        }
        // Keyboard focus in the box or the list shows the history, as hover
        // does. A class set on focus rather than :has(:focus-visible), which
        // Chrome restyles too late: a quick Tab from the box found the entries
        // still hidden and skipped them.
        const trigger = root.querySelector('.history-trigger');
        if (trigger) {
            trigger.addEventListener('focusin', (e) => trigger.classList.toggle('kbd-open', e.target.matches(':focus-visible')));
            trigger.addEventListener('focusout', (e) => { if (!trigger.contains(e.relatedTarget)) trigger.classList.remove('kbd-open'); });
            // In the widget the panel is shorter than the toolbar window the
            // CSS caps are budgeted for, and a tooltip past its foot would put
            // a scrollbar on the panel. So the tooltip ends over the panel's
            // foot, and long entries scroll inside it.
            const tip = trigger.querySelector('.history-tooltip');
            const panel = root.getElementById('popup-root');
            const fit = () => {
                if (!tip || !panel || window.ILAP_Tabs.inWindow(trigger)) return;
                tip.style.maxHeight = '';
                const s = getComputedStyle(tip);
                const cap = parseFloat(s.maxHeight) || Infinity;
                // max-height is the content box's: the padding and the frame come on top.
                const box = s.boxSizing === 'border-box' ? 0 : ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
                    .reduce((sum, k) => sum + (parseFloat(s[k]) || 0), 0);
                // Its top, from the box it hangs under (it is out of the layout until it shows).
                const top = trigger.getBoundingClientRect().bottom + (parseFloat(s.marginTop) || 0);
                const room = panel.getBoundingClientRect().bottom - top - HISTORY_FOOT_MARGIN - box;
                tip.style.maxHeight = Math.floor(Math.max(HISTORY_MIN_H, Math.min(cap, room))) + 'px';
            };
            trigger.addEventListener('mouseenter', fit);
            trigger.addEventListener('focusin', fit);
        }
    }

    window.ILAP_History = { render, wire };

})();
