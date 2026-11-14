// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The AI tab's pane (ui/popup_tabs.js): the level slider and its apply
    // button, HIGH's shot picker, and the two boxes that keep AI games of a
    // kind out of the AI lists (data/presets.json → aikeep). The lists drawer
    // (popup_presets.js) counts and queues the AI lists by the stored boxes.

    const t = window.ILAP.t;
    const esc = window.ILAP.Sanitizer.escapeHTML;
    const Settings = window.ILAP.Settings;
    const K = Settings.KEYS;

    // The AI tab's checkboxes, by their kind in data/presets.json → aikeep.
    const KEEP_KEY = { translation: K.AI_KEEP_TRANSLATION, ingame: K.AI_KEEP_INGAME };
    const LEVELS = Settings.AI_LEVELS;
    // The AI tab's levels as the slider names them, in its order.
    const LEVEL_NAMES = ['off', 'ai_level_low', 'ai_level_medium', 'ai_level_high', 'ai_level_max'];
    const LEVEL_HINTS = ['ai_level_hint_off', 'ai_level_hint_low', 'ai_level_hint_medium', 'ai_level_hint_high', 'ai_level_hint_max'];
    // How long the save button shows its check mark once the level is stored,
    // and how long it then takes to go (popup.css #ai-level-ok).
    const SAVED_MS = 900;
    const SAVED_FADE_MS = 300;
    // How long the slider's thumb takes to glide to a level picked by its name.
    const GLIDE_MS = 200;
    // The HIGH level's shot styles (Settings.SHOTS): each one's name, and the
    // text its thumbnail shows (the rest are drawn in popup.css). The emoji
    // are the system's own, drawn by its emoji font. The emoji thumbnail shows
    // the picked one (Settings.SHOT_EMOJI), picked in a grid of its own. The
    // random one shows its name, as wide as the word takes.
    const SHOT_NAMES = {
        emoji: 'ai_shot_emoji', swipe: 'ai_shot_swipe', ai: 'ai_shot_ai',
        tomato: 'ai_shot_tomato', random: 'ai_shot_random',
    };
    // The emoji grid's columns, for the arrows' up and down.
    const EMOJI_COLS = 5;

    // A write nothing waits on, as TabBar keeps its tab (popup_tabs.js). In a
    // widget left behind by an update storage throws, and the click then does
    // nothing with no error left in the page's console.
    function save(obj) {
        try {
            chrome.storage.local.set(obj, () => void chrome.runtime.lastError);
        } catch (e) { /* no storage left in this tab */ }
    }
    const SHOT_PICS = {
        // A still of shot.js's tomato: the splat, its seeds, a drip running down.
        tomato: '<svg viewBox="0 0 24 24"><path d="M10.6 13h2.2v6.2a1.1 1.1 0 0 1-2.2 0z" fill="#c41f13"/>'
            + '<circle cx="11.7" cy="19.6" r="1.6" fill="#c41f13"/>'
            + '<path d="m12 3.5 1.8 2.6 3-1.1-.4 3.2 3.1 1-2.3 2.2 1.9 2.6-3.2.3-.3 3.2-2.7-1.8L10 17.4 9 14.3l-3.2.2 1.2-3-2.8-1.5 2.8-1.7L5.8 5.3l3.2.6z"'
            + ' fill="#b8170e"/><circle cx="12" cy="10.6" r="4.6" fill="#e0392c"/>'
            + '<circle cx="4.6" cy="5" r=".9" fill="#c41f13"/><circle cx="19.8" cy="15.6" r="1" fill="#c41f13"/>'
            + '<g fill="#f7d36b" opacity=".85"><ellipse cx="10.4" cy="10" rx="1" ry=".6"/>'
            + '<ellipse cx="13.6" cy="11.4" rx="1" ry=".6" transform="rotate(40 13.6 11.4)"/>'
            + '<ellipse cx="11.8" cy="12.9" rx="1" ry=".6" transform="rotate(-30 11.8 12.9)"/></g>'
            + '<path d="m13.4 7.4.7-1.3 1.3.3-1 1 1.6.4-1.7.4-.5 1.2-.8-1-1.7-.2 1.5-.6z" fill="#3f8f2a"/></svg>',
    };

    class AiTab {
        // `opts.onKeep(keep)`: the stored boxes, at every settings read.
        // `opts.resizePane(mutate)`: the pane rebuilt in a new language, the
        // tab panel follows its height (TabBar.resize).
        constructor(root, opts) {
            if (!opts || typeof opts.onKeep !== 'function') {
                throw new TypeError('[ILAP] AiTab needs opts.onKeep');
            }
            this.opts = opts;
            this.pane = root.getElementById('ai-tab-pane');
            // The tab's glyph follows the level the slider shows (popup.css #tab-ai).
            this.tab = root.getElementById('tab-ai');
            // The boxes as last read.
            this.keep = { translation: false, ingame: false };
            this._lang = null;
            // The stored AI level, and the one the slider moved to with the
            // boxes it would set ({ level, keep }), until the tick stores it.
            // Null while the slider stands on the stored level.
            this.aiLevel = LEVELS.OFF;
            this._draft = null;
            this.shotAnim = false;
            // The stored shot style and emoji, as last read.
            this.shot = Settings.DEFAULTS.AI_SHOT;
            this.emoji = Settings.DEFAULTS.AI_SHOT_EMOJI;
            // Real user input only, as for the master switch: the widget's
            // shadow root is open to page script.
            if (this.pane) {
                this.pane.addEventListener('input', (e) => {
                    if (e.isTrusted && e.target.id === 'ai-level') this._moveLevel(Number(e.target.value));
                });
                // Taken in hand mid-glide, the thumb moves by whole levels again.
                this.pane.addEventListener('pointerdown', (e) => {
                    if (e.target.id === 'ai-level') this._stopGlide(e.target);
                });
                this.pane.addEventListener('click', (e) => {
                    if (!e.isTrusted) return;
                    const tick = e.target.closest('.ai-level-tick');
                    if (tick) this._moveLevel(Number(tick.dataset.level));
                    if (e.target.closest('#ai-level-ok')) this._applyLevel();
                    const pick = e.target.closest('.ai-emoji-opt');
                    if (pick) { this._pickEmoji(pick.dataset.emoji, e.detail === 0); return; }
                    // The caret opens the grid and shuts it. So does a click on
                    // the emoji thumbnail while it is the picked style (a click
                    // that picks it only picks it).
                    const thumb = e.target.closest('.ai-shot-opt');
                    if (e.target.closest('.ai-emoji-btn')) this._showEmoji(!this._emojiOpen(), e.detail === 0);
                    else if (thumb && thumb.closest('.ai-shot-cell') && e.target.tagName !== 'INPUT' && this.shot === 'emoji') {
                        this._showEmoji(!this._emojiOpen(), false);
                    }
                });
                // The grid: one tab stop, on the picked emoji. The arrows move the
                // focus, Enter or Space picks. Escape shuts it and gives the focus
                // back to the caret, and so does the focus leaving it.
                this.pane.addEventListener('keydown', (e) => {
                    const opts = Array.from(this.pane.querySelectorAll('.ai-emoji-opt'));
                    const i = opts.indexOf(e.target);
                    if (i < 0) return;
                    if (e.key === 'Escape') {
                        e.stopPropagation();
                        this._showEmoji(false);
                        const btn = this.pane.querySelector('.ai-emoji-btn');
                        if (btn) btn.focus();
                        return;
                    }
                    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: EMOJI_COLS, ArrowUp: -EMOJI_COLS }[e.key];
                    const to = e.key === 'Home' ? 0 : e.key === 'End' ? opts.length - 1
                        : step === undefined ? -1 : Math.min(Math.max(i + step, 0), opts.length - 1);
                    if (to < 0) return;
                    e.preventDefault();
                    opts[i].tabIndex = -1;
                    opts[to].tabIndex = 0;
                    opts[to].focus();
                });
                this.pane.addEventListener('focusout', (e) => {
                    const grid = this.pane.querySelector('.ai-emoji-grid');
                    if (grid && grid.contains(e.target) && !grid.contains(e.relatedTarget)) this._showEmoji(false);
                });
                // A click anywhere else shuts the grid.
                root.addEventListener('click', (e) => {
                    const cell = this.pane.querySelector('.ai-shot-cell');
                    if (cell && !cell.contains(e.target)) this._showEmoji(false);
                });
                this.pane.addEventListener('change', (e) => {
                    const box = e.isTrusted && e.target.closest('input[data-keep]');
                    // A box moved while a level waits for its tick goes with that level.
                    if (box && this._draft) this._draft.keep[box.dataset.keep] = box.checked;
                    else if (box) save({ [KEEP_KEY[box.dataset.keep]]: box.checked });
                    if (e.isTrusted && e.target.name === 'ai-shot') {
                        save({ [K.AI_SHOT]: Settings.normalizeShot(e.target.value) });
                    }
                    if (e.isTrusted && e.target.id === 'ai-shot-anim') {
                        save({ [K.AI_SHOT_ANIM]: e.target.checked });
                    }
                });
            }
        }

        // The pane, from the popup's settings read (`data`). Built once per
        // language, its slider and boxes then follow storage, unless a level
        // waits for its tick. The stored boxes go to opts.onKeep.
        render(data) {
            if (!this.pane) return;
            const lang = window.ILAP.i18n.getLang();
            if (this._lang !== lang) {
                // A language switch while the pane is out: the panel follows
                // the new strings' height (TabBar.resize) instead of jumping.
                const switched = !!this._lang;
                this._lang = lang;
                const box = (kind, text, sub) => `<label class="ai-check"><span class="ai-check-text">${esc(text)}`
                    + (sub ? `<span class="ai-sub">${esc(sub)}</span>` : '') + '</span>'
                    + `<span class="switch"><input type="checkbox" data-keep="${kind}"><span class="slider" aria-hidden="true"></span></span></label>`;
                // Each thumbnail's name in a tooltip over it, the emoji's with how
                // to change it. The random one shows its name already, so no tip.
                const thumb = (v) => `<label class="ai-shot-opt">`
                    + `<input type="radio" name="ai-shot" value="${v}" aria-label="${esc(t(SHOT_NAMES[v]))}">`
                    + (v === 'random'
                        ? `<span class="ai-shot-pic" data-shot="${v}" aria-hidden="true">${esc(t(SHOT_NAMES.random))}</span>`
                        : `<span class="ai-shot-pic" data-shot="${v}" aria-hidden="true">${SHOT_PICS[v] || ''}</span>`
                            + `<span class="ai-opt-tip" role="tooltip" aria-hidden="true">${esc(t(v === 'emoji' ? 'ai_shot_emoji_tip' : SHOT_NAMES[v]))}</span>`)
                    + `</label>`;
                // The emoji thumbnail, with the caret that opens its grid over the panel.
                const emojiName = esc(t(SHOT_NAMES.emoji));
                const grid = Settings.SHOT_EMOJI.map(em => `<button type="button" class="ai-emoji-opt" role="radio"`
                    + ` aria-checked="false" tabindex="-1" data-emoji="${esc(em)}">${esc(em)}</button>`).join('');
                const shots = Settings.SHOTS.map(v => (v !== 'emoji' ? thumb(v)
                    : `<span class="ai-shot-cell">${thumb(v)}`
                        + `<button type="button" class="ai-emoji-btn" aria-haspopup="true" aria-expanded="false" aria-label="${emojiName}"></button>`
                        + `<div class="ai-emoji-grid" role="radiogroup" aria-label="${emojiName}">${grid}</div></span>`)).join('');
                const ticks = LEVEL_NAMES.map((key, i) =>
                    `<span class="ai-level-tick" data-level="${i}" style="--i:${i}">${esc(t(key))}</span>`).join('');
                // The hints share one cell, so the pane keeps the tallest one's height.
                const hints = LEVEL_HINTS.map((key, i) =>
                    `<div class="ai-level-hint" data-level="${i}">${esc(t(key))}</div>`).join('');
                const build = () => { this.pane.innerHTML = `<div class="list-title">${esc(t('preset_ai'))}</div>
                    <div class="ai-level"><div class="ai-level-row"><div class="ai-level-track">`
                    + `<input type="range" id="ai-level" min="${LEVELS.OFF}" max="${LEVELS.MAX}" step="1" aria-label="${esc(t('ai_level'))}">`
                    + `<div class="ai-level-ticks" aria-hidden="true">${ticks}</div></div>`
                    + `<button type="button" id="ai-level-ok" aria-label="${esc(t('ai_level_apply'))}">`
                    + `<span class="ok-save">${window.ILAP_Icons.SAVE}</span><span class="ok-check">${window.ILAP_Icons.CHECK}</span></button></div>`
                    + `<div class="ai-level-hints" aria-live="polite">${hints}</div></div>`
                    + `<div class="ai-shot-row" role="radiogroup" aria-labelledby="ai-shot-label">`
                    + `<div class="ai-shot-head"><span id="ai-shot-label">${esc(t('ai_shot'))}</span><span id="ai-shot-name"></span>`
                    + `<span class="ai-shot-anim"><label class="switch switch-sm"><input type="checkbox" id="ai-shot-anim" aria-label="${esc(t('ai_shot_anim'))}">`
                    + `<span class="slider" aria-hidden="true"></span></label>`
                    + `<span class="ai-shot-tip" role="tooltip" aria-hidden="true">${esc(t('ai_shot_anim'))}</span></span></div>`
                    + `<div class="ai-shots">${shots}</div></div>`
                    + `<div class="ai-keep">${box('translation', t('ai_keep_translation'))}`
                    + box('ingame', t('ai_keep_ingame'), t('ai_keep_ingame_tip')) + '</div>'; };
                // Painted with the level and shot name it showed, so the new
                // height is measured whole.
                const paint = () => {
                    build();
                    this.pane.querySelector('#ai-shot-name').textContent = t(SHOT_NAMES[Settings.normalizeShot(data[K.AI_SHOT])]);
                    this._paintLevel();
                };
                if (switched && this.opts.resizePane) this.opts.resizePane(paint);
                else build();
            }
            const shot = this.shot = Settings.normalizeShot(data[K.AI_SHOT]);
            for (const input of this.pane.querySelectorAll('input[name="ai-shot"]')) input.checked = input.value === shot;
            this.pane.querySelector('#ai-shot-name').textContent = t(SHOT_NAMES[shot]);
            this._paintEmoji(Settings.normalizeShotEmoji(data[K.AI_SHOT_EMOJI]));
            this.shotAnim = Settings.isOn(data[K.AI_SHOT_ANIM]);
            const keep = {
                translation: data[K.AI_KEEP_TRANSLATION] === true,
                ingame: data[K.AI_KEEP_INGAME] === true,
            };
            this.keep = keep;
            this.aiLevel = Settings.normalizeAiLevel(data[K.AI_LEVEL]);
            if (this._draft && this._draft.level === this.aiLevel) this._draft = null;
            this._paintLevel();
            this.opts.onKeep(keep);
        }

        // The slider moved to `level`. Back on the stored level it is as
        // stored. Another one waits for its tick, with its boxes as that level
        // sets them (Settings.AI_LEVEL_KEEP, the stored ones for OFF and MAX).
        // MAX is the joke, with its message and no tick.
        // The thumb and the track's fill glide to a level picked by its name or
        // set from elsewhere (GLIDE_MS, easing out), through any value on the
        // way. A drag or a key has already put the thumb there. A new slider
        // and reduced motion take the level at once.
        _slide(slider, level) {
            // Read before the stop, which puts the thumb back on a whole step.
            const from = Number(slider.value);
            this._stopGlide(slider);
            const fill = (v) => slider.style.setProperty('--fill', (v / LEVELS.MAX * 100) + '%');
            const fresh = !('painted' in slider.dataset);
            slider.dataset.painted = '';
            if (fresh || from === level || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                slider.value = String(level);
                fill(level);
                return;
            }
            slider.step = 'any';
            const t0 = performance.now();
            const frame = (now) => {
                // A frame's time is when it began, which can be before the click.
                const p = Math.max(0, Math.min(1, (now - t0) / GLIDE_MS));
                const v = from + (level - from) * (1 - Math.pow(1 - p, 3));
                slider.value = String(v);
                fill(v);
                if (p < 1) { this._glide = requestAnimationFrame(frame); return; }
                this._glide = 0;
                slider.step = '1';
                slider.value = String(level);
            };
            this._glide = requestAnimationFrame(frame);
        }

        // A glide stopped where it is, back on whole steps: a new level, or
        // the thumb taken in hand.
        _stopGlide(slider) {
            if (!this._glide) return;
            cancelAnimationFrame(this._glide);
            this._glide = 0;
            slider.step = '1';
        }

        _moveLevel(level) {
            if (!Number.isInteger(level) || level < LEVELS.OFF || level > LEVELS.MAX) return;
            if (this._draft && this._draft.level === level) return;
            this._endSaved();
            this._draft = level === this.aiLevel ? null
                : { level, keep: Object.assign({}, Settings.AI_LEVEL_KEEP[level] || this.keep) };
            this._paintLevel();
        }

        // The tick stores the level and its boxes at once. The stored change
        // repaints the pane (render). The button turns into a check mark,
        // stays SAVED_MS, then goes, and is the save button again once out of sight.
        _applyLevel() {
            const d = this._draft;
            if (!d || d.level === LEVELS.MAX) return;
            save({
                [K.AI_LEVEL]: d.level,
                [K.AI_KEEP_TRANSLATION]: d.keep.translation,
                [K.AI_KEEP_INGAME]: d.keep.ingame,
            });
            this._endSaved();
            this._saved = true;
            this.pane.querySelector('#ai-level-ok').classList.add('saved');
            this._savedTimer = setTimeout(() => {
                this._saved = false;
                this._paintLevel();
                this._savedTimer = setTimeout(() => this._endSaved(), SAVED_FADE_MS);
            }, SAVED_MS);
        }

        // The check mark off at once: the slider moved again, or it has gone.
        _endSaved() {
            clearTimeout(this._savedTimer);
            this._saved = false;
            const ok = this.pane && this.pane.querySelector('#ai-level-ok');
            if (ok) ok.classList.remove('saved');
        }

        // The picked emoji on its thumbnail and in the grid.
        _paintEmoji(emoji) {
            this.emoji = emoji;
            const pic = this.pane.querySelector('.ai-shot-pic[data-shot="emoji"]');
            if (pic) pic.textContent = emoji;
            for (const opt of this.pane.querySelectorAll('.ai-emoji-opt')) {
                const on = opt.dataset.emoji === emoji;
                opt.classList.toggle('selected', on);
                opt.setAttribute('aria-checked', String(on));
                opt.tabIndex = on ? 0 : -1;
            }
        }

        _emojiOpen() {
            const grid = this.pane && this.pane.querySelector('.ai-emoji-grid');
            return !!grid && grid.classList.contains('open');
        }

        // The grid fades in over the panel, up from the emoji thumbnail, and
        // out again (popup.css). From the keyboard (`focus`) the focus goes to
        // the picked emoji.
        _showEmoji(open, focus) {
            const grid = this.pane && this.pane.querySelector('.ai-emoji-grid');
            const btn = this.pane && this.pane.querySelector('.ai-emoji-btn');
            if (!grid || !btn || (open && btn.disabled) || open === this._emojiOpen()) return;
            grid.classList.toggle('open', open);
            btn.setAttribute('aria-expanded', String(open));
            if (open && focus) {
                const sel = grid.querySelector('.ai-emoji-opt.selected');
                if (sel) sel.focus({ preventScroll: true });
            }
        }

        // An emoji picked: it is stored, and the emoji shot with it. The grid
        // shuts, and from the keyboard the focus goes back to the caret.
        _pickEmoji(emoji, byKey) {
            if (!Settings.SHOT_EMOJI.includes(emoji)) return;
            this._paintEmoji(emoji);
            save({ [K.AI_SHOT_EMOJI]: emoji, [K.AI_SHOT]: 'emoji' });
            this._showEmoji(false);
            const btn = byKey && this.pane.querySelector('.ai-emoji-btn');
            if (btn) btn.focus();
        }

        // The AI tab shut, or the widget's panel. A level with no tick is
        // dropped, and the emoji grid shuts.
        dropDraft() {
            this._showEmoji(false);
            if (!this._draft) return;
            this._draft = null;
            this._paintLevel();
        }

        // The slider, its hint, the tick, the boxes and the shot row, for the
        // level waiting for its tick or else the stored one. The shot is HIGH's.
        _paintLevel() {
            const slider = this.pane && this.pane.querySelector('#ai-level');
            if (!slider) return;
            const d = this._draft;
            const level = d ? d.level : this.aiLevel;
            const keep = d ? d.keep : this.keep;
            this._slide(slider, level);
            slider.setAttribute('aria-valuetext', t(LEVEL_NAMES[level]));
            // The slider's colour and the tab's glyph go with the level shown.
            this.pane.querySelector('.ai-level').dataset.level = String(level);
            if (this.tab) this.tab.dataset.level = String(level);
            this.pane.querySelectorAll('.ai-level-tick').forEach(el => {
                el.classList.toggle('on', Number(el.dataset.level) === level);
            });
            this.pane.querySelectorAll('.ai-level-hint').forEach(el => {
                el.classList.toggle('shown', Number(el.dataset.level) === level);
            });
            const ok = this.pane.querySelector('#ai-level-ok');
            const waiting = !!d && level !== LEVELS.MAX;
            ok.classList.toggle('shown', waiting || !!this._saved);
            ok.disabled = !waiting;
            const max = level === LEVELS.MAX;
            // Where MAX's message starts (popup.css): the hints' top in the pane.
            const hintsBox = this.pane.querySelector('.ai-level-hints');
            if (max && hintsBox.offsetParent === this.pane) this.pane.style.setProperty('--max-top', hintsBox.offsetTop + 'px');
            this.pane.classList.toggle('ai-max', max);
            this.pane.querySelector('.ai-keep').setAttribute('aria-disabled', String(max));
            const high = level === LEVELS.HIGH;
            const shotRow = this.pane.querySelector('.ai-shot-row');
            shotRow.classList.toggle('ai-dim', !high);
            shotRow.setAttribute('aria-disabled', String(!high));
            // With the animation off, the styles have nothing to pick. Dimmed
            // only on HIGH, so off it the row is not dimmed twice.
            const anim = this.pane.querySelector('#ai-shot-anim');
            anim.checked = this.shotAnim;
            anim.disabled = !high;
            this.pane.querySelector('.ai-shots').classList.toggle('ai-dim', high && !this.shotAnim);
            for (const input of this.pane.querySelectorAll('input[name="ai-shot"]')) input.disabled = !high || !this.shotAnim;
            const emojiBtn = this.pane.querySelector('.ai-emoji-btn');
            emojiBtn.disabled = !high || !this.shotAnim;
            if (emojiBtn.disabled) this._showEmoji(false);
            for (const input of this.pane.querySelectorAll('input[data-keep]')) {
                input.checked = keep[input.dataset.keep];
                input.disabled = max;
            }
        }
    }

    window.ILAP_AiTab = { create: (root, opts) => new AiTab(root, opts) };
})();
