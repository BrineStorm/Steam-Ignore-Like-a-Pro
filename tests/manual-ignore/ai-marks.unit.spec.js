// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// AiMarks (src/manual-ignore/ai-marks.js) as Node units over a hand-rolled fake
// DOM: how a scan finds each AI game's row, and what that costs on a long list.
// The marks themselves are ai-flag.spec's, in a browser.

function loadAiMarks() {
    const body = { tag: 'body' };
    const sandbox = { window: { ILAP: { ManualIgnore: {} } }, document: { body }, queueMicrotask };
    vm.createContext(sandbox);
    for (const file of ['mark-dom.js', 'ai-marks.js']) {
        vm.runInContext(fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'manual-ignore', file), 'utf8'), sandbox);
    }
    return { AiMarks: sandbox.window.ILAP.ManualIgnore.AiMarks, body };
}

const link = (appid) => ({ getAttribute: (n) => (n === 'href' ? `https://store.steampowered.com/app/${appid}/` : null) });

// A node whose `/app/` links are `links`, counting how often they are asked for.
function node(parentElement, links) {
    const n = { parentElement, calls: 0 };
    n.querySelectorAll = (sel) => {
        if (sel !== 'a[href*="/app/"]') throw new Error('unexpected selector ' + sel);
        n.calls += 1;
        return links;
    };
    return n;
}

// A search page's shape: one result list, a row per game with its capsule and a
// text link to the same game.
function searchPage(body, n) {
    const all = [];
    const list = node(body, all);
    const rows = [];
    for (let i = 0; i < n; i++) {
        const appid = String(1000 + i);
        const own = [link(appid), link(appid)];
        all.push(...own);
        const row = node(list, own);
        rows.push({ appid, row, host: node(row, [own[0]]) });
    }
    return { list, rows };
}

const marksWith = (AiMarks) => new AiMarks({ findContainer() {}, coverOf() {} }, { watch() {}, hide() {} });

test.describe('The marks\' classes check what they are given (unit)', () => {
    // A wiring slip fails at boot, not at the first mark.
    test('AiMarks, and ui.js: DuplicateDetector, SteamFlagTint, FloatTip', () => {
        const { AiMarks } = loadAiMarks();
        const strategies = { findContainer() {}, coverOf() {} };
        const tips = { watch() {}, hide() {} };
        expect(() => new AiMarks(strategies, tips)).not.toThrow();
        expect(() => new AiMarks(undefined, tips)).toThrow(/AiMarks needs strategies/);
        expect(() => new AiMarks({ findContainer() {} }, tips)).toThrow(/AiMarks needs strategies/);
        expect(() => new AiMarks(strategies)).toThrow(/AiMarks needs tips/);

        const sandbox = { window: { ILAP: { ManualIgnore: {}, Sanitizer: {}, t: () => '' } } };
        vm.createContext(sandbox);
        for (const file of ['mark-dom.js', 'ui.js']) {
            vm.runInContext(fs.readFileSync(
                path.join(__dirname, '..', '..', 'src', 'manual-ignore', file), 'utf8'), sandbox);
        }
        const MI = sandbox.window.ILAP.ManualIgnore;
        expect(() => new MI.DuplicateDetector({ hasBadgeInAncestors() {} })).not.toThrow();
        expect(() => new MI.DuplicateDetector()).toThrow(/DuplicateDetector needs a scanner/);
        expect(() => new MI.SteamFlagTint(tips)).not.toThrow();
        expect(() => new MI.SteamFlagTint({ watch() {} })).toThrow(/SteamFlagTint needs tips/);
        expect(() => new MI.FloatTip({ getIconUrl() {} })).not.toThrow();
        expect(() => new MI.FloatTip()).toThrow(/FloatTip needs resources/);
    });
});

test.describe('AiMarks — the row of a game (unit)', () => {
    test('one scan reads the result list once, however many games are in it', () => {
        const { AiMarks, body } = loadAiMarks();
        const { list, rows } = searchPage(body, 200);
        const marks = marksWith(AiMarks);
        for (const r of rows) expect(marks._rowOf(r.host, r.appid)).toBe(r.row);
        expect(list.calls).toBe(1);
    });

    test('the next scan reads it again: the page may have changed since', async () => {
        const { AiMarks, body } = loadAiMarks();
        const { list, rows } = searchPage(body, 3);
        const marks = marksWith(AiMarks);
        marks._rowOf(rows[0].host, rows[0].appid);
        await new Promise(r => setTimeout(r, 0));
        marks._rowOf(rows[1].host, rows[1].appid);
        expect(list.calls).toBe(2);
    });

    test('a block whose links all go to the game is its row, one with another game is not', () => {
        const { AiMarks, body } = loadAiMarks();
        const marks = marksWith(AiMarks);
        // A curator review: the capsule and a text link over the whole review.
        const review = node(body, [link('7'), link('7')]);
        const capsule = node(review, [link('7')]);
        expect(marks._rowOf(capsule, '7')).toBe(review);
        // The same block asked for another game in the same run: not its row.
        const stray = node(review, []);
        expect(marks._rowOf(stray, '8')).toBe(null);
    });
});
