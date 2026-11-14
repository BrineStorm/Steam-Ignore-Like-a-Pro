// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.ManualIgnore = window.ILAP.ManualIgnore || {};

    // The shot a game gets when the browsing switch ignores it (ai-browse.js),
    // then the IGNORED badge, the crossed-out AI mark and the blur, all
    // MARK_DELAY_MS after the shot lands. Styles (Settings.SHOTS): a tomato
    // thrown in over the whole window that splats on the capsule, its juice
    // running down for about a second; a rank stamp (the thumbs
    // down, the crossed-out AI mark or the 67) that comes in the same way and
    // slams into the capsule's middle; or the site's red swipe
    // across it. 'random' gives each capsule its own, and an emoji of its own
    // when it deals the emoji. The 67 is no style to pick: every
    // SHOT_67_EVERY-th game shot gets it, whatever the style.
    // Every mark stays a moment after it lands, then fades. A splat or a
    // stamp landing gives the capsule a small shake. The 67 lands harder: the
    // capsule cracks from the spot, a flash bursts there, shards fly off and
    // the shake is bigger.
    //
    // Drawn on a layer inside the capsule itself, which takes no pointer and
    // clips to the capsule: a mark moves with the page and is never drawn
    // outside its capsule. Only the flight of a stamp or the tomato is drawn
    // over the window,
    // on a fixed layer that takes no pointer either and follows the capsule
    // if the page scrolls. Which part of the capsule a shot needs in view
    // before it starts is `region` (AiViewport waits for it).

    const LAYER_CLASS = 'ilap-shot-layer';
    const SKY_CLASS = 'ilap-shot-sky';
    // What 'random' deals.
    const STYLES = ['tomato', 'emoji', 'ai', 'swipe'];
    // The 67 takes the place of every this-many-th shot (shoot).
    const SHOT_67_EVERY = 67;
    // A stamp's class suffix and its text. The emoji is the one picked in the
    // AI tab (deps.emoji) or the one 'random' dealt, drawn by the system's own
    // emoji font, the AI mark is an image (styles.css).
    const STAMPS = {
        emoji: { kind: 'emoji', glyph: null },
        ai: { kind: 'aimark', glyph: '' },
        67: { kind: 'sixseven', glyph: '67' },
    };
    // How long a mark stays after it lands, then how long it takes to go.
    const LINGER_MS = 1200;
    const FADE_MS = 400;
    // From a shot's landing to its badge and blur.
    const MARK_DELAY_MS = 300;
    // The splat bursts out, then the juice runs down.
    const SPLAT_MS = 140;
    const DRIP_MS = 1000;
    const ZOOM_MS = 560;
    const SETTLE_MS = 180;
    const RING_MS = 380;
    const SHAKE_MS = 280;
    // The flight: as tall as the window at the start, all but unseen
    // then, three quarters seen once it is as tall as the capsule, whole when
    // it lands. In keyframes, this many.
    const FLY_STEPS = 24;
    const GHOST = 0.08;
    const AT_CAPSULE = 0.75;
    // The tomato is a solid fill, so it starts paler and stays faint longer
    // (its opacity rises on a square), and keeps out of the way of browsing.
    const TOMATO_GHOST = 0.03;
    const TOMATO_RAMP = 2;
    const SWIPE_MS = 550;
    // Shots fired by one batch (the AI games one load or scroll brings into
    // view together) start one after another, this far apart, up to
    // STAGGER_MAX of them, so each one is seen landing.
    const STAGGER_MS = 300;
    const STAGGER_MAX = 12;
    // A capsule smaller than this is a text link, which has no art to shoot.
    const MIN_SIDE = 24;
    // How far from its spot a tomato may land, of the capsule's size.
    const SPLAT_JITTER = 0.12;
    // How much of the splat's red edges is bent round its corners.
    const SPLAT_ROUND = 0.3;
    // The round drops the splat throws out: how many at least, how far at
    // most from its centre, of its size, and how long they fly.
    const SPLASH_MIN = 6;
    const SPLASH_REACH = 0.72;
    const SPLASH_MS = 220;
    // A thrown tomato tumbles: its turn at the start of the flight, in degrees.
    const TOMATO_SPIN = -420;
    // The red swipe's slant.
    const SWIPE_DEG = 7;
    // The 67's landing (_crack): its cracks shoot out over CRACK_MS, the web
    // between them after, the flash and the shards go in their own time, and
    // the shake is HARD_SHAKE times the size and half again as long.
    const CRACK_MS = 220;
    const FLASH_MS = 320;
    const SHARD_MS = 750;
    const SHARDS = 12;
    const HARD_SHAKE = 3;

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    // A jagged ring as a path: `n` points, each at its own radius between rMin
    // and rMax, so no two splats are alike. `round` of each edge next to a
    // point is bent into a curve round it, which blunts its corner.
    function jag(n, rMin, rMax, round = 0) {
        const pts = [];
        for (let i = 0; i < n; i++) {
            const a = (i + Math.random() * 0.6) / n * Math.PI * 2;
            const r = rMin + Math.random() * (rMax - rMin);
            pts.push([r * Math.cos(a), r * Math.sin(a)]);
        }
        const xy = (p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1);
        const toward = (p, q) => [p[0] + (q[0] - p[0]) * round, p[1] + (q[1] - p[1]) * round];
        let d = '';
        pts.forEach((p, i) => {
            if (!round) { d += (i ? 'L' : 'M') + xy(p); return; }
            const into = toward(p, pts[(i + n - 1) % n]), out = toward(p, pts[(i + 1) % n]);
            d += (i ? 'L' : 'M') + xy(into) + 'Q' + xy(p) + ' ' + xy(out);
        });
        return d + 'Z';
    }

    // A splat: juice thrown out in spikes and drops, the burst pulp on it
    // with a paler core and seeds, and the torn green top fallen to one side,
    // all drawn at random. Gradient ids are per splat: a page shows several at once.
    let splatId = 0;
    function splatSvg() {
        const id = 'ilap-splat-' + (++splatId);
        const at = (r, a) => `${(r * Math.cos(a)).toFixed(1)} ${(r * Math.sin(a)).toFixed(1)}`;
        let drops = '';
        for (let i = 0, n = 5 + Math.floor(Math.random() * 4); i < n; i++) {
            const [cx, cy] = at(34 + Math.random() * 13, Math.random() * Math.PI * 2).split(' ');
            drops += `<circle cx="${cx}" cy="${cy}" r="${(1.6 + Math.random() * 2.6).toFixed(1)}"/>`;
        }
        let seeds = '';
        for (let i = 0, n = 4 + Math.floor(Math.random() * 3); i < n; i++) {
            const [cx, cy] = at(4 + Math.random() * 14, Math.random() * Math.PI * 2).split(' ');
            seeds += `<ellipse cx="${cx}" cy="${cy}" rx="2.4" ry="1.4" transform="rotate(${Math.round(Math.random() * 180)} ${cx} ${cy})"/>`;
        }
        const top = at(16 + Math.random() * 10, Math.random() * Math.PI * 2);
        return '<svg viewBox="-50 -50 100 100" aria-hidden="true"><defs>'
            + `<radialGradient id="${id}-f"><stop offset="0" stop-color="#f27a52"/>`
            + '<stop offset=".6" stop-color="#d93a24"/><stop offset="1" stop-color="#b3200f"/></radialGradient></defs>'
            + `<path d="${jag(30, 16, 46, SPLAT_ROUND)}" fill="#a8150c"/>`
            + `<g fill="#b8170e">${drops}</g>`
            + `<path d="${jag(22, 10, 31, SPLAT_ROUND)}" fill="url(#${id}-f)"/>`
            + `<path d="${jag(12, 4, 13)}" fill="#f59a6c" opacity=".8"/>`
            + `<g fill="#f7d36b" opacity=".9">${seeds}</g>`
            + `<path transform="translate(${top}) rotate(${Math.round(Math.random() * 360)})"`
            + ' d="M0-7 2-2 7-3 3 1 5 6 0 3-5 6-3 1-7-3-2-2Z" fill="#3f8f2a" stroke="#24561a" stroke-width=".8" stroke-linejoin="round"/>'
            + '</svg>';
    }

    // The 67's cracks over a w×h capsule, from its spot (cx, cy) out towards
    // the edges, as an SVG in the capsule's pixels. 9 to 12 cracks start at
    // the rim of the dent the stamp makes (`core` is the stamp's size), most
    // run past the edge, the rest stop short, most have a branch, and two
    // rings of a web join neighbouring cracks, sagging towards the spot. Each
    // line is a path of its own, drawn out on its own (pathLength 1). The
    // web's are data-late: they come after the cracks.
    function crackSvg(cx, cy, w, h, core) {
        const xy = (p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1);
        const line = (pts, width, late) => `<path pathLength="1" stroke-width="${width}"${late ? ' data-late=""' : ''}`
            + ` d="M${pts.map(xy).join('L')}"/>`;
        // How far the capsule's edge is from the spot along the angle a.
        const edge = (a) => {
            const dx = Math.cos(a), dy = Math.sin(a);
            const tx = dx > 1e-6 ? (w - cx) / dx : dx < -1e-6 ? -cx / dx : Infinity;
            const ty = dy > 1e-6 ? (h - cy) / dy : dy < -1e-6 ? -cy / dy : Infinity;
            return Math.min(tx, ty);
        };
        const rim = core * 0.4;
        const n = 9 + Math.floor(Math.random() * 4);
        const arms = [];
        let paths = '';
        for (let i = 0; i < n; i++) {
            const a = (i + Math.random() * 0.6) / n * Math.PI * 2;
            const len = Math.max(rim * 1.6, edge(a) * (Math.random() < 0.7 ? 1.05 : 0.5 + Math.random() * 0.35));
            const steps = 4 + Math.floor(Math.random() * 3);
            const pts = [];
            for (let k = 0; k <= steps; k++) {
                const r = rim + (len - rim) * k / steps;
                const b = a + (k ? (Math.random() - 0.5) * 0.22 : 0);
                pts.push([cx + r * Math.cos(b), cy + r * Math.sin(b)]);
            }
            arms.push({ pts, len });
            paths += line(pts, 1.8);
            if (Math.random() < 0.7) {
                const from = pts[1 + Math.floor(Math.random() * (steps - 2))];
                const turn = a + (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.4);
                const bend = turn + (Math.random() - 0.5) * 0.3;
                const bl = (len - rim) * (0.18 + Math.random() * 0.22);
                paths += line([from,
                    [from[0] + bl * 0.5 * Math.cos(bend), from[1] + bl * 0.5 * Math.sin(bend)],
                    [from[0] + bl * Math.cos(turn), from[1] + bl * Math.sin(turn)]], 1.2);
            }
        }
        // A crack's point nearest the distance r from the spot, or null past its end.
        const near = (arm, r) => (r > arm.len ? null
            : arm.pts[Math.round((r - rim) / (arm.len - rim) * (arm.pts.length - 1))]);
        for (const ring of [core * 1.1, core * 2.1]) {
            for (let i = 0; i < n; i++) {
                const p = near(arms[i], ring), q = near(arms[(i + 1) % n], ring * (0.9 + Math.random() * 0.2));
                if (!p || !q) continue;
                const sag = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
                paths += line([p, [sag[0] + (cx - sag[0]) * 0.18, sag[1] + (cy - sag[1]) * 0.18], q], 1, true);
            }
        }
        return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true">${paths}</svg>`;
    }

    // A shard's outline: a triangle of its own in its box.
    const shardShape = () => `polygon(${Math.round(Math.random() * 40)}% 0%, 100% ${20 + Math.round(Math.random() * 50)}%,`
        + ` ${10 + Math.round(Math.random() * 50)}% 100%)`;

    // The part of a w×h capsule a shot draws on, as a box in the capsule's
    // pixels. The capsule must have it all in view before the shot starts,
    // so nothing of it is ever cut off by the window.
    function region(plan, w, h) {
        if (plan.style === 'tomato') return tomatoGeometry(plan, w, h).box;
        if (plan.style === 'swipe') {
            const s = swipeGeometry(w, h);
            return {
                left: Math.max(0, s.left - s.head / 2), right: Math.min(w, s.left + s.width + s.head / 2),
                top: Math.max(0, h / 2 - s.rise / 2 - s.head / 2), bottom: Math.min(h, h / 2 + s.rise / 2 + s.head / 2),
            };
        }
        // A stamp lands in the middle and rings round it there.
        const g = stampGeometry(plan.style, w, h);
        const cx = g.left + g.bw / 2, cy = g.top + g.bh / 2, r = Math.max(g.bw, g.bh) * 0.65;
        return {
            left: Math.max(0, Math.min(g.left, cx - r)), top: Math.max(0, Math.min(g.top, cy - r)),
            right: Math.min(w, Math.max(g.left + g.bw, cx + r)), bottom: Math.min(h, Math.max(g.top + g.bh, cy + r)),
        };
    }

    // The splat's centre and size, a little over the middle and kept clear
    // of the capsule's edges, how far down its juice may run, and the box
    // the splat, its round drops and its juice take in the capsule.
    function tomatoGeometry(plan, w, h) {
        const d = clamp(Math.min(w, h) * 0.6, 22, 90);
        const x = clamp(w * (0.5 + plan.fx), d / 2, w - d / 2);
        const y = clamp(h * (0.42 + plan.fy), d / 2, h - d / 2);
        const bottom = Math.max(y + d / 2, h - Math.max(2, h * 0.06));
        const reach = d * SPLASH_REACH;
        const box = {
            left: Math.max(0, x - reach), top: Math.max(0, y - reach),
            right: Math.min(w, x + reach), bottom: Math.max(bottom, Math.min(h, y + reach)),
        };
        return { x, y, d, bottom, box };
    }

    // The swipe scaled to the capsule: a bundle row or a search row gets a
    // thinner trail with a smaller head, so its slant fits in the capsule.
    function swipeGeometry(w, h) {
        const width = Math.min(w * 0.76, 260);
        const thick = clamp(h * 0.14, 4, 12);
        return {
            width, thick, head: thick * 2.2,
            rise: width * Math.sin(SWIPE_DEG * Math.PI / 180),
            left: (w - width) / 2,
        };
    }

    // The stamp's final box in the middle of the capsule, where the tomato
    // lands too.
    function stampGeometry(style, w, h) {
        const font = clamp(h * 0.42, 14, 46);
        // The AI mark's letters are half its square, so its square is bigger.
        const side = style === 'ai' ? font * 1.8 : font * 1.15;
        const bw = style === '67' ? font * 1.5 : side;
        const bh = side;
        return { font, bw, bh, left: (w - bw) / 2, top: (h - bh) / 2 };
    }

    class ShotAnimator {
        // deps.style() → a Settings.SHOTS value; deps.emoji() → the emoji the
        // 'emoji' stamp draws (Settings.SHOT_EMOJI); deps.emojiPool() → the
        // emoji 'random' deals from (Settings.SHOT_EMOJI); deps.countShot() →
        // counts a game shot and answers its number (1 for the first, across
        // pages and tabs); deps.reduceMotion() → bool; deps.target(link) → the
        // element the badge goes on (the capsule).
        constructor(deps) {
            for (const fn of ['style', 'emoji', 'emojiPool', 'countShot', 'reduceMotion', 'target']) {
                if (typeof deps[fn] !== 'function') throw new TypeError('[ILAP] ShotAnimator needs deps.' + fn);
            }
            this.style = deps.style;
            this.emoji = deps.emoji;
            this.emojiPool = deps.emojiPool;
            this.countShot = deps.countShot;
            this.reduceMotion = deps.reduceMotion;
            this.target = deps.target;
            // Each capsule's shot, picked once, so the wait for it and the
            // shot itself agree: capsule → { picked, style, emoji, fx, fy }.
            this.plans = new WeakMap();
            this.bag = { left: [], last: null };
            this.emojiBag = { left: [], last: null };
        }

        // The capsule's shot under the style picked now. Picked again when the
        // droplist changes.
        plan(el) {
            const picked = this.style();
            let p = this.plans.get(el);
            if (!p || p.picked !== picked) {
                const style = picked === 'random' ? deal(this.bag, STYLES) : picked;
                p = {
                    picked,
                    style,
                    emoji: picked === 'random' && style === 'emoji' ? deal(this.emojiBag, this.emojiPool()) : null,
                    fx: (Math.random() * 2 - 1) * SPLAT_JITTER,
                    fy: (Math.random() * 2 - 1) * SPLAT_JITTER,
                };
                this.plans.set(el, p);
            }
            return p;
        }

        // The box of a w×h capsule its shot needs in view, and the 67's too,
        // which may take the shot's place (shoot). Under reduced motion, or
        // with the animation turned off, there is no shot: half the capsule
        // in view is enough.
        need(el, w, h) {
            if (this.reduceMotion()) return { left: 0, top: h / 4, right: w, bottom: h * 3 / 4 };
            const a = region(this.plan(el), w, h), b = region({ style: '67' }, w, h);
            return {
                left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
                right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom),
            };
        }

        // Shoots every capsule of `links`, the `index`th shot of its batch,
        // and calls `onHit` once, MARK_DELAY_MS after the last one lands (at
        // once when none can be shot, or with no motion).
        // A game with a capsule to shoot is counted, and every SHOT_67_EVERY-th
        // one gets the 67 on all its capsules (need waited for its part too).
        shoot(links, index, onHit) {
            const els = this.reduceMotion() ? [] : this._capsules(links);
            if (!els.length) { onHit(); return; }
            const sixSeven = this.countShot() % SHOT_67_EVERY === 0;
            const delay = Math.min(index, STAGGER_MAX) * STAGGER_MS;
            let left = els.length;
            const landed = () => { if (--left === 0) onHit(); };
            for (const el of els) this._fire(el, delay, landed, sixSeven);
        }

        // Each capsule once, when it is big enough to have art.
        _capsules(links) {
            const out = [];
            for (const link of links) {
                const el = this.target(link);
                if (!el || out.includes(el) || !el.isConnected) continue;
                this._anchor(el);
                if (el.clientWidth < MIN_SIDE || el.clientHeight < MIN_SIDE) continue;
                out.push(el);
            }
            return out;
        }

        // The layer's box is the capsule's, as for the badge (ui.js
        // _ensurePositioning, which the badge then finds done).
        _anchor(el) {
            const cs = getComputedStyle(el);
            if (cs.position === 'static') el.dataset.ilapAnchor = '';
            if (cs.display === 'inline') el.style.display = 'inline-block';
        }

        // The fixed layer over the window the stamps and the tomato fly on.
        _sky() {
            let sky = document.querySelector(':root > .' + SKY_CLASS);
            if (!sky) {
                sky = document.createElement('div');
                sky.className = SKY_CLASS;
                sky.setAttribute('aria-hidden', 'true');
                document.documentElement.appendChild(sky);
            }
            return sky;
        }

        // A small shake of the capsule as a mark lands, `amp` times as big
        // and lasting `ms`. On `translate`, which adds to whatever transform
        // the page gives the capsule.
        _shake(el, at, amp = 1, ms = SHAKE_MS) {
            const step = (x, y) => ({ translate: `${x * amp}px ${y * amp}px` });
            el.animate([
                step(0, 0), step(-1.5, 1), step(1.5, -1), step(-1, 0.5), step(0.5, 0), step(0, 0),
            ], { duration: ms, delay: at, easing: 'linear' });
        }

        _layer(el) {
            let layer = el.querySelector(':scope > .' + LAYER_CLASS);
            if (!layer) {
                layer = document.createElement('div');
                layer.className = LAYER_CLASS;
                layer.setAttribute('aria-hidden', 'true');
                el.appendChild(layer);
            }
            return layer;
        }

        // A mark on the capsule's layer, gone (and the layer with its last
        // mark) once its animation ends.
        _add(el, node, anim) {
            const layer = this._layer(el);
            layer.appendChild(node);
            anim(node).finished.then(() => {
                node.remove();
                if (!layer.childElementCount) layer.remove();
            }, () => {});
        }

        _fire(el, delay, landed, sixSeven) {
            const plan = this.plan(el);
            const w = el.clientWidth, h = el.clientHeight;
            let landAt;
            if (sixSeven) landAt = this._stamp(el, '67', w, h, delay);
            else if (plan.style === 'tomato') landAt = this._tomato(el, plan, w, h, delay);
            else if (plan.style === 'swipe') landAt = this._swipe(el, w, h, delay);
            else landAt = this._stamp(el, plan.style, w, h, delay, plan.emoji);
            setTimeout(landed, delay + landAt + MARK_DELAY_MS);
        }

        // The tomato flies in like a stamp, tumbling, and splats. The splat
        // bursts out throwing round drops round it, the capsule shakes, and
        // juice runs down from it in a few drips of their own length and pace,
        // then the lot stays a moment and fades. It lands at the splat.
        _tomato(el, plan, w, h, delay) {
            const { x, y, d, bottom, box } = tomatoGeometry(plan, w, h);
            const t = d * 0.55;
            this._fly(el, { left: x - t / 2, top: y - t / 2, bw: t, bh: t }, 'tomato', '', h, delay, TOMATO_SPIN, 0,
                TOMATO_GHOST, TOMATO_RAMP);
            const hit = delay + ZOOM_MS;
            const runAt = SPLAT_MS * 0.5;
            const total = runAt + DRIP_MS + LINGER_MS + FADE_MS;
            const gone = (runAt + DRIP_MS + LINGER_MS) / total;
            const fade = [{ offset: 0, opacity: 1 }, { offset: gone, opacity: 1 }, { offset: 1, opacity: 0 }];

            // The drips go under the splat, so each starts inside it. Each is
            // a clipped box whose bar slides down into it, so its round end
            // leads the way.
            const bar = clamp(d * 0.09, 3, 8);
            const from = y + d * 0.18;
            const room = Math.max(0, bottom - from - bar * 0.8);
            const n = 3 + Math.floor(Math.random() * 3);
            for (let i = 0; i < n; i++) {
                const len = room * (0.25 + Math.random() * 0.75);
                const dx = x + (i / (n - 1) - 0.5) * d * 0.4 + (Math.random() - 0.5) * d * 0.08;
                const wide = bar * (0.55 + Math.random() * 0.45);
                const drip = document.createElement('div');
                drip.className = 'ilap-shot ilap-shot-drip';
                place(drip, dx - wide * 0.8, from, wide * 1.6, len + wide * 0.8);
                drip.style.setProperty('--w', wide + 'px');
                drip.innerHTML = '<i></i>';
                const pace = DRIP_MS * (0.75 + Math.random() * 0.25);
                this._add(el, drip, (node) => {
                    // Out of sight above its box, round end and all, until the splat.
                    node.firstChild.animate([{ transform: `translateY(${-(len + wide * 1.6)}px)` }, { transform: 'translateY(0)' }],
                        { duration: pace, delay: hit + runAt, easing: 'cubic-bezier(.25, .6, .35, 1)', fill: 'both' });
                    return node.animate(fade, { duration: total, delay: hit, fill: 'both' });
                });
            }

            // The round drops fly out of the splat's middle as it bursts and
            // stay where they fall, inside the shot's box.
            const flyFrom = SPLAT_MS * 0.3 / total, flyTo = (SPLAT_MS * 0.3 + SPLASH_MS) / total;
            for (let i = 0, n = SPLASH_MIN + Math.floor(Math.random() * 4); i < n; i++) {
                const s = d * (0.05 + Math.random() * 0.06);
                const a = (i + Math.random() * 0.7) / n * Math.PI * 2;
                const r = d * (0.42 + Math.random() * (SPLASH_REACH - 0.42));
                const sx = clamp(x + r * Math.cos(a), box.left + s / 2, box.right - s / 2);
                const sy = clamp(y + r * Math.sin(a), box.top + s / 2, box.bottom - s / 2);
                const back = `translate(${x - sx}px, ${y - sy}px) scale(.3)`;
                const drop = document.createElement('div');
                drop.className = 'ilap-shot ilap-shot-splash';
                place(drop, sx - s / 2, sy - s / 2, s, s);
                this._add(el, drop, (node) => node.animate([
                    { offset: 0, transform: back, opacity: 0 },
                    { offset: flyFrom, transform: back, opacity: 1, easing: 'cubic-bezier(.2, .7, .3, 1)' },
                    { offset: flyTo, transform: 'none', opacity: 1 },
                    { offset: gone, transform: 'none', opacity: 1 },
                    { offset: 1, transform: 'none', opacity: 0 },
                ], { duration: total, delay: hit, fill: 'both' }));
            }

            const splat = document.createElement('div');
            splat.className = 'ilap-shot ilap-shot-tomato';
            place(splat, x - d / 2, y - d / 2, d, d);
            splat.innerHTML = splatSvg();
            // Each splat turned its own way, so a volley is no row of copies.
            const turn = `rotate(${Math.round(Math.random() * 360)}deg)`;
            this._add(el, splat, (node) => node.animate([
                { offset: 0, transform: `${turn} scale(.3)`, opacity: 0 },
                { offset: SPLAT_MS * 0.6 / total, transform: `${turn} scale(1.12)`, opacity: 1 },
                { offset: SPLAT_MS / total, transform: `${turn} scale(1)`, opacity: 1 },
                { offset: gone, transform: `${turn} scale(1)`, opacity: 1 },
                { offset: 1, transform: `${turn} scale(1)`, opacity: 0 },
            ], { duration: total, delay: hit, easing: 'linear', fill: 'both' }));
            this._shake(el, hit);
            return ZOOM_MS;
        }

        // The rank stamp: as tall as the window and all but unseen, it shrinks
        // onto the capsule's middle, three quarters seen once it is
        // as tall as the capsule, takes its colour and lands whole, squashes,
        // overshoots and settles with a ring, like a grade at the end of a
        // level. The flight is on the fixed layer, the landing in the capsule.
        // `emoji`: the one 'random' dealt this capsule, else the picked one.
        _stamp(el, style, w, h, delay, emoji) {
            const g = stampGeometry(style, w, h);
            const kind = STAMPS[style].kind;
            const glyph = STAMPS[style].glyph === null ? (emoji || this.emoji()) : STAMPS[style].glyph;
            this._fly(el, g, kind, glyph, h, delay, -22, -8);
            // Under the stamp, which lands on its cracks.
            if (style === '67') this._crack(el, g, w, h, delay + ZOOM_MS);

            const node = document.createElement('div');
            node.className = 'ilap-shot ilap-shot-stamp ilap-shot-' + kind;
            node.textContent = glyph;
            place(node, g.left, g.top, g.bw, g.bh);
            node.style.fontSize = g.font + 'px';
            // Unseen until the flight hands over.
            node.style.opacity = '0';
            const total = SETTLE_MS + LINGER_MS + FADE_MS;
            const at = (ms) => ms / total;
            const tilt = ' rotate(-8deg)';
            this._add(el, node, (n) => n.animate([
                { offset: 0, transform: 'scale(1)' + tilt, opacity: 1 },
                { offset: at(SETTLE_MS * 0.25), transform: 'scale(.86)' + tilt },
                { offset: at(SETTLE_MS * 0.6), transform: 'scale(1.12)' + tilt },
                { offset: at(SETTLE_MS), transform: 'scale(1)' + tilt },
                { offset: at(SETTLE_MS + LINGER_MS), transform: 'scale(1)' + tilt, opacity: 1 },
                { offset: 1, transform: 'scale(1)' + tilt, opacity: 0 },
            ], { duration: total, delay: delay + ZOOM_MS, fill: 'forwards' }));

            const ring = document.createElement('div');
            ring.className = 'ilap-shot-ring';
            const r = Math.max(g.bw, g.bh) * 1.3;
            place(ring, g.left + g.bw / 2 - r / 2, g.top + g.bh / 2 - r / 2, r, r);
            this._add(el, ring, (n) => n.animate([
                { transform: 'scale(.3)', opacity: 0.9 },
                { transform: 'scale(1.8)', opacity: 0 },
            ], { duration: RING_MS, delay: delay + ZOOM_MS, easing: 'ease-out', fill: 'both' }));
            if (style === '67') this._shake(el, delay + ZOOM_MS, HARD_SHAKE, SHAKE_MS * 1.5);
            else this._shake(el, delay + ZOOM_MS);
            return ZOOM_MS;
        }

        // The 67's landing at `at` on its box `g`: the cracks (crackSvg) shoot
        // out from the spot and stay with the stamp, then fade with it, a
        // white flash bursts there, and shards of glass fly off and fall,
        // spinning. Unseen until it lands.
        _crack(el, g, w, h, at) {
            const cx = g.left + g.bw / 2, cy = g.top + g.bh / 2;
            const core = Math.max(g.bw, g.bh);
            const total = SETTLE_MS + LINGER_MS + FADE_MS;

            const crack = document.createElement('div');
            crack.className = 'ilap-shot ilap-shot-crack';
            place(crack, 0, 0, w, h);
            crack.innerHTML = crackSvg(cx, cy, w, h, core);
            this._add(el, crack, (node) => {
                for (const p of node.querySelectorAll('path')) {
                    p.animate([{ strokeDashoffset: '1.01' }, { strokeDashoffset: '0' }], {
                        duration: CRACK_MS, delay: at + ('late' in p.dataset ? CRACK_MS * 0.6 : 0),
                        easing: 'cubic-bezier(.1, .8, .25, 1)', fill: 'both',
                    });
                }
                return node.animate([
                    { offset: 0, opacity: 1 },
                    { offset: (SETTLE_MS + LINGER_MS) / total, opacity: 1 },
                    { offset: 1, opacity: 0 },
                ], { duration: total, delay: at, fill: 'both' });
            });

            const flash = document.createElement('div');
            flash.className = 'ilap-shot ilap-shot-flash';
            const f = core * 3;
            place(flash, cx - f / 2, cy - f / 2, f, f);
            this._add(el, flash, (node) => node.animate([
                { offset: 0, transform: 'scale(.2)', opacity: 0 },
                { offset: 0.15, transform: 'scale(.7)', opacity: 1 },
                { offset: 1, transform: 'scale(1.6)', opacity: 0 },
            ], { duration: FLASH_MS, delay: at, easing: 'ease-out', fill: 'both' }));

            for (let i = 0; i < SHARDS; i++) {
                const s = core * (0.1 + Math.random() * 0.14);
                const a = (i + Math.random() * 0.8) / SHARDS * Math.PI * 2;
                const reach = core * (0.9 + Math.random() * 1.3);
                const dx = reach * Math.cos(a), dy = reach * Math.sin(a);
                const fall = core * (0.6 + Math.random() * 0.8);
                const spin = (Math.random() < 0.5 ? -1 : 1) * (180 + Math.random() * 360);
                const shard = document.createElement('div');
                shard.className = 'ilap-shot ilap-shot-shard';
                place(shard, cx + core * 0.35 * Math.cos(a) - s / 2, cy + core * 0.35 * Math.sin(a) - s / 2, s, s * (0.6 + Math.random() * 0.6));
                shard.style.clipPath = shardShape();
                shard.style.opacity = '0';
                this._add(el, shard, (node) => node.animate([
                    { offset: 0, transform: 'translate(0, 0) rotate(0deg) scale(.6)', opacity: 1 },
                    { offset: 0.45, transform: `translate(${dx * 0.8}px, ${dy * 0.8 - core * 0.15}px) rotate(${spin * 0.5}deg) scale(1)`, opacity: 1 },
                    { offset: 1, transform: `translate(${dx}px, ${dy + fall}px) rotate(${spin}deg) scale(.9)`, opacity: 0 },
                ], { duration: SHARD_MS * (0.8 + Math.random() * 0.4), delay: at, easing: 'cubic-bezier(.2, .6, .4, 1)', fill: 'forwards' }));
            }
        }

        // The flight, in window pixels: from the window's centre at the
        // window's height down to the box `g` in the capsule, shrinking at a
        // steady rate on a log scale and turning from `rot0` to `rot1`
        // degrees. Seen as much as `ghost` at the start, its opacity rising
        // on the power `ramp` until it is as tall as the capsule. A wrapper
        // follows the capsule while the page scrolls under the flight.
        _fly(el, g, kind, glyph, h, delay, rot0, rot1, ghost = GHOST, ramp = 1) {
            const cap = el.getBoundingClientRect();
            const sky = this._sky();
            const follow = document.createElement('div');
            follow.className = 'ilap-shot-follow';
            const node = document.createElement('div');
            node.className = 'ilap-shot-stamp ilap-shot-fly ilap-fly-' + kind;
            node.textContent = glyph;
            const fx = cap.left + g.left, fy = cap.top + g.top;
            place(node, fx, fy, g.bw, g.bh);
            node.style.fontSize = g.font + 'px';
            follow.appendChild(node);
            sky.appendChild(follow);

            const vw = window.innerWidth, vh = window.innerHeight;
            const atCap = Math.max(h / g.bh, 1.05);
            const huge = Math.max(vh / g.bh, atCap * 1.5);
            const dx0 = vw / 2 - (fx + g.bw / 2), dy0 = vh / 2 - (fy + g.bh / 2);
            const lnHuge = Math.log(huge), lnCap = Math.log(atCap);
            const frames = [];
            for (let i = 0; i <= FLY_STEPS; i++) {
                const p = i / FLY_STEPS;
                const e = p * p;                       // speeds up into the slam
                const ln = lnHuge * (1 - e);
                const s = Math.exp(ln);
                const seen = ln >= lnCap
                    ? ghost + (AT_CAPSULE - ghost) * ((lnHuge - ln) / (lnHuge - lnCap)) ** ramp
                    : AT_CAPSULE + (1 - AT_CAPSULE) * (lnCap - ln) / lnCap;
                frames.push({
                    offset: p,
                    transform: `translate(${dx0 * (1 - e)}px, ${dy0 * (1 - e)}px) scale(${s}) rotate(${rot0 + (rot1 - rot0) * e}deg)`,
                    opacity: seen,
                    filter: `brightness(${1 + 0.8 * (1 - e)}) saturate(${0.3 + 0.7 * e})`,
                });
            }
            const flight = node.animate(frames, { duration: ZOOM_MS, delay, easing: 'linear', fill: 'both' });
            let raf = 0;
            const track = () => {
                const now = el.getBoundingClientRect();
                follow.style.transform = `translate(${now.left - cap.left}px, ${now.top - cap.top}px)`;
                raf = requestAnimationFrame(track);
            };
            raf = requestAnimationFrame(track);
            // Landed or cancelled, the follower and its frame loop go.
            const gone = () => {
                cancelAnimationFrame(raf);
                follow.remove();
                if (!sky.childElementCount) sky.remove();
            };
            flight.finished.then(gone, gone);
        }

        // The site's red swipe: a trail that grows left to right across the
        // capsule at a slight slant, its glowing head in front, sized to the
        // capsule. It lands as the trail ends.
        _swipe(el, w, h, delay) {
            const s = swipeGeometry(w, h);
            const node = document.createElement('div');
            node.className = 'ilap-shot-swipe';
            // Rotated about its left end: that end sits under the centre line,
            // the right one as far over it.
            place(node, s.left, h / 2 + s.rise / 2 - s.thick / 2, s.width, s.thick);
            node.style.setProperty('--t', s.thick + 'px');
            node.style.transform = `rotate(-${SWIPE_DEG}deg)`;
            node.innerHTML = '<i class="ilap-shot-bar"></i><i class="ilap-shot-head"></i>';
            const ease = 'cubic-bezier(0.3, 0.65, 0.2, 1)';
            const total = SWIPE_MS + LINGER_MS + FADE_MS;
            this._add(el, node, (n) => {
                n.querySelector('.ilap-shot-bar').animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
                    { duration: SWIPE_MS, delay, easing: ease, fill: 'both' });
                n.querySelector('.ilap-shot-head').animate([
                    { offset: 0, transform: 'translateX(0)', opacity: 0 },
                    { offset: 0.15, opacity: 1 },
                    { offset: 1, transform: `translateX(${s.width}px)`, opacity: 1 },
                ], { duration: SWIPE_MS, delay, easing: ease, fill: 'both' });
                return n.animate([
                    { offset: 0, opacity: 1 },
                    { offset: (SWIPE_MS + LINGER_MS) / total, opacity: 1 },
                    { offset: 1, opacity: 0 },
                ], { duration: total, delay, fill: 'both' });
            });
            return SWIPE_MS;
        }
    }

    // Deals one of `pool` from `bag` ({ left, last }): the pool shuffled,
    // dealt to its end, then shuffled again, so every value comes out once a
    // round and none twice in a row, a new round's first included.
    function deal(bag, pool) {
        if (!bag.left.length) {
            const next = pool.slice();
            for (let i = next.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [next[i], next[j]] = [next[j], next[i]];
            }
            // Dealt from the end: the round's first is not the last one dealt.
            if (next.length > 1 && next[next.length - 1] === bag.last) [next[0], next[next.length - 1]] = [next[next.length - 1], next[0]];
            bag.left = next;
        }
        bag.last = bag.left.pop();
        return bag.last;
    }

    function place(node, left, top, width, height) {
        node.style.left = left + 'px';
        node.style.top = top + 'px';
        node.style.width = width + 'px';
        node.style.height = height + 'px';
    }

    // The games the switch has shot, across pages and tabs: every 67th is the 67.
    // Read at boot, kept up by other tabs' writes, written on each shot. Two tabs
    // shooting in one moment may count a game twice or skip one, which only moves
    // the next 67.
    class ShotCounter {
        constructor(key) {
            this.key = key;
            this.count = 0;
        }

        load() {
            chrome.storage.local.get(this.key, (d) => {
                if (!chrome.runtime.lastError) this.see(d[this.key]);
            });
        }

        see(value) {
            const n = Number(value);
            if (Number.isInteger(n) && n > this.count) this.count = n;
        }

        next() {
            this.count += 1;
            try {
                chrome.storage.local.set({ [this.key]: this.count }, () => void chrome.runtime.lastError);
            } catch (e) { /* no storage left in this tab (an extension update) */ }
            return this.count;
        }
    }

    window.ILAP.ManualIgnore.ShotAnimator = ShotAnimator;
    window.ILAP.ManualIgnore.ShotCounter = ShotCounter;
    window.ILAP.ManualIgnore.shotRegion = region;
})();
