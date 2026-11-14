// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The rule the extension runs for which AI games count (presets.js ILAP.aiGames).
const presets = { window: {} };
vm.createContext(presets);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'presets.js'), 'utf8'), presets);
const aiGames = presets.window.ILAP.aiGames;
const aiKinds = presets.window.ILAP.aiKinds;

// AiVerdict (src/explore-queue/utils.js): which Classic Discovery Queue games
// the Queue Helper ignores for their AI on the AI tab's HIGH level, and
// QueueContext.getAiDisclosure, the page read behind it. Node unit, the page
// is a stub and the word rules are the real src/ai-disclosure.js.
const src = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', ...p), 'utf8');

function loadExplore(document) {
    const sandbox = { window: {}, document };
    vm.createContext(sandbox);
    vm.runInContext(src('queue-common', 'steam-palette.js'), sandbox);
    vm.runInContext(src('ai-disclosure.js'), sandbox);
    vm.runInContext(src('explore-queue', 'utils.js'), sandbox);
    return sandbox.window.ILAP;
}

const DATA = {
    ai: { 2025: [10, 20, 30], tba: [40] },
    aikeep: { translation: [20], ingame: [30] },
};
const KEEP_BOTH = { translation: true, ingame: true };
const KEEP_NONE = { translation: false, ingame: false };

function verdict({ high = true, keep = KEEP_BOTH, text = '', data = DATA } = {}) {
    const ILAP = loadExplore({});
    const reads = { data: 0 };
    const v = new ILAP.Explore.AiVerdict({
        readOptions: async () => ({ high, keep }),
        aiGames: async (k) => { reads.data++; return aiGames(data, k); },
        disclosure: () => text,
        nameOf: () => 'Race or Crash',
        rules: ILAP.AiDisclosure,
    });
    return { v, reads };
}

test.describe('Classic DQ — AiVerdict (unit)', () => {
    test('below HIGH no game counts, and the lists are not read', async () => {
        const { v, reads } = verdict({ high: false, text: 'Art was made with AI.' });
        expect(await v.isAi('10')).toBe(false);
        expect(reads.data).toBe(0);
    });

    test('a listed game counts with no disclosure on its page', async () => {
        const { v } = verdict();
        expect(await v.isAi('10')).toBe(true);
        expect(await v.isAi('40')).toBe(true);
    });

    test("a listed game is kept by the lists' verdicts when its box is ticked", async () => {
        expect(await verdict().v.isAi('20')).toBe(false);
        expect(await verdict().v.isAi('30')).toBe(false);
        expect(await verdict({ keep: KEEP_NONE }).v.isAi('20')).toBe(true);
        expect(await verdict({ keep: { translation: true, ingame: false } }).v.isAi('30')).toBe(true);
    });

    test('a game newer than the lists counts by its page', async () => {
        expect(await verdict({ text: 'Some of the background art was generated with AI.' }).v.isAi('99')).toBe(true);
        expect(await verdict({ text: '' }).v.isAi('99')).toBe(false);
    });

    test('the word rules keep a game newer than the lists, box by box', async () => {
        const tr = "Artificial intelligence has been used in order to translate Race or Crash's page on Steam.";
        expect(await verdict({ text: tr }).v.isAi('99')).toBe(false);
        expect(await verdict({ text: tr, keep: KEEP_NONE }).v.isAi('99')).toBe(true);
        const live = 'Characters respond in real time with AI-generated dialogue powered by a large language model.';
        expect(await verdict({ text: live }).v.isAi('99')).toBe(false);
        expect(await verdict({ text: live, keep: { translation: true, ingame: false } }).v.isAi('99')).toBe(true);
    });

    test('a missing dependency fails at construction', () => {
        const ILAP = loadExplore({});
        const deps = {
            readOptions: async () => ({}), aiGames: async () => new Set(), disclosure: () => '',
            nameOf: () => '', rules: ILAP.AiDisclosure,
        };
        expect(() => new ILAP.Explore.AiVerdict(deps)).not.toThrow();
        for (const key of Object.keys(deps)) {
            expect(() => new ILAP.Explore.AiVerdict({ ...deps, [key]: undefined }), key).toThrow('AiVerdict needs deps.' + key);
        }
        expect(() => new ILAP.Explore.AiVerdict({ ...deps, rules: { liveAI() {} } })).toThrow('AiVerdict needs deps.rules');
    });
});

test.describe('The AI games rule — presets.js aiGames (unit)', () => {
    // One rule behind the lists' +, the browsing level and the Classic DQ.
    test('every listed AI game, less the kept kinds the boxes tick', () => {
        expect([...aiGames(DATA, {})].sort()).toEqual([10, 20, 30, 40]);
        expect([...aiGames(DATA, KEEP_NONE)].sort()).toEqual([10, 20, 30, 40]);
        expect([...aiGames(DATA, { translation: true })].sort()).toEqual([10, 30, 40]);
        expect([...aiGames(DATA, { ingame: true })].sort()).toEqual([10, 20, 40]);
        expect([...aiGames(DATA, KEEP_BOTH)].sort()).toEqual([10, 40]);
    });

    test('a game kept and listed in two years is out of both', () => {
        const data = { ai: { 2024: [5, 6], 2025: [6, 7] }, aikeep: { translation: [6], ingame: [] } };
        expect([...aiGames(data, { translation: true })].sort()).toEqual([5, 7]);
    });

    test('only true ticks a box, and no aikeep keeps nothing', () => {
        expect(aiGames(DATA, { translation: 'yes', ingame: 1 }).size).toBe(4);
        expect(aiGames({ ai: { 2025: [1] } }, KEEP_BOTH).has(1)).toBe(true);
        expect(aiGames({}, KEEP_BOTH).size).toBe(0);
    });

    test('built once per data object and boxes', () => {
        expect(aiGames(DATA, KEEP_BOTH)).toBe(aiGames(DATA, { ingame: true, translation: true }));
        expect(aiGames(DATA, KEEP_BOTH)).not.toBe(aiGames({ ...DATA }, KEEP_BOTH));
    });

    // The kind a game's AI flag names (aikeep): in-game wins over translation.
    test('aiKinds: the kind of AI use per game, in-game over translation, none for the rest', () => {
        const data = { ai: { 2025: [1, 2, 3, 4] }, aikeep: { translation: [2, '3'], ingame: [3, 4] } };
        const kinds = aiKinds(data);
        expect(kinds.get(1)).toBeUndefined();
        expect(kinds.get(2)).toBe('translation');
        expect(kinds.get(3)).toBe('ingame');
        expect(kinds.get(4)).toBe('ingame');
        expect(aiKinds(data)).toBe(kinds);              // built once per data
        expect(aiKinds({ ai: {} }).size).toBe(0);
        expect(aiKinds(null).size).toBe(0);
    });

    // A hand pick (aimanual) has no disclosure, so its page note says it was marked by hand.
    test('aiKinds: a game the lists mark by hand is manual', () => {
        const kinds = aiKinds({ ai: { 2026: [5, 6, 7] }, aimanual: [5, '6'] });
        expect(kinds.get(5)).toBe('manual');
        expect(kinds.get(6)).toBe('manual');
        expect(kinds.get(7)).toBeUndefined();
    });

    // The removed text's kind gives way: the game's page note says what happened to it.
    test('aiKinds: a game whose disclosure was removed is removed, whatever the text said', () => {
        const kinds = aiKinds({ ai: { 2026: [5, 6, 7, 8] }, aikeep: { translation: [5], ingame: [6] }, airemoved: [5, 6, '7'] });
        expect(kinds.get(5)).toBe('removed');
        expect(kinds.get(6)).toBe('removed');
        expect(kinds.get(7)).toBe('removed');
        expect(kinds.get(8)).toBeUndefined();
    });
});

test.describe('Classic DQ — the page disclosure read (unit)', () => {
    // A #game_area_content_descriptors block: its heading and its italic text.
    const block = (heading, text) => ({
        querySelector: (sel) => {
            if (sel === 'h2') return heading === null ? null : { textContent: `\n\t\t\t${heading}\n` };
            if (sel === 'i') return text === null ? null : { textContent: `\n\t\t\t${text}\t\t\t\t` };
            return null;
        },
    });
    const read = (...blocks) => loadExplore({ querySelectorAll: () => blocks }).Explore.Context.getAiDisclosure();

    test("the AI block's text, in English and in another store language", () => {
        expect(read(block('AI Generated Content Disclosure', 'Art made with AI.'))).toBe('Art made with AI.');
        expect(read(block('Информация об ИИ-контенте', 'Art made with AI.'))).toBe('Art made with AI.');
    });

    test('the Mature Content Description of the same id is no disclosure', () => {
        expect(read(block('Mature Content Description', 'Violence.'))).toBe('');
        expect(read(block('Описание контента для взрослых', 'Violence.'))).toBe('');
    });

    test('a game with both blocks gives the AI one', () => {
        expect(read(block('Mature Content Description', 'Violence.'),
            block('AI Generated Content Disclosure', 'Voices made with AI.'))).toBe('Voices made with AI.');
    });

    test('fromPage gives the AI block itself, its heading and its text, or null', () => {
        const ILAP = loadExplore({});
        const ai = block('AI Generated Content Disclosure', 'Art made with AI.');
        const found = ILAP.AiDisclosure.fromPage({ querySelectorAll: () => [block('Mature Content Description', 'x'), ai] });
        expect(found.block).toBe(ai);
        expect(found.heading).toBe('AI Generated Content Disclosure');
        expect(found.text).toBe('Art made with AI.');
        expect(ILAP.AiDisclosure.fromPage({ querySelectorAll: () => [] })).toBe(null);
        expect(ILAP.AiDisclosure.fromPage({ querySelectorAll: () => [block('AI Generated Content Disclosure', null)] }).text).toBe('');
    });

    test('no block, or an AI block with no text, is no disclosure', () => {
        expect(read()).toBe('');
        expect(read(block('AI Generated Content Disclosure', null))).toBe('');
        expect(read(block('AI Generated Content Disclosure', '   '))).toBe('');
    });
});
