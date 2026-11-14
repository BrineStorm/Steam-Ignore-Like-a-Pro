// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The browsing switch's shot (src/manual-ignore/shot.js) as a Node unit: which
// style each capsule gets and which part of it the shot needs in view. The
// drawing itself is the E2E spec's (ai-browse.spec.js).

function loadModule() {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'manual-ignore', 'shot.js'), 'utf8');
    const sandbox = { window: { ILAP: { ManualIgnore: {} } }, Math };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.ManualIgnore;
}

const POOL = ['\u{1F44E}', '\u{1F4A9}', '\u{1F921}', '\u{1F480}', '\u{1F40C}'];

function animator(style, reduce = false) {
    const { ShotAnimator } = loadModule();
    const state = { style, shots: 0 };
    const shots = new ShotAnimator({
        style: () => state.style, emoji: () => '\u{1F44E}', emojiPool: () => POOL,
        countShot: () => ++state.shots, reduceMotion: () => reduce, target: (l) => l,
    });
    return { shots, state };
}

const noRepeat = (xs) => xs.every((x, i) => i === 0 || x !== xs[i - 1]);

const inside = (r, w, h) => r.left >= 0 && r.top >= 0 && r.right <= w && r.bottom <= h;

test.describe('ManualIgnore — the count of games shot (unit)', () => {
    function counter(stored) {
        const data = { n: stored };
        const sandbox = { window: { ILAP: { ManualIgnore: {} } }, Math, Number,
            chrome: { runtime: {}, storage: { local: {
                get: (k, cb) => cb({ [k]: data[k] }),
                set: (o, cb) => { Object.assign(data, o); cb(); },
            } } } };
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'manual-ignore', 'shot.js'), 'utf8'), sandbox);
        return { c: new sandbox.window.ILAP.ManualIgnore.ShotCounter('n'), data };
    }

    test('it goes on from what is stored, and every shot is written', () => {
        const { c, data } = counter(66);
        c.load();
        expect(c.next()).toBe(67);
        expect(data.n).toBe(67);
    });

    test('another tab moves it forward, never back, and junk moves it nowhere', () => {
        const { c } = counter(undefined);
        c.load();
        c.see(10);
        c.see(3);
        c.see('x');
        expect(c.next()).toBe(11);
    });
});

test.describe('ManualIgnore — the shot (unit)', () => {
    test('random deals each capsule its own style: four capsules get the four styles, none twice in a row', () => {
        const { shots } = animator('random');
        const all = [];
        for (let round = 0; round < 6; round++) {
            const styles = [{}, {}, {}, {}].map(el => shots.plan(el).style);
            expect([...styles].sort()).toEqual(['ai', 'emoji', 'swipe', 'tomato']);
            all.push(...styles);
        }
        expect(noRepeat(all)).toBe(true);
    });

    test('random\'s emoji is any of the pool, each once a round and none twice in a row; a picked style has none of its own', () => {
        const { shots, state } = animator('random');
        const dealt = [];
        while (dealt.length < POOL.length * 4) {
            const p = shots.plan({});
            if (p.style === 'emoji') dealt.push(p.emoji);
            else expect(p.emoji).toBe(null);
        }
        for (let round = 0; round < 4; round++) {
            expect(dealt.slice(round * POOL.length, (round + 1) * POOL.length).sort()).toEqual([...POOL].sort());
        }
        expect(noRepeat(dealt)).toBe(true);
        state.style = 'emoji';
        expect(shots.plan({}).emoji).toBe(null);
    });

    test('every 67th game shot is the 67, whatever the style; a game with nothing to shoot is not counted', () => {
        const { shots, state } = animator('swipe');
        const fired = [];
        shots._capsules = (links) => links;
        shots._fire = (el, delay, landed, sixSeven) => { fired.push(sixSeven); landed(); };
        shots.shoot([], 0, () => {});
        for (let i = 0; i < 134; i++) shots.shoot([{}], 0, () => {});
        expect(state.shots).toBe(134);
        expect(fired.map((x, i) => (x ? i + 1 : 0)).filter(Boolean)).toEqual([67, 134]);
    });

    test('a capsule keeps its shot until the droplist changes', () => {
        const { shots, state } = animator('random');
        const el = {};
        const first = shots.plan(el);
        expect(shots.plan(el)).toBe(first);
        state.style = 'swipe';
        expect(shots.plan(el).style).toBe('swipe');
        state.style = 'emoji';
        expect(shots.plan(el).style).toBe('emoji');
    });

    test('the red swipe fits a search row and a small bundle capsule, slant and head included', () => {
        const { shotRegion } = loadModule();
        for (const [w, h] of [[120, 45], [184, 69], [231, 87], [460, 215]]) {
            const r = shotRegion({ style: 'swipe' }, w, h);
            expect(inside(r, w, h), `${w}×${h}`).toBe(true);
            // A band across the middle, not the whole capsule.
            expect(r.bottom - r.top, `${w}×${h}`).toBeLessThan(h * 0.8);
            expect(Math.abs((r.top + r.bottom) / 2 - h / 2)).toBeLessThan(1);
        }
    });

    test('a tomato splat and the juice running down from it stay inside the capsule wherever it lands', () => {
        const { shotRegion } = loadModule();
        for (const [fx, fy] of [[0, 0], [0.12, 0.12], [-0.12, -0.12]]) {
            for (const [w, h] of [[120, 45], [184, 69], [231, 87], [460, 215]]) {
                const r = shotRegion({ style: 'tomato', fx, fy }, w, h);
                expect(inside(r, w, h), `${w}×${h} ${fx}`).toBe(true);
                // The juice runs down to near the capsule's foot, so the
                // shot waits for that part to be in view too.
                expect(r.bottom, `${w}×${h} ${fx}`).toBeGreaterThan(h * 0.85);
                expect(r.right - r.left).toBeLessThan(w);
            }
        }
    });

    test('with the animation off there is no shot: half the capsule in view is enough, the badge lands at once', () => {
        const { shots } = animator('tomato', true);
        expect(shots.need({}, 184, 68)).toEqual({ left: 0, top: 17, right: 184, bottom: 51 });
        let hits = 0;
        shots.shoot([{}], 0, () => hits++);
        expect(hits).toBe(1);
    });

    test('a stamp needs the middle and the ring round it; under reduced motion half the capsule is enough', () => {
        const { shotRegion } = loadModule();
        for (const style of ['emoji', 'ai', '67']) {
            for (const [w, h] of [[120, 45], [184, 69], [616, 353]]) {
                const r = shotRegion({ style }, w, h);
                expect(inside(r, w, h), `${style} ${w}×${h}`).toBe(true);
                // Centred on the capsule, where the tomato lands.
                expect(Math.abs((r.left + r.right) / 2 - w / 2), `${style} ${w}×${h}`).toBeLessThan(1);
                expect(Math.abs((r.top + r.bottom) / 2 - h / 2), `${style} ${w}×${h}`).toBeLessThan(1);
                // The middle, not the whole capsule: its flight is over the window.
                expect(r.right - r.left).toBeLessThan(w * 0.6);
            }
        }
        const { shots } = animator('emoji', true);
        expect(shots.need({}, 184, 68)).toEqual({ left: 0, top: 17, right: 184, bottom: 51 });
    });

    test('every style waits for the 67\'s part as well, since the 67 may take its place', () => {
        const { shotRegion } = loadModule();
        for (const style of ['emoji', 'ai', 'swipe', 'tomato']) {
            const { shots } = animator(style);
            for (const [w, h] of [[120, 45], [184, 69], [616, 353]]) {
                const el = {};
                const need = shots.need(el, w, h);
                for (const r of [shotRegion(shots.plan(el), w, h), shotRegion({ style: '67' }, w, h)]) {
                    expect(need.left <= r.left && need.top <= r.top && need.right >= r.right && need.bottom >= r.bottom,
                        `${style} ${w}×${h}`).toBe(true);
                }
            }
        }
    });

    test('a missing hook fails at construction', () => {
        const { ShotAnimator } = loadModule();
        const deps = {
            style: () => 'swipe', emoji: () => '\u{1F44E}', emojiPool: () => POOL, countShot: () => 1,
            reduceMotion: () => false, target: (l) => l,
        };
        expect(() => new ShotAnimator(deps)).not.toThrow();
        for (const fn of Object.keys(deps)) {
            expect(() => new ShotAnimator({ ...deps, [fn]: undefined }), fn).toThrow('ShotAnimator needs deps.' + fn);
        }
    });
});
