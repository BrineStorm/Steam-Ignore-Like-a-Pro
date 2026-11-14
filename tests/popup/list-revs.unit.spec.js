const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// What a built-in list's + queues and when the list counts as done
// (ui/popup_presets.js), as the AI tab's boxes move. The drawer itself runs live
// in tests/popup/presets.spec.js.

const ROOT = path.join(__dirname, '..', '..');

function loadPanes(over) {
    const sandbox = { window: { ILAP: { t: (key) => key, i18n: { getLang: () => 'en' } } } };
    vm.createContext(sandbox);
    const run = (file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox);
    run('src/escape.js');
    run('ui/popup_presets.js');
    const root = { getElementById: () => null, querySelector: () => null, addEventListener: () => {} };
    const panes = sandbox.window.ILAP_Presets.create(root, Object.assign({
        holdCount: () => () => {},
        store: { getQueue: async () => [] },
        marks: { presetMarks: async () => ({ blocked: new Set(), updated: new Set() }) },
        loadPresets: async () => DATA,
        // The kept games leave the list: 2 is translation-only, 3 in-game-only.
        aiGames: (data, keep) => new Set([1, 2, 3].filter(a =>
            !(keep.translation && a === 2) && !(keep.ingame && a === 3))),
    }, over));
    return panes;
}

const DATA = {
    ai: { 2026: [1, 2, 3] },
    vr: [10, 20],
    rev: { ai_2026: 'r5', vr: 'r9' },
};

const plain = (v) => JSON.parse(JSON.stringify(v));

test.describe('Built-in lists — what a + queues and when a list counts as done (unit)', () => {
    test('a missing collaborator refuses construction', () => {
        const sandbox = { window: { ILAP: { t: (key) => key } } };
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/escape.js'), 'utf8'), sandbox);
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'ui/popup_presets.js'), 'utf8'), sandbox);
        const root = { getElementById: () => null };
        expect(() => sandbox.window.ILAP_Presets.create(root, { holdCount: () => {} })).toThrow('needs opts.store');
    });

    test('an AI list queues less the games the ticked boxes keep, a whole list all of its own', async () => {
        const panes = loadPanes();
        await panes.refresh();
        expect(plain(panes._appids('ai_2026'))).toEqual([1, 2, 3]);
        expect(plain(panes._appids('vr'))).toEqual([10, 20]);
        panes.keep = { translation: true, ingame: false };
        expect(plain(panes._appids('ai_2026'))).toEqual([1, 3]);
        panes.keep = { translation: true, ingame: true };
        expect(plain(panes._appids('ai_2026'))).toEqual([1]);
        expect(plain(panes._appids('vr'))).toEqual([10, 20]);
    });

    test('an AI list\'s rev says which boxes were ticked, translation first', async () => {
        const panes = loadPanes();
        await panes.refresh();
        expect(panes._rev('ai_2026')).toBe('r5');
        panes.keep = { translation: false, ingame: true };
        expect(panes._rev('ai_2026')).toBe('r5+l');
        panes.keep = { translation: true, ingame: true };
        expect(panes._rev('ai_2026')).toBe('r5+t+l');
        expect(panes._rev('vr')).toBe('r9');
    });

    test('a run with fewer boxes ticked covers today\'s list, one with a box now clear does not', async () => {
        const panes = loadPanes();
        await panes.refresh();
        expect(plain(panes._doneRevs()).ai_2026).toEqual(['r5']);
        panes.keep = { translation: true, ingame: true };
        const revs = plain(panes._doneRevs());
        expect(revs.ai_2026.sort()).toEqual(['r5', 'r5+l', 'r5+t', 'r5+t+l']);
        panes.keep = { translation: false, ingame: true };
        expect(plain(panes._doneRevs()).ai_2026.sort()).toEqual(['r5', 'r5+l']);
        // A whole list has no boxes.
        expect(revs.vr).toBe('r9');
    });

    test('refresh goes by what the queue and the done marks say', async () => {
        const panes = loadPanes({
            store: { getQueue: async () => [{ curatorId: 'preset_vr' }, { curatorId: '123' }] },
            marks: { presetMarks: async () => ({ blocked: new Set(['vr', 'ai_2026']), updated: new Set() }) },
        });
        await panes.refresh();
        expect(panes._state('vr')).toBe('queued');
        expect(panes._state('ai_2026')).toBe('done');
    });
});
