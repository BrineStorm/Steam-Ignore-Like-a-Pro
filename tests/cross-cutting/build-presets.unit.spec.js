const { test, expect } = require('@playwright/test');
const { bucketOf, revOf, buildPresets } = require('../../scripts/build-presets.js');

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
