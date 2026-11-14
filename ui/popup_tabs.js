// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The tab line under the gesture card and the panel that drops down under
    // it: the AI filters, the language and the settings. One tab is open at a time,
    // or none: a click on the open tab folds the panel away. Nothing in the
    // panel appears or goes in one frame. Opening grows the panel from nothing,
    // closing shrinks it to nothing with its content still drawn, a switch
    // fades the old pane out before the new one fades in while the height
    // follows. Web Animations rather than CSS, so Firefox, which cannot animate
    // to `auto`, gets the same motion. The panel clips while it moves, so no
    // scrollbar shows. The lists button in the line's left corner has its own
    // controller (ui/popup_presets.js) and shares only the tooltip. The two
    // drawers (the queue, the lists) slide with slideDrawer below.

    const t = window.ILAP.t;

    // The open tab, '' for none. Per panel, so it is kept out of Settings.KEYS:
    // a write there would re-render every open view.
    const TAB_KEY = 'ilap_popup_tab';
    const RESIZE_MS = 260;
    const FADE_MS = 120;
    // A drawer's slide.
    const SLIDE_MS = 260;
    // A line folding in or out (fold).
    const FOLD_MS = 200;

    const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // The open tab, kept for the next panel. In a widget left on a page by an
    // extension update the call throws, as storage is gone there: the panel
    // still switches and nothing is kept.
    function remember(name) {
        try {
            chrome.storage.local.set({ [TAB_KEY]: name || '' }, () => void chrome.runtime.lastError);
        } catch (e) { /* no storage left in this tab */ }
    }

    // "SETTINGS" reads as "Settings" in a tooltip. Only an all-caps string is
    // touched, so a script without case (CJK, Thai) stays as it is.
    function sentenceCase(s, lang) {
        const up = s.toLocaleUpperCase(lang);
        if (s !== up || s === s.toLocaleLowerCase(lang)) return s;
        return s.charAt(0) + s.slice(1).toLocaleLowerCase(lang);
    }

    // The language tab's code: the primary subtag only (pt-BR -> PT, zh-TW ->
    // ZH). es-419 is the one exception, as ES is already Spain's.
    const langCode = (lang) => lang === 'es-419' ? 'LA'
        : String(lang || 'en').split('-')[0].toUpperCase();

    // The code drawn in the AI tab's letters: Oswald 700 outlines at their
    // size, 11 units tall on a baseline at 16.5 in a 22-unit box, A and I
    // 1.2 apart past their advance, as in the AI mark. Exported from the font's
    // outlines: d at pen origin 0, a the advance, l and r the ink's edges.
    const LANG_GLYPHS = {
        A: { a: 7.48, l: 0.29, r: 7.18, d: 'M0.29 16.5 2.36 5.5H5.13L7.18 16.5H4.94L4.58 14.18H2.96L2.58 16.5ZM3.18 12.72H4.35L3.76 8.43Z' },
        B: { a: 7.99, l: 0.81, r: 7.52, d: 'M0.81 16.5V5.5H3.68Q4.39 5.5 5.02 5.61Q5.65 5.72 6.14 6.02Q6.63 6.33 6.91 6.89Q7.18 7.46 7.18 8.38Q7.18 9.04 6.99 9.5Q6.79 9.95 6.43 10.23Q6.07 10.5 5.57 10.59Q6.21 10.67 6.64 11.01Q7.08 11.34 7.3 11.9Q7.52 12.45 7.52 13.24Q7.52 14.1 7.3 14.71Q7.08 15.33 6.65 15.73Q6.23 16.12 5.62 16.31Q5 16.5 4.2 16.5ZM3.25 14.8H3.76Q4.56 14.8 4.87 14.4Q5.17 13.99 5.17 13.2Q5.17 12.58 5.04 12.21Q4.9 11.84 4.59 11.67Q4.28 11.5 3.75 11.5H3.25ZM3.25 9.9H3.72Q4.28 9.9 4.56 9.73Q4.85 9.56 4.95 9.23Q5.05 8.91 5.05 8.45Q5.05 8.01 4.9 7.72Q4.74 7.43 4.43 7.28Q4.13 7.13 3.67 7.13H3.25Z' },
        C: { a: 7.65, l: 0.67, r: 7.13, d: 'M3.97 16.66Q2.72 16.66 1.99 16.21Q1.26 15.75 0.96 14.93Q0.67 14.11 0.67 13V9.03Q0.67 7.89 0.96 7.07Q1.26 6.25 1.99 5.8Q2.72 5.35 3.97 5.35Q5.19 5.35 5.87 5.75Q6.56 6.15 6.84 6.87Q7.13 7.59 7.13 8.53V9.48H4.75V8.38Q4.75 8.05 4.72 7.75Q4.69 7.46 4.52 7.26Q4.36 7.06 3.97 7.06Q3.59 7.06 3.4 7.27Q3.22 7.47 3.17 7.77Q3.12 8.08 3.12 8.42V13.59Q3.12 13.96 3.18 14.27Q3.25 14.57 3.43 14.75Q3.61 14.94 3.97 14.94Q4.35 14.94 4.51 14.74Q4.67 14.54 4.71 14.23Q4.75 13.92 4.75 13.59V12.44H7.13V13.39Q7.13 14.33 6.85 15.07Q6.57 15.81 5.89 16.24Q5.2 16.66 3.97 16.66Z' },
        D: { a: 7.96, l: 0.81, r: 7.29, d: 'M0.81 16.5V5.5H3.6Q5.04 5.5 5.84 5.86Q6.64 6.22 6.97 6.99Q7.29 7.75 7.29 8.98V12.97Q7.29 14.2 6.97 14.99Q6.64 15.77 5.85 16.13Q5.05 16.5 3.63 16.5ZM3.25 14.82H3.63Q4.18 14.82 4.43 14.65Q4.67 14.49 4.73 14.16Q4.79 13.84 4.79 13.35V8.56Q4.79 8.07 4.72 7.77Q4.64 7.47 4.4 7.33Q4.16 7.2 3.61 7.2H3.25Z' },
        E: { a: 6.07, l: 0.81, r: 5.79, d: 'M0.81 16.5V5.5H5.76V7.16H3.25V9.89H5.16V11.57H3.25V14.86H5.79V16.5Z' },
        F: { a: 5.89, l: 0.81, r: 5.57, d: 'M0.81 16.5V5.5H5.57V7.14H3.25V9.91H5.27V11.61H3.25V16.5Z' },
        G: { a: 7.9, l: 0.67, r: 7.2, d: 'M3.68 16.66Q2.54 16.66 1.88 16.19Q1.22 15.71 0.94 14.85Q0.67 13.99 0.67 12.86V9.17Q0.67 8 0.96 7.14Q1.26 6.29 1.99 5.82Q2.72 5.35 3.97 5.35Q5.19 5.35 5.89 5.76Q6.59 6.17 6.89 6.89Q7.18 7.6 7.18 8.57V9.28H4.81V8.38Q4.81 8.03 4.76 7.73Q4.71 7.43 4.54 7.25Q4.37 7.06 3.99 7.06Q3.6 7.06 3.42 7.27Q3.25 7.48 3.2 7.8Q3.15 8.11 3.15 8.45V13.54Q3.15 13.91 3.23 14.23Q3.3 14.54 3.5 14.74Q3.69 14.94 4.06 14.94Q4.44 14.94 4.64 14.73Q4.85 14.53 4.93 14.2Q5.01 13.88 5.01 13.51V12.22H4.02V10.8H7.2V16.5H5.6L5.46 15.59Q5.24 16.05 4.82 16.36Q4.4 16.66 3.68 16.66Z' },
        H: { a: 8.28, l: 0.86, r: 7.43, d: 'M0.86 16.5V5.5H3.29V9.95H5V5.5H7.43V16.5H5V11.69H3.29V16.5Z' },
        I: { a: 4.09, l: 0.83, r: 3.26, d: 'M0.83 16.5V5.5H3.26V16.5Z' },
        J: { a: 4.74, l: 0.18, r: 3.92, d: 'M0.18 16.79V15.09Q0.54 15.09 0.8 15.05Q1.06 15.01 1.21 14.89Q1.36 14.78 1.43 14.55Q1.49 14.33 1.49 13.97V5.5H3.92V14.08Q3.92 14.98 3.7 15.58Q3.48 16.19 2.92 16.49Q2.36 16.79 1.36 16.79Z' },
        K: { a: 7.7, l: 0.81, r: 7.56, d: 'M0.81 16.5V5.5H3.25V10L5.09 5.5H7.47L5.43 10.47L7.56 16.5H5.09L3.5 11.64L3.25 12.07V16.5Z' },
        L: { a: 6.02, l: 0.81, r: 5.77, d: 'M0.81 16.5V5.5H3.25V14.86H5.77V16.5Z' },
        M: { a: 9.56, l: 0.77, r: 8.79, d: 'M0.77 16.5 0.96 5.5H3.57L4.78 11.9L6.08 5.5H8.6L8.79 16.5H7.06L6.86 9.18L5.58 16.5H4.05L2.69 9.13L2.53 16.5Z' },
        N: { a: 7.62, l: 0.81, r: 6.79, d: 'M0.81 16.5V5.5H2.53L4.78 10.8V5.5H6.79V16.5H5.15L2.89 10.8V16.5Z' },
        O: { a: 7.96, l: 0.67, r: 7.29, d: 'M3.97 16.66Q2.73 16.66 2.01 16.23Q1.29 15.79 0.98 14.98Q0.67 14.16 0.67 13.04V8.95Q0.67 7.81 0.98 7.01Q1.29 6.21 2.01 5.78Q2.73 5.35 3.97 5.35Q5.21 5.35 5.94 5.78Q6.67 6.21 6.98 7.01Q7.29 7.81 7.29 8.95V13.04Q7.29 14.16 6.98 14.98Q6.67 15.79 5.94 16.23Q5.21 16.66 3.97 16.66ZM3.97 14.94Q4.35 14.94 4.52 14.75Q4.7 14.56 4.75 14.26Q4.81 13.96 4.81 13.65V8.35Q4.81 8.03 4.75 7.73Q4.7 7.44 4.52 7.25Q4.35 7.06 3.97 7.06Q3.61 7.06 3.44 7.25Q3.26 7.44 3.2 7.73Q3.15 8.03 3.15 8.35V13.65Q3.15 13.96 3.2 14.26Q3.25 14.56 3.42 14.75Q3.59 14.94 3.97 14.94Z' },
        P: { a: 7.75, l: 0.81, r: 7.4, d: 'M0.81 16.5V5.5H4.51Q5.5 5.5 6.14 5.87Q6.78 6.25 7.09 6.96Q7.4 7.67 7.4 8.69Q7.4 9.97 6.98 10.64Q6.56 11.31 5.84 11.57Q5.12 11.83 4.22 11.83H3.25V16.5ZM3.25 10.13H4.06Q4.51 10.13 4.74 9.97Q4.97 9.8 5.05 9.48Q5.12 9.15 5.12 8.65Q5.12 8.23 5.06 7.91Q5 7.59 4.77 7.4Q4.54 7.21 4.05 7.21H3.25Z' },
        Q: { a: 7.96, l: 0.67, r: 7.29, d: 'M6.45 18.66Q6.15 18.52 5.73 18.22Q5.31 17.91 4.9 17.5Q4.48 17.08 4.2 16.65Q4.14 16.66 4.09 16.66Q4.03 16.66 3.97 16.66Q2.73 16.66 2.01 16.23Q1.29 15.79 0.98 14.98Q0.67 14.16 0.67 13.04V8.95Q0.67 7.81 0.98 7.01Q1.29 6.21 2.01 5.78Q2.73 5.35 3.97 5.35Q5.21 5.35 5.94 5.78Q6.67 6.21 6.98 7.01Q7.29 7.81 7.29 8.95V13.04Q7.29 13.81 7.15 14.44Q7.01 15.06 6.69 15.52Q6.37 15.98 5.84 16.26Q6.02 16.45 6.21 16.63Q6.4 16.81 6.59 16.97Q6.78 17.12 6.97 17.22ZM3.97 14.94Q4.35 14.94 4.52 14.75Q4.7 14.56 4.75 14.26Q4.81 13.96 4.81 13.65V8.35Q4.81 8.03 4.75 7.73Q4.7 7.44 4.52 7.25Q4.35 7.06 3.97 7.06Q3.59 7.06 3.42 7.25Q3.25 7.44 3.2 7.73Q3.15 8.03 3.15 8.35V13.65Q3.15 13.96 3.2 14.26Q3.25 14.56 3.42 14.75Q3.59 14.94 3.97 14.94Z' },
        R: { a: 8.15, l: 0.81, r: 7.66, d: 'M0.81 16.5V5.5H3.84Q4.96 5.5 5.77 5.74Q6.59 5.99 7.04 6.62Q7.5 7.25 7.5 8.41Q7.5 9.09 7.39 9.61Q7.28 10.14 6.99 10.53Q6.7 10.92 6.15 11.18L7.66 16.5H5.15L3.94 11.57H3.25V16.5ZM3.25 10.17H3.92Q4.44 10.17 4.73 9.99Q5.01 9.8 5.13 9.46Q5.24 9.11 5.24 8.62Q5.24 7.92 4.98 7.52Q4.73 7.13 4.03 7.13H3.25Z' },
        S: { a: 6.98, l: 0.57, r: 6.61, d: 'M3.73 16.66Q2.7 16.66 2.01 16.3Q1.32 15.93 0.96 15.16Q0.61 14.4 0.57 13.17L2.65 12.86Q2.66 13.57 2.78 14Q2.89 14.44 3.1 14.63Q3.31 14.82 3.61 14.82Q3.99 14.82 4.11 14.56Q4.22 14.3 4.22 14.01Q4.22 13.34 3.9 12.87Q3.57 12.4 3.01 11.92L2.06 11.1Q1.44 10.57 1.01 9.89Q0.58 9.22 0.58 8.23Q0.58 6.83 1.41 6.09Q2.24 5.35 3.67 5.35Q4.55 5.35 5.09 5.65Q5.62 5.95 5.9 6.43Q6.18 6.91 6.28 7.45Q6.38 7.99 6.4 8.47L4.3 8.73Q4.29 8.24 4.24 7.88Q4.2 7.52 4.05 7.33Q3.9 7.13 3.59 7.13Q3.25 7.13 3.09 7.41Q2.93 7.7 2.93 7.99Q2.93 8.6 3.23 8.98Q3.52 9.37 3.99 9.79L4.9 10.59Q5.62 11.2 6.12 11.98Q6.61 12.75 6.61 13.89Q6.61 14.67 6.26 15.3Q5.91 15.93 5.26 16.3Q4.62 16.66 3.73 16.66Z' },
        T: { a: 6.04, l: 0.15, r: 5.89, d: 'M1.81 16.5V7.31H0.15V5.5H5.89V7.31H4.25V16.5Z' },
        U: { a: 7.99, l: 0.73, r: 7.25, d: 'M3.99 16.66Q2.73 16.66 2.02 16.25Q1.3 15.83 1.02 15.04Q0.73 14.25 0.73 13.09V5.5H3.14V13.46Q3.14 13.8 3.19 14.14Q3.25 14.48 3.43 14.69Q3.61 14.91 3.99 14.91Q4.39 14.91 4.56 14.69Q4.74 14.48 4.79 14.14Q4.83 13.8 4.83 13.46V5.5H7.25V13.09Q7.25 14.25 6.96 15.04Q6.67 15.83 5.96 16.25Q5.26 16.66 3.99 16.66Z' },
        V: { a: 7.14, l: 0.3, r: 6.86, d: 'M2.28 16.5 0.3 5.5H2.38L3.56 12.97L4.66 5.5H6.86L4.85 16.5Z' },
        W: { a: 9.47, l: 0.37, r: 9.1, d: 'M1.7 16.5 0.37 5.5H2.43L3.08 11.91L3.91 5.51H5.53L6.4 11.87L7.06 5.5H9.1L7.78 16.5H5.66L4.73 9.86L3.84 16.5Z' },
        X: { a: 6.99, l: 0.1, r: 6.91, d: 'M0.1 16.5 2.23 10.58 0.19 5.5H2.49L3.69 8.47L4.67 5.5H6.7L4.77 11.22L6.91 16.5H4.63L3.29 13.21L2.1 16.5Z' },
        Y: { a: 6.7, l: 0.11, r: 6.59, d: 'M2.2 16.5V12L0.11 5.5H2.4L3.45 8.98L4.39 5.5H6.59L4.54 12V16.5Z' },
        Z: { a: 5.88, l: 0.39, r: 5.5, d: 'M0.39 16.5V15.03L3.08 7.14H0.52V5.5H5.47V6.87L2.74 14.86H5.5V16.5Z' },
    };
    const LETTER_GAP = 1.2;
    function drawCode(svg, code) {
        let pen = null, right = 0, paths = '';
        for (const ch of code) {
            const g = LANG_GLYPHS[ch];
            if (!g) continue;
            if (pen === null) pen = -g.l;
            paths += `<path transform="translate(${pen.toFixed(2)} 0)" d="${g.d}"/>`;
            right = pen + g.r;
            pen += g.a + LETTER_GAP;
        }
        svg.setAttribute('viewBox', `0 0 ${right.toFixed(2)} 22`);
        svg.setAttribute('width', right.toFixed(2));
        svg.innerHTML = paths;
    }

    class TabBar {
        // `opts.onOpen(name)`: fills a pane before it shows (settings renders
        // lazily). May return a promise. `opts.takeOver()`: shuts at once
        // whatever stands under the line in the panel's place and answers its
        // height, so a pane opening from none grows from there in one move.
        // `opts.onLeave(name)`: the tab `name` stopped being the open one.
        constructor(root, opts) {
            this.root = root;
            this.onOpen = (opts && opts.onOpen) || (() => {});
            this.onLeave = (opts && opts.onLeave) || (() => {});
            this.takeOver = (opts && opts.takeOver) || (() => 0);
            this.line = root.getElementById('tabline');
            this.bar = root.getElementById('tabbar');
            this.panel = root.getElementById('tab-panel');
            this.tip = root.getElementById('tab-tip');
            this.tabs = this.bar ? Array.from(this.bar.querySelectorAll('[role="tab"]')) : [];
            this.current = null;
            // Each open/close/switch takes a number; one superseded by a later
            // click stops at its next await.
            this._seq = 0;
            this._resizeAnim = null;
            if (!this.bar) return;
            this.bar.addEventListener('click', (e) => {
                if (!e.isTrusted) return;
                const tab = e.target.closest('[role="tab"]');
                if (tab) this.select(tab.dataset.tab === this.current ? null : tab.dataset.tab);
            });
            // Arrows, Home and End move along the line, as in any tablist.
            // Enter and Space press the focused tab like a button.
            this.bar.addEventListener('keydown', (e) => {
                const i = this.tabs.indexOf(e.target);
                if (i < 0) return;
                const n = this.tabs.length;
                const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
                if (to === undefined) return;
                e.preventDefault();
                this.tabs[to].focus();
            });
            // The buttons are glyphs, so keyboard focus shows the name as hover does.
            const hideTip = () => this.tip && this.tip.classList.remove('show');
            this.line.querySelectorAll('.tab').forEach(btn => {
                btn.addEventListener('mouseenter', () => this._placeTip(btn));
                btn.addEventListener('mouseleave', hideTip);
                btn.addEventListener('mousedown', hideTip);
                btn.addEventListener('focus', () => { if (btn.matches(':focus-visible')) this._placeTip(btn); });
                btn.addEventListener('blur', hideTip);
            });
            this.relabel();
            this._mark();
        }

        _tab(name) { return this.tabs.find(tb => tb.dataset.tab === name) || null; }
        _pane(name) { return name ? this.panel.querySelector(`[data-pane="${name}"]`) : null; }

        // Names in the panel's language: the tooltip and what a screen reader says.
        relabel() {
            const lang = window.ILAP.i18n.getLang();
            const names = {
                ai: t('ai_tab_tip'),
                lang: t('language').replace(/\s*[:：]\s*$/, ''),
                settings: sentenceCase(t('settings'), lang),
            };
            this.tabs.forEach(tab => tab.setAttribute('aria-label', names[tab.dataset.tab] || ''));
            const lists = this.root.getElementById('lists-btn');
            if (lists) lists.setAttribute('aria-label', t('presets_title'));
            const queue = this.root.getElementById('queue-btn');
            if (queue) queue.setAttribute('aria-label', t('ignore_queue'));
            const code = this.root.getElementById('lang-code');
            if (code) code.textContent = langCode(lang);
            const glyph = this.root.getElementById('lang-glyph');
            if (glyph) drawCode(glyph, langCode(lang));
        }

        // The tooltip stands over its button's middle, kept inside the line.
        // None over the lists button while its drawer is out: the drawer names itself.
        // The AI tab's long name waits a second (popup.css .tab-tip.slow).
        _placeTip(btn) {
            if (!this.tip || btn.getAttribute('aria-expanded') === 'true') return;
            this.tip.textContent = btn.getAttribute('aria-label');
            this.tip.classList.toggle('slow', btn.dataset.tab === 'ai');
            this.tip.style.left = '0px';
            const line = this.line.getBoundingClientRect();
            const b = btn.getBoundingClientRect();
            const x = b.left - line.left + b.width / 2 - this.tip.offsetWidth / 2;
            const max = this.line.clientWidth - this.tip.offsetWidth - 8;
            this.tip.style.left = Math.max(8, Math.min(x, max)) + 'px';
            this.tip.classList.add('show');
        }

        // The stored tab, shown at once (the panel opens with it, unanimated). A
        // pick during these reads wins: the stored tab would undo it, and a second
        // fill would rebuild the pane under the user.
        restore() {
            return new Promise((resolve) => {
                chrome.storage.local.get(TAB_KEY, (res) => {
                    const name = res && res[TAB_KEY];
                    if (this._seq || !this._tab(name)) { resolve(); return; }
                    Promise.resolve(this.onOpen(name)).catch(() => {}).then(() => {
                        if (!this._seq) this._show(name);
                        resolve();
                    });
                });
            });
        }

        _show(name) {
            this.current = name;
            this.panel.querySelectorAll('.tab-pane').forEach(p => { p.hidden = p.dataset.pane !== name; });
            this._mark();
        }

        // aria-selected and the roving tab stop: the open tab, or the first
        // one with none open. The open tab's underline is its own (popup.css).
        _mark() {
            this.tabs.forEach((tab, i) => {
                const on = tab.dataset.tab === this.current;
                tab.setAttribute('aria-selected', String(on));
                tab.tabIndex = on || (!this.current && i === 0) ? 0 : -1;
            });
            const i = this.tabs.indexOf(this._tab(this.current));
            if (i >= 0) this.panel.setAttribute('aria-labelledby', this.tabs[i].id);
            else this.panel.removeAttribute('aria-labelledby');
        }

        async select(name) {
            if (name === this.current) return;
            const seq = ++this._seq;
            const still = () => seq === this._seq;
            remember(name);
            const left = this.current;
            this.current = name;
            this._mark();
            if (left) this.onLeave(left);
            // By the DOM, not by name: a switch cut short leaves the pane it
            // was leaving on screen.
            const shown = this.panel.querySelector('.tab-pane:not([hidden])');
            const showOnly = () => this.panel.querySelectorAll('.tab-pane').forEach(p => {
                p.getAnimations().forEach(a => a.cancel());
                p.hidden = p.dataset.pane !== name;
            });
            // The empty panel holds the room it takes over until the pane is filled.
            const lent = name && !shown ? this.takeOver() : 0;
            if (lent) this.panel.style.height = lent + 'px';

            if (!name) {
                // Closing: the content stays drawn while the panel shrinks over it.
                await this.resize(() => { this.panel.style.height = '0px'; });
                if (!still()) return;
                showOnly();
                this.panel.style.height = '';
                return;
            }
            const filled = Promise.resolve(this.onOpen(name)).catch(() => {});
            if (shown && !reduceMotion() && shown.animate) {
                await shown.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, fill: 'forwards' })
                    .finished.catch(() => {});
            }
            await filled;
            if (!still()) return;
            await this.resize(() => { this.panel.style.height = ''; showOnly(); }, { fadeIn: this._pane(name) });
        }

        // Shut at once, for the lists that take the panel's place under the
        // line and grow from its height. Answers the height it had.
        foldNow() {
            if (!this.panel || (!this.current && !this._resizeAnim)) return 0;
            const h = this.panel.getBoundingClientRect().height;
            this._seq++;
            if (this._resizeAnim) { this._resizeAnim.cancel(); this._resizeAnim = null; }
            this.panel.classList.remove('moving');
            remember('');
            const left = this.current;
            this.current = null;
            this._mark();
            if (left) this.onLeave(left);
            this.panel.querySelectorAll('.tab-pane').forEach(p => {
                p.getAnimations().forEach(a => a.cancel());
                p.hidden = true;
            });
            this.panel.style.height = '';
            return h;
        }

        // Runs `mutate` and grows or shrinks the panel from its height before to
        // its height after. A resize running already is taken over from the
        // height it has reached. A height `mutate` sets stays set. `fadeIn`: an
        // element shown by `mutate` that fades in with the motion.
        resize(mutate, opts) {
            const p = this.panel;
            if (!p) { mutate(); return Promise.resolve(); }
            const from = p.getBoundingClientRect().height;
            if (this._resizeAnim) this._resizeAnim.cancel();
            mutate();
            const to = p.getBoundingClientRect().height;
            const fadeIn = opts && opts.fadeIn;
            if (from === to || reduceMotion() || !p.animate) return Promise.resolve();
            p.classList.add('moving');
            const anim = this._resizeAnim = p.animate([{ height: from + 'px' }, { height: to + 'px' }],
                { duration: RESIZE_MS, easing: 'ease' });
            if (fadeIn) fadeIn.animate([{ opacity: 0 }, { opacity: 1 }], { duration: RESIZE_MS, easing: 'ease-in' });
            return anim.finished.catch(() => {}).then(() => {
                if (anim !== this._resizeAnim) return;
                this._resizeAnim = null;
                p.classList.remove('moving');
            });
        }
    }

    // A rolled-up block for each corner a drawer unrolls from: 'unroll' the
    // upper left (the queue in the toolbar popup), 'unroll-left' the upper
    // right (the queue in the widget), 'unroll-up-left' the lower right (the
    // lists in the widget, by their button).
    const ROLLED = {
        'unroll': 'inset(0 100% 100% 0)',
        'unroll-left': 'inset(0 0 100% 100%)',
        'unroll-up-left': 'inset(100% 0 0 100%)',
    };

    // Opens a drawer or shuts it. An unrolling axis (ROLLED) unrolls its
    // block like a droplist. `axis` 'height' drops it down instead (the
    // lists in the toolbar popup): it grows from no height to its own while
    // its block fades in, and shrinks back over it.
    // `state` is the drawer's controller: its isOpen (already set to `open`)
    // and _anim, the motion running, so a reversal starts where the drawer is.
    // `prepare` runs after that measure and before the slide (the lists read
    // their rows first). Resolves once the drawer has stopped.
    async function slideDrawer(drawer, open, state, prepare, axis) {
        const prop = axis === 'height' ? 'height' : 'width';
        const from = drawer.getBoundingClientRect()[prop];
        drawer.style[prop] = from + 'px';
        if (state._anim) { state._anim.cancel(); state._anim = null; }
        if (prepare) await prepare();
        if (open !== state.isOpen) return;
        drawer.classList.toggle('open', open);
        drawer.style[prop] = '';
        const to = open ? drawer.getBoundingClientRect()[prop] : 0;
        if (reduceMotion() || !drawer.animate) { drawer.classList.toggle('shown', open); return; }
        drawer.classList.add('shown', 'sliding');
        const inner = drawer.firstElementChild;
        let anim;
        if (ROLLED[axis] && inner) {
            // Its own width at once, the block unrolls from its corner across
            // as it fades in, and rolls back into it.
            if (!open) drawer.style.width = from + 'px';
            const rolled = { clipPath: ROLLED[axis], opacity: 0 };
            const bare = { clipPath: 'inset(0 0 0 0)', opacity: 1 };
            anim = state._anim = inner.animate(open ? [rolled, bare] : [bare, rolled],
                { duration: SLIDE_MS, easing: 'ease', fill: 'forwards' });
        } else {
            anim = state._anim = drawer.animate([{ [prop]: from + 'px' }, { [prop]: to + 'px' }],
                { duration: SLIDE_MS, easing: 'ease', fill: 'forwards' });
            if (inner && open) inner.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SLIDE_MS, easing: 'ease-in' });
        }
        await anim.finished.catch(() => {});
        if (anim !== state._anim) return;
        state._anim = null;
        drawer.style.width = '';
        drawer.classList.remove('sliding');
        if (!open) drawer.classList.remove('shown');
        anim.cancel();
    }

    // The toolbar popup's window, as against the widget's shadow root on a
    // Steam page. There the queue unrolls over the panel and the lists drop
    // down under the tab line (popup.css): a window that grows sideways
    // flashes as the browser redraws it, growing down it does not show.
    const inWindow = (el) => !(el.getRootNode() instanceof ShadowRoot);

    // Shows or hides `el` (its hidden attribute) with its height, margins and
    // opacity going from or to nothing in FOLD_MS, so the box it sits in
    // grows and shrinks with it. A fold under way is taken over from where it
    // stands.
    function fold(el, show) {
        const running = el._ilapFold;
        if (!running && el.hidden === !show) return;
        let start = null;
        if (running) {
            const s = getComputedStyle(el);
            start = { height: el.getBoundingClientRect().height + 'px', marginTop: s.marginTop, marginBottom: s.marginBottom, opacity: s.opacity };
            running.cancel();
            el._ilapFold = null;
        }
        el.hidden = false;
        if (reduceMotion() || !el.animate) { el.hidden = !show; return; }
        const s = getComputedStyle(el);
        const full = { height: el.getBoundingClientRect().height + 'px', marginTop: s.marginTop, marginBottom: s.marginBottom, opacity: 1 };
        const none = { height: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0 };
        el.style.overflow = 'hidden';
        const anim = el._ilapFold = el.animate([start || (show ? none : full), show ? full : none], { duration: FOLD_MS, easing: 'ease' });
        anim.onfinish = () => {
            el._ilapFold = null;
            el.style.overflow = '';
            if (!show) el.hidden = true;
        };
    }

    window.ILAP_Tabs = { create: (root, opts) => new TabBar(root, opts), slideDrawer, inWindow, fold, FOLD_MS, TAB_KEY };

})();
