// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The Last-Ignored history labels (src/stats.js): one table for every source,
// and the MI reason → label mapping both drain hosts use.
function loadStats() {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'stats.js'), 'utf8'), sandbox);
    return sandbox.window.ILAP.StatsLogic;
}

test.describe('StatsLogic history labels (unit)', () => {

    test('miSourceLabel maps an MI reason to its Last-Ignored label', () => {
        const S = loadStats();
        // Reason 2 is the Played Elsewhere swipe, everything else the default.
        expect(S.miSourceLabel(2)).toBe('Played Elsewhere');
        expect(S.miSourceLabel('2')).toBe('Played Elsewhere');   // meta survives a JSON round-trip
        expect(S.miSourceLabel(0)).toBe('Default Ignore');
        expect(S.miSourceLabel(undefined)).toBe('Default Ignore');
    });

    test('historyState records a change of reason in Last Ignored without counting it', () => {
        const S = loadStats();
        const next = S.historyState({ [S.COUNT_KEY]: 5, [S.HISTORY_KEY]: [{ name: 'Old', source: 'Queue' }] },
            'Foo', 'Played Elsewhere');
        expect(S.COUNT_KEY in next).toBe(false);
        expect(next[S.LAST_KEY]).toBe('Foo');
        expect(next[S.HISTORY_KEY].map(h => h.name)).toEqual(['Foo', 'Old']);
    });

    test('a history entry keeps a numeric appid, for the popup to open the game\'s page', () => {
        const S = loadStats();
        expect(S.pushHistory([], 'Portal 2', 'Queue', 620)[0]).toEqual({ name: 'Portal 2', source: 'Queue', appid: '620' });
        expect(S.nextState({}, 'Foo', 'Queue', '10')[S.HISTORY_KEY][0].appid).toBe('10');
        expect(S.historyState({}, 'Foo', 'Played Elsewhere', '11')[S.HISTORY_KEY][0].appid).toBe('11');
        // Anything else is left out: the popup builds a URL from it.
        expect('appid' in S.pushHistory([], 'Foo', 'Queue', 'x/../1')[0]).toBe(false);
        expect('appid' in S.pushHistory([], 'Foo', 'Queue')[0]).toBe(false);
    });

    test('a finished job becomes one history entry, shown in Last Ignored and not counted', () => {
        const S = loadStats();
        expect(S.jobEntry({ curatorId: '101', curatorName: 'No AI Games', filter: 'not_recommended' }))
            .toEqual({ name: 'No AI Games', source: 'Curator', filter: 'not_recommended', curatorId: '101' });
        expect(S.jobEntry({ type: 'preset', presetKey: 'ai_2026' }))
            .toEqual({ name: 'ai_2026', source: 'Built-in List', presetKey: 'ai_2026' });
        expect(S.jobEntry({ type: 'undo', scope: { n: 6, unit: 'h' } }))
            .toEqual({ name: 'undo', source: 'Undo', scope: { n: 6, unit: 'h' } });
        // Gesture jobs record each game instead; an unknown type records nothing.
        expect(S.jobEntry({ type: 'mi' })).toBe(null);
        expect(S.jobEntry({ type: 'later' })).toBe(null);
        // A curator id that is not a number is left out: the popup builds a URL from it.
        expect('curatorId' in S.jobEntry({ curatorId: 'x/..', curatorName: 'X' })).toBe(false);

        const next = S.jobState({ [S.COUNT_KEY]: 5, [S.HISTORY_KEY]: [{ name: 'Old', source: 'Queue' }] },
            { type: 'preset', presetKey: 'vr' });
        expect(S.COUNT_KEY in next).toBe(false);
        expect(next[S.LAST_KEY]).toBe('vr');
        expect(next[S.HISTORY_KEY].map(h => h.source)).toEqual(['Built-in List', 'Queue']);
        expect(S.jobState({}, { type: 'mi' })).toEqual({});
    });

    test('a job already in the history is not recorded twice', () => {
        // Two drainers can both sweep the same leftover job (_collectDrained).
        const S = loadStats();
        const job = { id: 'job_preset_vr_1', type: 'preset', presetKey: 'vr' };
        const once = S.jobState({ [S.HISTORY_KEY]: [{ name: 'Old', source: 'Queue' }] }, job);
        expect(once[S.HISTORY_KEY][0].jobId).toBe('job_preset_vr_1');
        expect(S.jobState(once, job)).toEqual({});
        // The same list run again is a new job, with an id of its own.
        const again = S.jobState(once, { ...job, id: 'job_preset_vr_2' });
        expect(again[S.HISTORY_KEY].map(h => h.jobId)).toEqual(['job_preset_vr_2', 'job_preset_vr_1', undefined]);
    });

    test('the stored labels keep their exact spelling', () => {
        // They sit in users' history already: a rename would split it in two.
        expect({ ...loadStats().SOURCE }).toEqual({
            EQ: 'Explore Auto-Queue',
            DQ: 'Queue',
            MI_DEFAULT: 'Default Ignore',
            MI_PLAYED: 'Played Elsewhere',
            CURATOR: 'Curator',
            PRESET: 'Built-in List',
            BUNDLE: 'Bundle',
            UNDO: 'Undo',
        });
    });

    test('a finished bundle job is one entry with its name and its store path', () => {
        const S = loadStats();
        expect({ ...S.jobEntry({ type: 'bundle', curatorId: 'sub_648168', curatorName: 'Shadow Bundle' }) })
            .toEqual({ name: 'Shadow Bundle', source: 'Bundle', bundle: 'sub/648168' });
        // An id of any other shape gives no link.
        expect({ ...S.jobEntry({ type: 'bundle', curatorId: 'bundle_x"', curatorName: 'B' }) })
            .toEqual({ name: 'B', source: 'Bundle' });
    });
});
