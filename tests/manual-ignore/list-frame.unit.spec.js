// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The frame on an ignored game's own page (src/manual-ignore/list-frame.js):
// which list it names, from the ignore log and the lists run to their end, in
// Node. Drawing it is the E2E spec's (list-frame.spec.js).
const src = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', ...p), 'utf8');

function load() {
    // Not a game page: the module boots into nothing.
    const sandbox = { window: {}, location: { pathname: '/search/' } };
    vm.createContext(sandbox);
    vm.runInContext(src('presets.js'), sandbox);
    vm.runInContext(src('manual-ignore', 'list-frame.js'), sandbox);
    const ILAP = sandbox.window.ILAP;
    // What concernsFrame reads of the log and the done marks.
    ILAP.IgnoreLog = { isLogKey: (k) => k === 'ilap_ignore_log_index' || k.indexOf('ilap_ignore_log_c') === 0 };
    ILAP.Curator = { DoneMarks: {
        PRESET_DONE_PREFIX: 'ilap_preset_done_', IGNORED_BUNDLES_KEY: 'ilap_ignored_bundles', LIST_NAMES_KEY: 'ilap_list_names',
    } };
    return ILAP;
}

const MI = load().ManualIgnore;
const plain = (v) => JSON.parse(JSON.stringify(v));
const reason = (log, covered) => plain(MI.listReason(log, '10', covered || []));

const DENUVO = { appid: '10', ts: 100, source: 'curator', curatorId: 'preset_denuvo' };
const EQ = { appid: '10', ts: 200, source: 'eq' };
const SWIPE = { appid: '10', ts: 300, source: 'mi', name: 'G' };
const SHOT = { appid: '10', ts: 400, source: 'mi', name: 'G', auto: true };
const COVERED = [{ kind: 'preset', key: 'ai_2025' }];

test.describe('listReason', () => {
    test('a list that ignored the game names it, over a later queue helper ignore', () => {
        expect(reason([DENUVO, EQ])).toEqual({ kind: 'preset', key: 'denuvo', ts: 100 });
    });

    test('a curator, and a bundle whose apps went into the MI job, are lists too', () => {
        expect(reason([{ appid: '10', ts: 5, source: 'curator', curatorId: '4777282' }]))
            .toEqual({ kind: 'curator', id: '4777282', ts: 5 });
        expect(reason([{ appid: '10', ts: 6, source: 'mi', curatorId: 'bundle_232' }]))
            .toEqual({ kind: 'bundle', id: 'bundle_232', ts: 6 });
        expect(reason([{ appid: '10', ts: 7, source: 'curator', curatorId: 'sub_99' }]))
            .toEqual({ kind: 'bundle', id: 'sub_99', ts: 7 });
    });

    test('a list that covered a game the Queue Helper ignored first outranks it', () => {
        expect(reason([EQ], COVERED)).toEqual({ kind: 'preset', key: 'ai_2025' });
    });

    test('a covering list outranks a hand and a shot, a list entry outranks a covering one', () => {
        expect(reason([SWIPE], COVERED)).toEqual({ kind: 'preset', key: 'ai_2025' });
        expect(reason([SHOT], COVERED)).toEqual({ kind: 'preset', key: 'ai_2025' });
        expect(reason([DENUVO, SHOT], COVERED)).toEqual({ kind: 'preset', key: 'denuvo', ts: 100 });
    });

    test('a shot of the AI filter while browsing, with no list', () => {
        expect(reason([SWIPE, SHOT])).toEqual({ kind: 'auto', ts: 400 });
    });

    test('a hand or a queue helper alone gives no frame', () => {
        expect(reason([SWIPE])).toBeNull();
        expect(reason([EQ, { appid: '10', ts: 250, source: 'dq' }])).toBeNull();
        expect(reason([])).toBeNull();
    });

    test('a rollback with nothing of ours after it gives no frame, whatever covers the game', () => {
        expect(reason([Object.assign({}, DENUVO, { undoneAt: 150 })], COVERED)).toBeNull();
        expect(reason([Object.assign({}, SHOT, { undoneAt: 450 })])).toBeNull();
    });

    test('only the ignores since the last rollback count', () => {
        const undone = Object.assign({}, DENUVO, { undoneAt: 150 });
        expect(reason([undone, EQ])).toBeNull();
        expect(reason([undone, EQ], COVERED)).toEqual({ kind: 'preset', key: 'ai_2025' });
        expect(reason([undone, SHOT])).toEqual({ kind: 'auto', ts: 400 });
    });

    test('refusals, other games and creator entries are passed by', () => {
        const log = [
            Object.assign({}, DENUVO, { skipped: 'failed' }),
            { appid: '11', ts: 1, source: 'curator', curatorId: 'preset_vr' },
            { creator: '33', ignore: true, ts: 2, source: 'creator' },
        ];
        expect(reason(log)).toBeNull();
    });
});

test.describe('listsCovering', () => {
    const DATA = {
        rev: { denuvo: 'r1', ai_2025: 'r2', 'ai_upcoming_2028+': 'r3' },
        denuvo: [10, 20],
        ai: { 2025: [10, 30], 'upcoming_2028+': [10] },
        aikeep: { translation: [10], ingame: [] },
    };
    const covering = (done, bundles, appid = '10') => plain(MI.listsCovering(appid, {
        data: DATA, done, bundles: bundles || {}, aiGames: load().aiGames,
    }));

    test('a built-in list done at the shipped version covers its games', () => {
        expect(covering({ denuvo: 'r1' })).toEqual([{ kind: 'preset', key: 'denuvo' }]);
        expect(covering({ denuvo: 'r1' }, null, '30')).toEqual([]);
    });

    test('a list done at an older version, or not done, covers nothing', () => {
        expect(covering({ denuvo: 'r0' })).toEqual([]);
        expect(covering({})).toEqual([]);
    });

    test('an AI list leaves out the games its done mark kept', () => {
        expect(covering({ ai_2025: 'r2+t' })).toEqual([]);
        expect(covering({ ai_2025: 'r2+l' })).toEqual([{ kind: 'preset', key: 'ai_2025' }]);
        expect(covering({ ai_2025: 'r2' })).toEqual([{ kind: 'preset', key: 'ai_2025' }]);
        expect(covering({ 'ai_upcoming_2028+': 'r3' })).toEqual([{ kind: 'preset', key: 'ai_upcoming_2028+' }]);
    });

    test('a finished bundle covers its apps, with the day it finished', () => {
        const bundles = { bundle_232: { ts: 77, appids: ['10', '11'] }, sub_5: { ts: 78, appids: ['12'] } };
        expect(covering({}, bundles)).toEqual([{ kind: 'bundle', id: 'bundle_232', ts: 77 }]);
    });
});

test.describe('concernsFrame', () => {
    const chunk = (...entries) => entries;

    test('a drain appending to the chunk that has the game does not count', () => {
        const before = chunk(DENUVO);
        const after = chunk(DENUVO, { appid: '11', ts: 500, source: 'curator', curatorId: 'preset_vr' });
        expect(MI.concernsFrame({ ilap_ignore_log_c3: { oldValue: before, newValue: after } }, '10')).toBe(false);
    });

    test('a rollback or a new ignore of the game counts', () => {
        const undone = Object.assign({}, DENUVO, { undoneAt: 600 });
        expect(MI.concernsFrame({ ilap_ignore_log_c3: { oldValue: chunk(DENUVO), newValue: chunk(undone) } }, '10')).toBe(true);
        expect(MI.concernsFrame({ ilap_ignore_log_c4: { newValue: chunk(SHOT) } }, '10')).toBe(true);
    });

    test('done marks, finished bundles and list names count, other keys do not', () => {
        expect(MI.concernsFrame({ ilap_preset_done_vr: { newValue: 'r1' } }, '10')).toBe(true);
        expect(MI.concernsFrame({ ilap_ignored_bundles: { newValue: {} } }, '10')).toBe(true);
        expect(MI.concernsFrame({ ilap_list_names: { newValue: {} } }, '10')).toBe(true);
        expect(MI.concernsFrame({ ilap_ignored_count: { newValue: 3 } }, '10')).toBe(false);
    });
});
