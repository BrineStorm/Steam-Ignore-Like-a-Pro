const { test, expect } = require('@playwright/test');
const { bucketOf, revOf, textHash, lastRows, removedAi, buildPresets } = require('../../scripts/build-presets.js');

// scripts/build-presets.js turns the store-page scan into data/presets.json.
// Node unit — no browser. The scan reads each page in English, so the dates
// below are the shapes an English store page shows.

const TODAY = new Date('2026-10-20T00:00:00Z');

test.describe('Built-in lists — data build (unit)', () => {
    test('a released date files under its year, the last three years each on their own', () => {
        expect(bucketOf('Feb 24, 2024', TODAY)).toBe('2024');
        expect(bucketOf('24 Feb, 2025', TODAY)).toBe('2025');
        expect(bucketOf('Oct 20, 2026', TODAY)).toBe('2026');   // released today
        expect(bucketOf('Dec 31, 2023', TODAY)).toBe('earlier_2023');
        expect(bucketOf('Sept 3, 2019', TODAY)).toBe('earlier_2023');
    });

    test('a date ahead files under its upcoming year, two years out and later together', () => {
        expect(bucketOf('Oct 21, 2026', TODAY)).toBe('upcoming_2026');
        expect(bucketOf('2026', TODAY)).toBe('upcoming_2026');   // this year, day unknown
        expect(bucketOf('Q1 2027', TODAY)).toBe('upcoming_2027');
        expect(bucketOf('February 2027', TODAY)).toBe('upcoming_2027');
        expect(bucketOf('Jan 1, 2028', TODAY)).toBe('upcoming_2028+');
        expect(bucketOf('2033', TODAY)).toBe('upcoming_2028+');
    });

    test('a date with no year files under tba', () => {
        expect(bucketOf('Coming soon', TODAY)).toBe('tba');
        expect(bucketOf('To be announced', TODAY)).toBe('tba');
        expect(bucketOf('', TODAY)).toBe('tba');
        expect(bucketOf(undefined, TODAY)).toBe('tba');
    });

    test('a bare past year counts as that year', () => {
        expect(bucketOf('2025', TODAY)).toBe('2025');
        expect(bucketOf('Q4 2024', TODAY)).toBe('2024');
        expect(bucketOf('2015', TODAY)).toBe('earlier_2023');
    });

    test('lists keep AI games by year and Denuvo games whole', () => {
        const rows = [
            { appid: 10, status: 'ok', ai: true, date: 'Coming soon' },
            { appid: 11, status: 'ok', ai: true, date: 'Mar 1, 2026' },
            { appid: 12, status: 'ok', ai: true, date: 'Jan 5, 2025', drm: ['Incorporates 3rd-party DRM: Denuvo Anti-Tampering'] },
            { appid: 13, status: 'ok', ai: false, date: 'Jan 5, 2020', drm: ['Requires 3rd-Party Account: EA app'] },
            { appid: 14, status: 'ok', ai: false, date: 'Jan 5, 2020', drm: ['Incorporates 3rd-party DRM: Denuvo Anti-tamper'] },
            { appid: 15, status: 'agecheck', ai: true, date: 'Jan 5, 2024' },   // never read
            { appid: 11, status: 'ok', ai: true, date: 'Mar 1, 2026' },          // a repeated row
            null,                                                                 // a half-written line
        ];
        const out = buildPresets(rows, TODAY);
        expect(out.ai).toEqual({ tba: [10], 2026: [11], 2025: [12] });
        expect(out.denuvo).toEqual([12, 14]);
        expect(Object.keys(out.rev).sort()).toEqual(['ai_2025', 'ai_2026', 'ai_tba', 'anticheat', 'denuvo', 'iap', 'vr']);
        expect(out.rev.denuvo).toMatch(/^[0-9a-f]{8}$/);
    });

    test('the last row of an appid wins and the game keeps its first place', () => {
        const rows = [
            { appid: 40, status: 'ok', ai: false, date: 'Mar 1, 2026' },
            { appid: 41, status: 'ok', ai: true, date: 'Mar 1, 2026' },
            { appid: 42, status: 'ok', ai: true, date: 'Mar 1, 2026', cats: ['VR Only'] },
            { appid: 43, status: 'ok', ai: true, date: 'Mar 1, 2026' },
            { appid: 40, status: 'ok', ai: true, date: 'Mar 1, 2026' },             // disclosure added on a re-read
            { appid: 41, status: 'ok', ai: false, date: 'Mar 1, 2026' },            // disclosure taken off
            { appid: 42, status: 'ok', ai: true, date: 'Mar 1, 2026', cats: [] },   // no longer VR Only
            { appid: 43, status: 'redirect' },                                      // the page went away
        ];
        const out = buildPresets(rows, TODAY);
        expect(out.ai).toEqual({ 2026: [40, 42] });
        expect(out.vr).toEqual([]);
    });

    test('AI games the disclosure keeps go to aikeep, still in their year list', () => {
        const rows = [
            { appid: 50, status: 'ok', ai: true, date: 'Mar 1, 2026', text: 'Artificial intelligence was used for language translation in this game.' },
            { appid: 51, status: 'ok', ai: true, date: 'Mar 1, 2026', text: 'This game uses a local AI text generation model to power an npc.' },
            { appid: 52, status: 'ok', ai: true, date: 'Mar 1, 2026', text: 'Storytelling\n\nArtworks' },
            { appid: 53, status: 'ok', ai: false, date: 'Mar 1, 2026', text: 'Artificial intelligence was used for language translation in this game.' },
        ];
        const out = buildPresets(rows, TODAY);
        expect(out.ai).toEqual({ 2026: [50, 51, 52] });
        expect(out.aikeep).toEqual({ translation: [50], ingame: [51] });
    });

    test('a reviewed verdict wins over the word rules while its text is still the page\'s', () => {
        const old = 'AI tools were used for some artwork.';
        const rows = [
            { appid: 60, status: 'ok', ai: true, date: 'Mar 1, 2026', text: 'Artificial intelligence was used for language translation in this game.' },
            { appid: 61, status: 'ok', ai: true, date: 'Mar 1, 2026', text: 'Localization, some descriptions' },
            { appid: 62, status: 'ok', ai: true, date: 'Mar 1, 2026', text: 'This game uses a local AI text generation model to power an npc.' },
        ];
        const verdicts = new Map([
            [61, { appid: 61, hash: textHash('Localization, some descriptions'), t: false, l: false }],   // the rules said yes
            [62, { appid: 62, hash: textHash(old), t: false, l: false }],                                 // given for an older text
        ]);
        const out = buildPresets(rows, TODAY, verdicts);
        expect(out.aikeep).toEqual({ translation: [60], ingame: [62] });
        expect(buildPresets(rows, TODAY).aikeep.translation).toEqual([60, 61]);
    });

    test('a row with no usable appid is dropped, the last row of an appid wins', () => {
        // The scan's rows and the hand-written verdicts and manual picks all
        // pass here: a bad id would ship as null and be POSTed as "null".
        const rows = lastRows([
            { appid: 'abc' }, { appid: -5 }, { appid: 0 }, { appid: 1.5 }, null,
            { appid: '7', date: 'old' }, { appid: 7, date: 'new' },
        ]);
        expect([...rows.keys()]).toEqual([7]);
        expect(rows.get(7).date).toBe('new');
    });

    test('a game picked by hand joins the AI list of its date', () => {
        const rows = [
            { appid: 70, status: 'ok', ai: false, date: 'Dec 3, 2026' },
            { appid: 71, status: 'ok', ai: true, date: 'Mar 1, 2026', text: 'Artworks' },
            { appid: 72, status: 'redirect' },
        ];
        const manual = new Map([
            [70, { appid: 70, date: 'Mar 1, 2025' }],   // the scan's date wins
            [71, { appid: 71, date: 'Mar 1, 2026' }],   // the scan flags it already
            [72, { appid: 72, date: 'Mar 1, 2026' }],   // the page went away
            [73, { appid: 73, date: 'Mar 1, 2025' }],   // not scanned, the row's date
        ]);
        const out = buildPresets(rows, TODAY, null, manual);
        expect(out.ai).toEqual({ 2026: [71], upcoming_2026: [70], 2025: [73] });
        expect(out.aimanual).toEqual([70, 73]);   // their page note says they were marked by hand
        expect(out.aikeep).toEqual({ translation: [], ingame: [] });
        expect(buildPresets(rows, TODAY).ai).toEqual({ 2026: [71] });
        expect(buildPresets(rows, TODAY).aimanual).toEqual([]);
    });

    test('a game whose disclosure was removed stays in the AI lists, by its date now and its last text', () => {
        const DEEPL = 'The game was translated into Japanese with DeepL.';
        const off = (appid, text) => [
            { appid, field: 'ai', was: true, now: false },
            { appid, field: 'text', was: text, now: '' },
        ];
        const rows = [
            { appid: 80, status: 'ok', ai: true, date: 'Mar 1, 2026', text: 'Art.' },
            { appid: 80, status: 'ok', ai: false, date: 'Mar 1, 2025' },
            { appid: 81, status: 'ok', ai: false, date: 'Mar 1, 2026' },
            { appid: 82, status: 'ok', ai: true, date: 'Mar 1, 2026', text: 'Art again.' },
            { appid: 83, status: 'redirect' },
            { appid: 84, status: 'ok', ai: false, date: 'Mar 1, 2026' },
            { appid: 85, status: 'ok', ai: false, date: 'Mar 1, 2026' },
        ];
        const changes = [
            { appid: 81, field: 'text', was: 'An older text.', now: DEEPL },
            ...off(80, 'Art.'),
            ...off(81, DEEPL),
            ...off(82, 'Art.'),
            { appid: 82, field: 'ai', was: false, now: true },   // it came back
            ...off(83, 'Art.'),                                  // the page went away
            { appid: 84, field: 'date', was: '2025', now: '2026' },   // never had one
            ...off(85, 'Art.'),
            null,
        ];
        const removed = removedAi(changes);
        expect([...removed.keys()].sort()).toEqual([80, 81, 83, 85]);
        expect(removed.get(81)).toBe(DEEPL);

        const out = buildPresets(rows, TODAY, null, null, null, removed);
        expect(out.ai).toEqual({ 2025: [80], 2026: [81, 82, 85] });
        expect(out.airemoved).toEqual([80, 81, 85]);
        expect(out.aikeep.translation).toEqual([81]);

        // A verdict for the last text stands, and a hand pick adds no second entry.
        const verdicts = new Map([[80, { hash: textHash('Art.'), t: true, l: false }]]);
        const manual = new Map([[85, { appid: 85, date: 'Mar 1, 2026' }]]);
        const both = buildPresets(rows, TODAY, verdicts, manual, null, removed);
        expect(both.aikeep.translation).toEqual([80, 81]);
        expect(both.ai[2026]).toEqual([81, 82, 85]);
        expect(both.aimanual).toEqual([]);

        // Without the log they are ordinary games, the page is what counts.
        expect(buildPresets(rows, TODAY).ai).toEqual({ 2026: [82] });
        expect(buildPresets(rows, TODAY).airemoved).toEqual([]);
    });

    test('kernel-level anti-cheat, In-App Purchases and VR Only make whole lists', () => {
        const rows = [
            { appid: 20, status: 'ok', anticheat: ['Uses Kernel Level Anti-Cheat Easy Anti-Cheat - Requires manual removal after game uninstall'] },
            { appid: 21, status: 'ok', anticheat: ['Uses Anti-Cheat Software Fairguard Boot Protection - Requires both Secure Boot & TPM 2.0'] },
            { appid: 22, status: 'ok', cats: ['Single-player', 'In-App Purchases', 'VR Only'] },
            { appid: 23, status: 'ok', cats: ['VR Supported'] },
            { appid: 24, status: 'ok', cats: ['In-App Purchases'] },
        ];
        const out = buildPresets(rows, TODAY);
        expect(out.anticheat).toEqual([20]);
        expect(out.iap).toEqual([22, 24]);
        expect(out.vr).toEqual([22]);
        expect(out.denuvo).toEqual([]);
        expect(out.ai).toEqual({});
    });

    test('a reviewed list takes its games whose last verdict is in and whose page is ok', () => {
        const rows = [
            { appid: 40, status: 'ok', anticheat: ['Uses Kernel Level Anti-Cheat Easy Anti-Cheat'] },
            { appid: 41, status: 'ok' },
            { appid: 42, status: 'ok' },
            { appid: 43, status: 'redirect' },
        ];
        const eula = lastRows([{ appid: 41, in: true }, { appid: 42, in: true }, { appid: 42, in: false }, { appid: 43, in: true }, { appid: 44, in: true }]);
        const kernel = lastRows([{ appid: 40, in: true }, { appid: 41, in: true }]);
        const out = buildPresets(rows, TODAY, null, null, { eula: eula, anticheat: kernel });
        expect(out.eula).toEqual([41]);
        expect(out.anticheat).toEqual([40, 41]);   // joins the scan's list, once each
        expect(out.rev.eula).toBe(revOf([41]));
        expect(out.rev.anticheat).toBe(revOf([40, 41]));
        expect(out.lesser).toBeUndefined();
    });

    test('a bad game is a known one from 200 reviews or by a known pick, else a lesser-known one', () => {
        const rows = [
            { appid: 50, status: 'ok', reviews: 'Mixed', nrev: 200 },
            { appid: 51, status: 'ok', reviews: 'Mixed', nrev: 199 },
            { appid: 52, status: 'ok', reviews: '6 user reviews' },
            { appid: 53, status: 'ok', reviews: 'Mostly Negative', nrev: 12 },
            { appid: 54, status: 'ok', reviews: 'Mostly Negative', nrev: 2500 },
            { appid: 55, status: 'ok', name: 'Police Simulator: Patrol Duty', reviews: 'Mixed', nrev: 1757 },
        ];
        const bad = lastRows([50, 51, 52, 54, 55].map(appid => ({ appid, in: true })).concat({ appid: 53, in: true, known: true }));
        const out = buildPresets(rows, TODAY, null, null, { bad: bad });
        expect(out.bad).toEqual([50, 53]);
        expect(out.lesser).toEqual([51, 52, 54, 55]);   // few reviews, negative ones, a simulator
        expect(out.rev.bad).toBe(revOf([50, 53]));
        expect(out.rev.lesser).toBe(revOf([51, 52, 54, 55]));
    });

    test("Denuvo's anti-cheat counts as anti-cheat only, its DRM as Denuvo", () => {
        const rows = [
            { appid: 30, status: 'ok', anticheat: ['Uses Kernel Level Anti-Cheat Denuvo - Requires manual removal after game uninstall'] },
            { appid: 31, status: 'ok', drm: ['Incorporates 3rd-party DRM: Denuvo Anti-Cheat'] },
            { appid: 32, status: 'ok', drm: ['Incorporates 3rd-party DRM: Denuvo Anti-Tamper and Anti-Cheat'] },
            { appid: 33, status: 'ok', drm: ['Incorporates 3rd-party DRM: Denuvo, Easy Anti-Cheat'] },
        ];
        const out = buildPresets(rows, TODAY);
        expect(out.anticheat).toEqual([30]);
        expect(out.denuvo).toEqual([32, 33]);
    });

    test('a row with no usable appid is left out', () => {
        const rows = [
            { appid: 'abc', status: 'ok', ai: true, date: 'Mar 1, 2026', drm: ['Denuvo'] },
            { appid: 0, status: 'ok', ai: true, date: 'Mar 1, 2026' },
            { appid: 1.5, status: 'ok', ai: true, date: 'Mar 1, 2026' },
            { appid: '20', status: 'ok', ai: true, date: 'Mar 1, 2026' },
        ];
        const out = buildPresets(rows, TODAY);
        expect(out.ai).toEqual({ 2026: [20] });
        expect(out.denuvo).toEqual([]);
    });

    test('a list keeps its rev until its games change', () => {
        expect(revOf([3, 1, 2])).toBe(revOf([1, 2, 3]));
        expect(revOf([1, 2, 3])).not.toBe(revOf([1, 2, 3, 4]));
        expect(revOf([1, 2, 3])).not.toBe(revOf([1, 2, 4]));
    });
});
