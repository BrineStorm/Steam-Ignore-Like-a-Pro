// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    const t = window.ILAP.t;

    const Settings = window.ILAP.Settings;
    const K = Settings.KEYS;

    // Shared HTML-escaper (src/escape.js, loaded first in popup.html + content_scripts).
    const esc = window.ILAP.Sanitizer.escapeHTML;

    // Surface helper (src/surface.js): ilap_surface_mode + Steam-client detection.
    const Surface = window.ILAP.Surface;

    // Shared exclusive-<details> wiring, reused by the top-level popup applets
    // (SETTINGS ↔ QUEUE, popup_main.js) and the settings subcategories (Discovery
    // Queue ↔ Manual Ignore). Takes over the native summary toggle so opening one
    // section collapses its sibling in the SAME synchronous frame — the native
    // `toggle` event fires a frame late, which would flash both open for one paint
    // (a jump to full height, then a snap). A SOLO collapse (nothing opening in its
    // place) is marked so it gets the smooth content-preserving animation; the
    // concurrent collapse triggered by opening the sibling stays unmarked so it
    // snaps shut together. `skipSelector` names an in-summary control that owns its
    // own click (the language chip / the DQ master switch) and must not toggle it.
    const wireExclusiveDetails = (section, sibling, skipSelector) => {
        if (!section) return;
        const summary = section.querySelector(':scope > summary');
        if (!summary) return;
        summary.addEventListener('click', (e) => {
            if (skipSelector && e.target.closest(skipSelector)) return;
            e.preventDefault();
            const willOpen = !section.open;
            section.classList.toggle('solo-collapse', !willOpen);
            if (willOpen && sibling) sibling.open = false;
            section.open = willOpen;
        });
    };

    // The swipe and circle glyphs (ui/icons.js), at the select rows' mini size.
    const Icons = window.ILAP_Icons;
    const miniSwoosh = (isRight, id) =>
        Icons.swoosh({ isRight, gradientId: id, cls: 'mini-arrow', width: 22, height: 11 });

    // The un-ignore gesture's miniature. It draws what the label says ("Right-Click
    // + Circle") — a left-right arrow would have contradicted it — and
    // counter-clockwise is the universal undo direction, which is exactly what the
    // gesture does.
    const miniCircle = (id) =>
        Icons.ring({ gradientId: id, cls: 'mini-arrow ring', size: 16 });

    // Visible label for a shortcut value: the gestures get a motion miniature —
    // swipe directions replace their text arrow with a mini swoosh, the un-ignore
    // gesture appends the loop — and the click bindings stay plain text. Second
    // field: true/false = swoosh pointing right/left, 'circle' = the loop glyph,
    // null = no miniature.
    // All three selects draw from this one table and offer the same bindings —
    // the two swipes, the circle, the three modifier-clicks. The value sets
    // therefore OVERLAP entirely, so the collision guard is what keeps them
    // apart: `syncSelectors` disables a value already taken by another select,
    // because the resolvers are first-match-wins and a clashing later binding
    // would silently never fire.
    const SHORTCUT_LABELS = {
        swipeRight: ['shortcut_swipe_right', true],
        swipeLeft:  ['shortcut_swipe_left', false],
        zigzag:   ['shortcut_zigzag', 'circle'],
        ctrlKey:  ['shortcut_ctrl_left', null],
        shiftKey: ['shortcut_shift_left', null],
        altKey:   ['shortcut_alt_left', null],
        off:      ['off', null]
    };

    // The un-ignore select's OFF is not a full off: a click on the IGNORED badge
    // — left or right — rolls a game back whatever this select says (both are
    // hard-wired in manual-ignore/main.js), so choosing it only drops the
    // rebindable gesture and leaves the badge. Hence the label: the same stored
    // value ('off'), spelling out what "off" still leaves you with instead of
    // promising a silence it doesn't deliver. Every other value renders
    // identically in all three selects.
    const UNIGNORE_LABELS = Object.assign({}, SHORTCUT_LABELS, {
        off: ['shortcut_off_badge_only', null]
    });

    // The <option> list of a shortcut select, in `values` order, labelled from the
    // same table the display draws from. data-i18n lets a language switch relabel
    // it like the rest of the panel.
    const shortcutOptions = (values, labels) => values.map((v) => {
        const key = (labels || SHORTCUT_LABELS)[v][0];
        return `<option value="${v}" data-i18n="${key}">${esc(t(key))}</option>`;
    }).join('');
    const { BINDINGS, OFF } = Settings;

    function shortcutDisplay(value, slot, labels) {
        const entry = (labels || SHORTCUT_LABELS)[value];
        if (!entry) return '';
        const text = t(entry[0]);
        if (entry[1] === null) return esc(text);
        // No trailing text arrow to swap out here: the localized circle label
        // ("Right-Click + Circle") never had one, so the glyph just follows it.
        if (entry[1] === 'circle') return `${esc(text)} ${miniCircle('zz-' + slot)}`;
        const stripped = text.replace(/\s*[→←➜]\s*$/, '');
        return `${esc(stripped)} ${miniSwoosh(entry[1], 'sw-' + slot)}`;
    }

    // The styled droplist drives the real <select> with a synthetic `change` of
    // its own, so a bare isTrusted check on the handlers would refuse the app's
    // own picks. What is let through is that one EVENT, not a window of time: a
    // flag open for the length of the dispatch let page script, from a capture
    // listener on the open shadow root, fire its own `change` at another select
    // inside that window. An event mid-dispatch cannot be dispatched again, so a
    // forged one is always another object. The value is checked as well, since
    // the same listener could rewrite the picked select before ours reads it.
    let selfPick = null;   // { ev, value }: the one dispatch in progress
    const isSelfPick = (e) => !!selfPick && e === selfPick.ev && e.target.value === selfPick.value;
    function dispatchPick(select, value) {
        const ev = new Event('change', { bubbles: true });
        selfPick = { ev, value };
        try { select.dispatchEvent(ev); } finally { selfPick = null; }
    }

    // Where a forged `change` can actually come from. The widget hosts this
    // panel in an OPEN shadow root on the Steam page, so page script can reach
    // these elements; the toolbar popup is a chrome-extension:// page that no
    // site can touch. Guarding only the reachable surface is what lets the
    // <select>s stay the handle Playwright drives (selectOption dispatches an
    // untrusted `change`) without leaving the exposed surface unguarded.
    const isPageReachable = (root) => !!(root && root.host);

    // Replace the OS-rendered <select> list with a styled menu, while keeping the
    // real <select> as the value store (and the element Playwright drives in tests).
    function enhanceSelect(shell, select, slot, root, labels) {
        if (!shell || !select) return;
        const closeAll = () => root.querySelectorAll('.select-menu.open').forEach(m => m.classList.remove('open'));
        const display = shell.querySelector('.select-display');
        const menu = document.createElement('div');
        menu.className = 'select-menu';
        shell.appendChild(menu);

        display.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasOpen = menu.classList.contains('open');
            closeAll();
            if (wasOpen) return;
            menu.innerHTML = Array.from(select.options).map((opt, i) => {
                const cls = (opt.value === select.value ? ' selected' : '') + (opt.disabled ? ' disabled' : '');
                return `<div class="select-opt${cls}" data-value="${esc(opt.value)}">${shortcutDisplay(opt.value, slot + '-' + i, labels)}</div>`;
            }).join('');
            menu.classList.add('open');
        });

        menu.addEventListener('click', (e) => {
            if (!e.isTrusted) return;   // a real pick; tests click this for real too
            e.stopPropagation();
            const item = e.target.closest('.select-opt');
            if (!item || item.classList.contains('disabled')) return;
            menu.classList.remove('open');
            const val = item.getAttribute('data-value');
            if (val !== select.value) {
                select.value = val;
                dispatchPick(select, val);
            }
        });
    }

    class SettingsManager {
        // deps.applyMasterInert: the panel-wide master-off rule, owned by popup_main.js.
        constructor(root, deps) {
            this.root = root;
            this.applyMasterInert = deps.applyMasterInert;
            this.container = root.getElementById('settings-placeholder');
            // Close any open custom dropdown when clicking elsewhere within this root.
            root.addEventListener('click', () => this.closeAllMenus());
        }

        closeAllMenus() {
            this.root.querySelectorAll('.select-menu.open').forEach(m => m.classList.remove('open'));
        }

        // Resolves once rendered (the widget waits on it before its first reveal).
        init() {
            return new Promise((resolve) => {
                chrome.storage.local.get(Object.values(K).concat(Surface.KEY), (data) => {
                    try {
                        this.render();
                        this.bindEvents(data);
                    } finally {
                        resolve();
                    }
                });
            });
        }

        /**
         * Called from popup_main.js when storage changes (e.g. language switch).
         * If settings panel was already rendered, rebuild it so all labels pick
         * up the new locale; otherwise no-op (init() will run on first open).
         */
        relabel(data) {
            if (!this.container || this.container.children.length === 0) return;
            this.render();
            this.bindEvents(data || {});
        }

        render() {
            if (!this.container) return;

            // Surface picker: on-page widget vs toolbar popup. Hidden inside the
            // Steam desktop client, where there is no toolbar to host a popup —
            // the widget is forced there and the stored key is left untouched.
            const surfaceRow = Surface.isSteamClientUA(navigator.userAgent) ? '' : `
                <div id="surface-row" data-master-exempt>
                    <label class="wide-switch">
                        <input type="checkbox" id="surface-toggle">
                        <div class="wide-track">
                            <span class="wide-bg"></span>
                            <span class="wide-label" data-i18n="surface_widget">On page</span>
                            <span class="wide-label" data-i18n="surface_popup">Toolbar</span>
                        </div>
                    </label>
                </div>`;

            this.container.innerHTML = `
                ${surfaceRow}
                <details id="dq-section" class="settings-subcat">
                    <summary>
                        <div class="section-title" id="dq-section-title" data-i18n="your_discovery_queue">Classic Discovery Queue</div>
                        <!-- Own drawn tip, not a native title (in the widget the page
                             draws that, outside the panel). With no title, the switch
                             takes its accessible name from the heading and its
                             description from the tip (aria-labelledby / aria-describedby). -->
                        <label class="switch">
                            <input type="checkbox" id="q-master"
                                   aria-labelledby="dq-section-title" aria-describedby="dq-master-tip">
                            <span class="slider"></span>
                        </label>
                        <span class="dq-master-tip" id="dq-master-tip" role="tooltip" data-i18n="tooltip_dq_master">Master toggle for Classic Discovery Queue automation.</span>
                    </summary>
                    <div class="subcat-content">
                        <div id="q-sub-settings">
                            <!-- Our own drawn tooltip instead of the native title (see
                                 popup.css): the browser bubble is unstyleable, and in the
                                 on-page widget the PAGE draws it, outside our panel. Hover
                                 is on the whole row, exactly as the title was. -->
                            <div class="stat-row dq-next-row">
                                <span data-i18n="click_next_after_ignore">Auto-advance after ignore</span>
                                <label class="switch">
                                    <input type="checkbox" id="q-next">
                                    <span class="slider"></span>
                                </label>
                                <span class="dq-next-tip" role="tooltip" data-i18n="tooltip_dq_next">Enable automatic transition ONLY when a game is successfully ignored.</span>
                            </div>

                            <div style="margin-top: 8px;">
                                <span style="font-size: 12px; display: block; margin-bottom: 4px;" data-i18n="ignore_mode">Ignore Mode:</span>
                                <label class="wide-switch">
                                    <input type="checkbox" id="q-mode-toggle">
                                    <div class="wide-track">
                                        <span class="wide-bg"></span>
                                        <span class="wide-label" data-i18n="mode_bad_reviews">Bad Reviews</span>
                                        <span class="wide-label" data-i18n="mode_every_game">Every Game</span>
                                    </div>
                                </label>
                            </div>
                        </div>
                    </div>
                </details>

                <details id="mi-section" class="settings-subcat">
                    <summary>
                        <div class="section-title" data-i18n="section_manual_ignore">Manual Ignore</div>
                    </summary>
                    <div class="subcat-content">
                        <div class="stat-row">
                            <span data-i18n="blur_ignored_covers">Blur ignored covers</span>
                            <label class="switch">
                                <input type="checkbox" id="mask-toggle">
                                <span class="slider"></span>
                            </label>
                        </div>

                        <div class="stat-row">
                            <span style="flex: 1;" data-i18n="default_ignore">Default Ignore:</span>
                            <div class="select-shell">
                                <span class="select-display" id="default-key-display"></span>
                                <select id="default-key">${shortcutOptions(BINDINGS)}</select>
                            </div>
                        </div>

                        <div class="stat-row">
                            <span id="p-label" style="flex: 1;" data-i18n="already_played">Already Played:</span>
                            <div class="select-shell">
                                <span class="select-display" id="platform-key-display"></span>
                                <select id="platform-key">${shortcutOptions([OFF].concat(BINDINGS))}</select>
                            </div>
                        </div>

                        <!-- The select names only the circle, in every locale: it is the
                             gesture people will draw, and a two-name label in a 320px row
                             reads like two settings. The detector measures the X axis alone
                             (ZigzagTracker), so a flat left-right zigzag is the same motion
                             to it — genuinely useful on capsules too short to circle over.
                             The glyph beside the label names NO rotation direction, and the
                             row carries no hover hint at all: the detector sees X only, so
                             a circle's rotation is invisible to it and both directions fire
                             (asserted in zigzag.unit.spec.js), while the glyph has to be
                             drawn SOME way round — counter-clockwise, for the undo
                             convention. Silence lets the reader copy the glyph and be
                             right, with the other direction working anyway. -->
                        <div class="stat-row">
                            <span style="flex: 1;" data-i18n="solo_unignore">Un-ignore:</span>
                            <div class="select-shell">
                                <span class="select-display" id="unignore-key-display"></span>
                                <!-- The circle first (it is this binding's default), and 'off' last
                                     under its own label: the badge click is hard-wired, so it is
                                     never a full off (UNIGNORE_LABELS). -->
                                <select id="unignore-key">${shortcutOptions([Settings.DEFAULTS.UNIGNORE].concat(BINDINGS.filter(b => b !== Settings.DEFAULTS.UNIGNORE), OFF), UNIGNORE_LABELS)}</select>
                            </div>
                        </div>
                    </div>
                </details>
            `;

            if (window.ILAP && window.ILAP.i18n) window.ILAP.i18n.applyDom(this.container);
        }

        bindEvents(data) {
            const els = this.els = {
                qMaster: this.root.getElementById('q-master'),
                qNext: this.root.getElementById('q-next'),
                qMode: this.root.getElementById('q-mode-toggle'),
                qSub: this.root.getElementById('q-sub-settings'),
                dSel: this.root.getElementById('default-key'),
                pSel: this.root.getElementById('platform-key'),
                uSel: this.root.getElementById('unignore-key'),
                pLabel: this.root.getElementById('p-label'),
                mask: this.root.getElementById('mask-toggle'),
                surface: this.root.getElementById('surface-toggle'), // absent in the Steam client
                dqSection: this.root.getElementById('dq-section'),
                miSection: this.root.getElementById('mi-section')
            };

            this._applyValues(data);
            this._bindSubcategories(data);

            enhanceSelect(els.dSel.closest('.select-shell'), els.dSel, 'def', this.root);
            enhanceSelect(els.pSel.closest('.select-shell'), els.pSel, 'plat', this.root);
            enhanceSelect(els.uSel.closest('.select-shell'), els.uSel, 'unig', this.root, UNIGNORE_LABELS);

            // Every control below writes a setting, so each one takes real user
            // input only — page script on Steam can reach this panel through the
            // widget's open shadow root and forge a `change` otherwise.
            // Checkboxes take a plain isTrusted: nothing in this extension ever
            // dispatches `change` at one, so the guard costs nothing anywhere.
            // The selects go through userDriven, which also accepts the styled
            // droplist's own dispatch, and stands down entirely on the toolbar
            // popup — see isPageReachable.
            const userDriven = (e) => e.isTrusted || isSelfPick(e) || !isPageReachable(this.root);
            els.qMaster.addEventListener('change', (e) => {
                if (!e.isTrusted) return;
                chrome.storage.local.set({ [K.Q_MASTER]: els.qMaster.checked });
                this._updateVisuals();
            });
            els.qNext.addEventListener('change', (e) => {
                if (!e.isTrusted) return;
                chrome.storage.local.set({ [K.Q_NEXT]: els.qNext.checked });
            });
            els.mask.addEventListener('change', (e) => {
                if (!e.isTrusted) return;
                chrome.storage.local.set({ [K.MASK]: els.mask.checked });
            });

            if (els.surface) {
                // Free in both directions: the queue drains without the on-page surface.
                els.surface.addEventListener('change', (e) => {
                    if (!e.isTrusted) return;
                    chrome.storage.local.set({
                        [Surface.KEY]: els.surface.checked ? 'popup' : 'widget'
                    });
                });
            }

            els.qMode.addEventListener('change', (e) => {
                if (!e.isTrusted) return;
                const val = els.qMode.checked ? Settings.Q_MODES.ALL : Settings.Q_MODES.BAD;
                chrome.storage.local.set({ [K.Q_MODE]: val });
            });

            els.dSel.addEventListener('change', (e) => {
                if (!userDriven(e)) return;
                chrome.storage.local.set({ [K.SHORTCUT]: e.target.value });
                this._updateVisuals();
            });
            els.pSel.addEventListener('change', (e) => {
                if (!userDriven(e)) return;
                chrome.storage.local.set({ [K.PLATFORM]: e.target.value });
                this._updateVisuals();
            });
            els.uSel.addEventListener('change', (e) => {
                if (!userDriven(e)) return;
                chrome.storage.local.set({ [K.UNIGNORE]: e.target.value });
                this._updateVisuals();
            });
        }

        /**
         * The two feature areas are mutually-exclusive collapsible subcategories:
         * opening one collapses the other (same rule as the SETTINGS/QUEUE
         * applets). Each remembers its own open/closed state so reopening the
         * panel restores exactly what the user last had expanded (e.g. Manual
         * Ignore open, Discovery Queue closed). The open state is restored BEFORE
         * the toggle listeners are attached, so the initial programmatic set never
         * writes back.
         */
        _bindSubcategories(data) {
            const els = this.els;
            const dqOpen = !!data[K.DQ_OPEN];
            els.dqSection.open = dqOpen;
            els.miSection.open = !!data[K.MI_OPEN] && !dqOpen; // enforce exclusivity on restore

            // Persist each section's open state. Mutual exclusion is handled in the
            // click interceptor below — NOT here — because the native `toggle` event
            // is dispatched asynchronously: collapsing the sibling from it leaves
            // both sections open for one paint (the panel jumps to full height, then
            // the sibling snaps shut — the flicker the user reported).
            els.dqSection.addEventListener('toggle', () =>
                chrome.storage.local.set({ [K.DQ_OPEN]: els.dqSection.open }));
            els.miSection.addEventListener('toggle', () =>
                chrome.storage.local.set({ [K.MI_OPEN]: els.miSection.open }));

            // Drive open/close ourselves so opening one and collapsing the other
            // happen in the SAME synchronous frame (no flash) and their height
            // transitions run together. The DQ master switch lives inside its
            // summary, so it's the skip-selector here.
            wireExclusiveDetails(els.dqSection, els.miSection, '.switch');
            wireExclusiveDetails(els.miSection, els.dqSection, '.switch');

            // The DQ master switch lives inside the subcategory <summary>; keep a
            // click on it from also toggling the subcategory open/closed.
            const dqSwitch = els.qMaster.closest('.switch');
            if (dqSwitch) dqSwitch.addEventListener('click', (e) => e.stopPropagation());
        }

        _applyValues(data) {
            const els = this.els;
            if (!els) return;
            // Here rather than in popup_main because these rows are rebuilt by render().
            this.applyMasterInert(this.container, !Settings.isOn(data[K.MASTER]));
            els.qMaster.checked = Settings.isOn(data[K.Q_MASTER]);
            els.qNext.checked = !!data[K.Q_NEXT];
            els.qMode.checked = (data[K.Q_MODE] === Settings.Q_MODES.ALL);
            els.mask.checked = Settings.isOn(data[K.MASK]);
            els.dSel.value = Settings.normalizeShortcut(data[K.SHORTCUT]) || Settings.DEFAULTS.SHORTCUT;
            els.pSel.value = Settings.normalizeShortcut(data[K.PLATFORM]) || Settings.DEFAULTS.PLATFORM;
            // A value the page would not accept shows the default, as the page uses it.
            els.uSel.value = Settings.normalizeUnignore(data[K.UNIGNORE]) || Settings.DEFAULTS.UNIGNORE;
            if (els.surface) {
                els.surface.checked = (data[Surface.KEY] === 'popup');
            }
            this._updateVisuals();
        }

        _updateVisuals() {
            const els = this.els;
            if (!els) return;
            els.qSub.classList.toggle('dimmed', !els.qMaster.checked);
            els.pLabel.classList.toggle('dimmed', els.pSel.value === OFF);
            // All three selects share one vocabulary: a value taken by one is
            // disabled in the others.
            this.syncSelectors(els.dSel, els.pSel, els.uSel);
            const dDisp = this.root.getElementById('default-key-display');
            const pDisp = this.root.getElementById('platform-key-display');
            const uDisp = this.root.getElementById('unignore-key-display');
            if (dDisp) dDisp.innerHTML = shortcutDisplay(els.dSel.value, 'def');
            if (pDisp) pDisp.innerHTML = shortcutDisplay(els.pSel.value, 'plat');
            if (uDisp) uDisp.innerHTML = shortcutDisplay(els.uSel.value, 'unig', UNIGNORE_LABELS);
        }

        /**
         * Reflect external storage changes (e.g. the Explore-Queue "Disable" button
         * writes ilap_q_master=false) onto the already-rendered controls. Value-only,
         * so it never re-creates the DOM and never kills the segmented-toggle CSS
         * transition. No-op when the settings panel isn't rendered yet.
         */
        syncValues(data) {
            if (!this.container || this.container.children.length === 0) return;
            this._applyValues(data);
        }

        /**
         * One binding, one action: a value chosen in any select is disabled in
         * every other one. 'off' is the shared "no binding" sentinel — several
         * selects may sit on it at once, so it is never taken and never disabled.
         */
        syncSelectors(...selects) {
            selects.forEach(sel => {
                const taken = new Set(selects
                    .filter(other => other !== sel && other.value !== 'off')
                    .map(other => other.value));
                Array.from(sel.options).forEach(opt => {
                    opt.disabled = opt.value !== 'off' && taken.has(opt.value);
                });
            });
        }
    }

    window.ILAP_Settings = { create: (root, deps) => new SettingsManager(root, deps), wireExclusiveDetails };

})();
