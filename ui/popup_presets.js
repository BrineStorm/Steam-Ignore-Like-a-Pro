// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The built-in ignore lists (data/presets.json, built by
    // scripts/build-presets.js): the icon on the queue applet's bar and its menu.
    // One pick queues one list as a job of its own. A list is offered while it
    // is neither in the queue nor run to its end in this build's version of it
    // (Store.blockedPresets).

    const t = window.ILAP.t;
    const esc = window.ILAP.Sanitizer.escapeHTML;
    const Store = window.ILAP.Curator.Store;

    const DATA_PATH = 'data/presets.json';
    const AI = 'ai';
    const DENUVO = 'denuvo';
    // The AI list's buckets besides the plain years (scripts/build-presets.js
    // bucketOf): 'upcoming_2027', 'upcoming_2028+', 'tba', 'earlier_2023'.
    const UPCOMING_RE = /^upcoming_(\d{4}\+?)$/;
    const EARLIER_RE = /^earlier_(\d{4})$/;
    const TBA = 'tba';
    const YEAR_RE = /^\d{4}$/;
    // The lists that ship whole, in the menu's order after the AI row.
    const FLAT = [DENUVO, 'anticheat', 'iap', 'vr'];

    // Read once per page: the file ships with the build and never changes under it.
    let dataPromise = null;
    function loadData() {
        if (!dataPromise) {
            dataPromise = fetch(chrome.runtime.getURL(DATA_PATH))
                .then(r => r.json())
                .catch((e) => { dataPromise = null; throw e; });
        }
        return dataPromise;
    }

    // The upcoming years soonest first, then 'tba', then the released years
    // newest first, then the older ones together.
    function bucketRank(b) {
        const up = UPCOMING_RE.exec(b);
        if (up) return [0, parseInt(up[1], 10)];
        if (b === TBA) return [1, 0];
        if (YEAR_RE.test(b)) return [2, -b];
        return [3, 0];
    }
    function aiBuckets(data) {
        return Object.keys((data && data.ai) || {}).sort((a, b) => {
            const ra = bucketRank(a), rb = bucketRank(b);
            return ra[0] - rb[0] || ra[1] - rb[1];
        });
    }

    // The menu's rows answer the keyboard as buttons. A row that cannot be picked
    // leaves the Tab order.
    const ITEM_SELECTOR = '[data-bucket], [data-act], [data-list]';
    const asButton = (off) => ` role="button" tabindex="${off ? -1 : 0}"${off ? ' aria-disabled="true"' : ''}`;
    // The same row in the redrawn menu.
    function itemSelector(item) {
        const attr = ['data-bucket', 'data-act', 'data-list'].find(a => item.hasAttribute(a));
        return `[${attr}="${CSS.escape(item.getAttribute(attr))}"]`;
    }

    // The year the menu starts on, among the open ones: this year's released
    // games, or the nearest released year when this year has no list or it is
    // done (the newer of two as near). With no such year open, the first open
    // bucket.
    function startBucket(open) {
        const now = new Date().getFullYear();
        const years = open.filter(b => YEAR_RE.test(b));
        if (!years.length) return open[0] || null;
        return years.reduce((best, b) => {
            const d = Math.abs(+b - now), bd = Math.abs(+best - now);
            return d < bd || (d === bd && +b > +best) ? b : best;
        });
    }

    function bucketLabel(bucket) {
        const up = UPCOMING_RE.exec(bucket);
        if (up) return t('preset_upcoming', { year: up[1] });
        const earlier = EARLIER_RE.exec(bucket);
        if (earlier) return t('preset_earlier', { year: earlier[1] });
        if (bucket === TBA) return t('preset_tba');
        return bucket;
    }
    const hasList = (data, key) => Array.isArray(data[key]) && data[key].length > 0;
    // A whole list's name, in the menu and on its job. Denuvo DRM is a brand name.
    const FLAT_NAME = { anticheat: 'preset_anticheat', iap: 'preset_iap', vr: 'preset_vr' };
    const flatName = (key) => (key === DENUVO ? 'Denuvo DRM' : t(FLAT_NAME[key]));

    // The name a list's job shows in the queue ("AI games 2025"). Keys:
    // 'ai_2025', 'ai_upcoming_2027', 'ai_tba', 'ai_earlier_2023', 'denuvo',
    // 'anticheat', 'iap', 'vr'.
    function label(key) {
        key = String(key || '');
        if (FLAT.includes(key)) return flatName(key);
        if (!key.startsWith(AI + '_')) return key;
        const bucket = key.slice(AI.length + 1);
        const up = UPCOMING_RE.exec(bucket);
        if (up) return t('preset_ai_job_upcoming', { when: up[1] });
        if (bucket === TBA) return t('preset_ai_job_tba');
        return t('preset_ai_job', { when: bucketLabel(bucket) });
    }

    class PresetMenu {
        // `opts.holdCount()` keeps the queue's job count at its old number and
        // returns its release (popup_queue.js holdCount). Required.
        constructor(root, opts) {
            if (!opts || typeof opts.holdCount !== 'function') {
                throw new TypeError('[ILAP] PresetMenu needs opts.holdCount');
            }
            this.root = root;
            this.holdCount = opts.holdCount;
            this.accordion = root.getElementById('queue-accordion');
            this.chip = root.getElementById('preset-chip');
            this.menu = root.getElementById('preset-menu');
            this.tip = root.getElementById('preset-tip');
            this.data = null;
            this.blocked = new Set();   // list keys queued or already run
            this.list = AI;
            this.bucket = null;
            this.yearsOpen = false;
            this.msg = '';
            this._hlAt = null;          // where the selected row's highlight stands
            // Add is off from its press until the next pick: the menu moves on to
            // an open list once this one is queued, and a second click must not
            // queue that one.
            this._goLocked = false;
            if (!this.chip || !this.menu) return;
            // The icon sits inside the applet's <summary>: preventDefault keeps the
            // click from toggling the applet, stopPropagation keeps it from the
            // summary's own handler and the outside-click menu closer.
            this.chip.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!e.isTrusted) return;
                if (this.menu.contains(e.target)) { this._onMenu(e); return; }
                this._toggle();
            });
            // Once the icon has been used, its tooltip stays down, the menu open
            // or closed again, until the pointer leaves the icon (the menu is a
            // child of it, so moving into the menu does not count as leaving).
            this.chip.addEventListener('mouseleave', () => this.chip.classList.remove('tip-done'));
            this.chip.addEventListener('mouseenter', () => this._placeTip());
            // role="button": Enter and Space open it too, and pick a row of the
            // open menu. A pick redraws the menu, so focus goes back to the same
            // row, or to Add once that row is gone (a year picked closes the list).
            this.chip.addEventListener('keydown', (e) => {
                if (!e.isTrusted || (e.key !== 'Enter' && e.key !== ' ')) return;
                // A held key's auto-repeat presses nothing, Add included.
                if (e.repeat) { e.preventDefault(); e.stopPropagation(); return; }
                if (e.target === this.chip) {
                    e.preventDefault();
                    e.stopPropagation();
                    this._toggle();
                    return;
                }
                const item = e.target.closest && e.target.closest(ITEM_SELECTOR);
                if (!item || !this.menu.contains(item)) return;
                e.preventDefault();
                e.stopPropagation();
                const again = itemSelector(item);
                this._onMenu(e);
                const next = this.menu.querySelector(again) || this.menu.querySelector('#preset-go');
                if (next) next.focus();
            });
        }

        // The tooltip starts under the icon's middle, moved left as far as it
        // takes to end 16px inside the bar. Measured on every hover: the label
        // follows the panel's language. It is measured at the bar's left edge,
        // where it has the most room, so it wraps only when it must. Both share
        // the bar as offsetParent.
        _placeTip() {
            if (!this.tip || !this.tip.offsetParent) return;
            this.tip.style.left = '0px';
            const x = this.chip.offsetLeft + this.chip.offsetWidth / 2;
            const maxX = this.tip.offsetParent.clientWidth - this.tip.offsetWidth - 16;
            this.tip.style.left = Math.max(16, Math.min(x, maxX)) + 'px';
        }

        _toggle() {
            this.chip.classList.add('tip-done');
            const wasOpen = this.menu.classList.contains('open');
            this.root.querySelectorAll('.select-menu.open').forEach(m => m.classList.remove('open'));
            if (wasOpen || this.accordion.classList.contains('master-off')) return;
            this.yearsOpen = false;
            this.msg = '';
            this._goLocked = false;
            this._hlAt = null;
            this._refresh().then(() => { this.menu.classList.add('open'); this._placeHl(); })
                .catch((e) => console.warn('[ILAP] built-in lists unavailable:', e));
        }

        async _refresh() {
            const data = this.data = await loadData();
            this.blocked = await Store.blockedPresets(data.rev);
            const buckets = aiBuckets(data);
            if (!buckets.includes(this.bucket) || this.blocked.has(AI + '_' + this.bucket)) {
                this.bucket = startBucket(buckets.filter(b => !this.blocked.has(AI + '_' + b))) || buckets[0] || null;
            }
            // Nothing left to pick on the chosen row: start on the first one
            // that has something, if any does.
            const open = FLAT.filter(k => hasList(data, k) && !this.blocked.has(k));
            if (buckets.some(b => !this.blocked.has(AI + '_' + b))) open.unshift(AI);
            if (open.length && !open.includes(this.list)) this.list = open[0];
            this._render();
        }

        // The queue or a list's done mark changed: an open menu redraws, so it
        // never offers a list another tab or the drainer has just taken.
        refresh() {
            if (!this.menu || !this.menu.classList.contains('open')) return;
            this._refresh().catch((e) => console.warn('[ILAP] built-in lists unavailable:', e));
        }

        _key() {
            return this.list === AI ? AI + '_' + this.bucket : this.list;
        }

        _render() {
            const data = this.data;
            const buckets = aiBuckets(data);
            const off = (key) => (this.blocked.has(key) ? ' disabled' : '');
            const sel = (list) => (this.list === list ? ' selected' : '');
            const aiDone = buckets.every(b => this.blocked.has(AI + '_' + b));

            const ai = !buckets.length ? '' : `
                <div class="preset-opt${sel(AI)}${aiDone ? ' disabled' : ''}" data-list="${AI}"${asButton(aiDone)}>
                    <span class="preset-dot"></span><span class="preset-name">${esc(t('preset_ai'))}</span>
                    <span class="preset-year${this.yearsOpen ? ' open' : ''}" data-act="years"${asButton(false)} aria-expanded="${this.yearsOpen}">${esc(bucketLabel(this.bucket))}</span>
                </div>`;
            const years = !this.yearsOpen ? '' : `<div class="preset-years">${buckets.map(b =>
                    `<div class="select-opt${b === this.bucket ? ' selected' : ''}${off(AI + '_' + b)}" data-bucket="${esc(b)}"${asButton(this.blocked.has(AI + '_' + b))}>${esc(bucketLabel(b))}</div>`
                ).join('')}</div>`;
            const flat = FLAT.filter(k => hasList(data, k)).map(k => `
                <div class="preset-opt${sel(k)}${off(k)}" data-list="${k}"${asButton(this.blocked.has(k))}>
                    <span class="preset-dot"></span><span class="preset-name">${esc(flatName(k))}</span>
                </div>`).join('');
            const goOff = this._goLocked || (this.list === AI && !this.bucket) || this.blocked.has(this._key());

            // The menu opens upward with only the popup's header above it, so it
            // never grows. A message stands in for Add until the next pick. The
            // open years drop over the lists, which stay in view, so the menu
            // keeps its height.
            const yearWas = this._yearBox();
            this.menu.innerHTML = `
                <div class="preset-hl" hidden></div>
                <div class="preset-title">${esc(t('presets_title'))}</div>
                ${ai}<div class="preset-flat${this.yearsOpen ? ' covered' : ''}">${flat}${years}</div>
                ${this.msg ? `<div class="preset-msg">${esc(this.msg)}</div>`
                    : `<button type="button" class="preset-go" id="preset-go"${goOff ? ' disabled' : ''}>${esc(t('curator_add_to_queue'))}</button>`}`;
            // The open years hang under the year button, at least as wide as it.
            const yearBtn = this.menu.querySelector('.preset-year');
            const yearsBox = this.menu.querySelector('.preset-years');
            if (yearBtn && yearsBox) yearsBox.style.minWidth = yearBtn.offsetWidth + 'px';
            this._placeHl();
            this._moveYear(yearWas);
        }

        // The AI row and where its year button stands in it, in an open menu.
        _yearBox() {
            const row = this.menu.classList.contains('open') && this.menu.querySelector(`.preset-opt[data-list="${AI}"]`);
            const btn = row && row.querySelector('.preset-year');
            if (!btn) return null;
            const r = row.getBoundingClientRect(), b = btn.getBoundingClientRect();
            return { row, btn, h: r.height, x: b.left - r.left, y: b.top - r.top };
        }

        // A year that no longer fits beside the name wraps under it (popup.css),
        // and one that fits again comes back up. The redraw would jump there, so
        // the row grows or shrinks to its new height and the button flies from
        // its old place into the new one, in step with the highlight's slide.
        _moveYear(was) {
            const now = this._yearBox();
            if (!was || !now || was.y === now.y || !now.row.animate
                || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
            const timing = { duration: 220, easing: 'ease' };
            now.row.animate([{ height: was.h + 'px' }, { height: now.h + 'px' }], timing);
            now.btn.animate([{ transform: `translate(${was.x - now.x}px, ${was.y - now.y}px)` }, { transform: 'none' }], timing);
        }

        // The selected row's highlight is one block under the rows that slides
        // from the row picked before to the one picked now (popup.css
        // .preset-hl). A render draws it afresh, so it starts where the last one
        // stood. A menu just opened shows it in place, with no slide.
        _placeHl() {
            const hl = this.menu.querySelector('.preset-hl');
            const row = this.menu.querySelector('.preset-opt.selected');
            if (!hl) return;
            if (!row || !this.menu.classList.contains('open')) { this._hlAt = null; return; }
            const m = this.menu.getBoundingClientRect(), r = row.getBoundingClientRect();
            const to = { top: r.top - m.top - this.menu.clientTop, height: r.height };
            hl.hidden = false;
            if (this._hlAt) {
                hl.style.top = this._hlAt.top + 'px';
                hl.style.height = this._hlAt.height + 'px';
                void hl.offsetWidth;
                hl.classList.add('moving');
            }
            hl.style.top = to.top + 'px';
            hl.style.height = to.height + 'px';
            this._hlAt = to;
        }

        _onMenu(e) {
            const years = e.target.closest('[data-act="years"]');
            const bucket = e.target.closest('[data-bucket]');
            const opt = e.target.closest('.preset-opt');
            if (e.target.closest('#preset-go')) {
                if (!e.target.closest('#preset-go').disabled) this._stage();
                return;
            }
            this.msg = '';
            if (bucket) {
                if (bucket.classList.contains('disabled')) return;
                this.bucket = bucket.getAttribute('data-bucket');
                this.list = AI;
                this.yearsOpen = false;
                this._goLocked = false;
            } else if (years) {
                this.list = AI;
                this.yearsOpen = !this.yearsOpen;
            } else if (opt && !opt.classList.contains('disabled')) {
                this.list = opt.getAttribute('data-list');
                this.yearsOpen = false;
                this._goLocked = false;
            } else {
                return;
            }
            this._render();
        }

        // A list just added: a copy of its row shrinks into the queue bar's job
        // count, speeding up as it goes, the way a window minimizes into the
        // taskbar. The menu stays open. The copy is an inert picture (its
        // attributes stripped, so nothing finds or answers it) laid in the
        // bar, so it moves with the panel. Resolves once it has landed.
        _flyToQueue(row, from) {
            const bar = this.accordion.querySelector(':scope > summary');
            const target = this.root.getElementById('queue-jobs-chip');
            const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (reduce || !bar || !target || !row || !from || !from.width) return Promise.resolve();
            const to = target.getBoundingClientRect();
            const b = bar.getBoundingClientRect();
            for (const el of [row, ...row.querySelectorAll('*')]) {
                for (const { name } of [...el.attributes]) if (name !== 'class') el.removeAttribute(name);
            }
            const ghost = document.createElement('div');
            ghost.className = 'preset-ghost';
            ghost.appendChild(row);
            Object.assign(ghost.style, {
                left: (from.left - b.left - bar.clientLeft) + 'px', top: (from.top - b.top - bar.clientTop) + 'px',
                width: from.width + 'px', height: from.height + 'px',
            });
            bar.appendChild(ghost);
            if (!ghost.animate) { ghost.remove(); return Promise.resolve(); }
            const sx = to.width / from.width, sy = to.height / from.height;
            const dx = to.left - from.left, dy = to.top - from.top;
            return ghost.animate([
                { transform: 'none', opacity: 1 },
                { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: .3 },
            ], { duration: 450, easing: 'cubic-bezier(.55, 0, .8, .4)' }).finished
                .catch(() => {})
                .then(() => ghost.remove());
        }

        async _stage() {
            // The extension went off while the menu was open: it takes no new jobs.
            if (this.accordion.classList.contains('master-off')) {
                this.menu.classList.remove('open');
                return;
            }
            const key = this._key();
            const appids = this.list === AI ? this.data.ai[this.bucket] : this.data[this.list];
            // The picked row as it stands now: the menu redraws once the list
            // is queued. The job count holds until that row has flown into it.
            const picked = this.menu.querySelector('.preset-opt.selected');
            const from = picked && picked.getBoundingClientRect();
            const row = picked && picked.cloneNode(true);
            const release = this.holdCount();
            this._goLocked = true;
            const go = this.menu.querySelector('#preset-go');
            if (go) go.disabled = true;
            let outcome = null;
            try {
                outcome = await Store.stagePreset(key, appids, this.data.rev[key]);
            } catch (e) {
                this._goLocked = false;
                release(false);
                console.warn('[ILAP] built-in list staging failed:', e);
                this._render();
                return;
            }
            if (outcome && outcome.kind === 'added') {
                // The applet stays as it is: the row flies into its job count,
                // which then counts it.
                this._flyToQueue(row, from).then(() => release(true));
                return;
            }
            release(false);
            this._goLocked = false;
            this.msg = outcome && outcome.kind === 'full' ? t('undo_msg_full') : '';
            await this._refresh();
        }
    }

    window.ILAP_Presets = { create: (root, opts) => new PresetMenu(root, opts), label };

})();
