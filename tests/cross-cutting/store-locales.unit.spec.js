// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// _locales/ carries the extension's name and short description per language:
// the stores build their per-language listings from it. Chrome refuses to load
// a package whose __MSG_…__ has no message in the default locale, and the
// store dashboards reject a name or summary over their limits — neither shows
// up anywhere but at upload or install.

const ROOT = path.join(__dirname, '..', '..');
const LOCALES = path.join(ROOT, '_locales');
const BRAND = 'Steam Ignore Like A Pro — ';
const NAME_MAX = 50;          // AMO, per locale: extName (Firefox build)
const CHROME_NAME_MAX = 75;   // CWS: extNameChrome (Chromium build)
const SUMMARY_MAX = 132;      // CWS (AMO allows 250)
const NAME_KEY = { chromium: 'extNameChrome', firefox: 'extName' };

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));

function uiLanguages() {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'i18n.js'), 'utf8'), sandbox);
    return sandbox.window.ILAP.i18n.getLanguages().map(l => l.code);
}

test.describe('Store locales (unit)', () => {

    test('both manifests take name and description from _locales, English by default', () => {
        for (const platform of ['chromium', 'firefox']) {
            const m = readJson(path.join(ROOT, 'platform', platform, 'manifest.json'));
            expect(m.name, platform).toBe(`__MSG_${NAME_KEY[platform]}__`);
            expect(m.description, platform).toBe('__MSG_extDescription__');
            expect(m.default_locale, platform).toBe('en');
        }
    });

    test('one locale per UI language, named the way the browsers spell it', () => {
        const dirs = fs.readdirSync(LOCALES).sort();
        const expected = uiLanguages().map(c => c.replace('-', '_')).sort();
        expect(dirs).toEqual(expected);
    });

    test('every locale has all messages, keeps the brand and fits the store limits', () => {
        for (const lang of fs.readdirSync(LOCALES)) {
            const msg = readJson(path.join(LOCALES, lang, 'messages.json'));
            const name = msg.extName && msg.extName.message;
            const chromeName = msg.extNameChrome && msg.extNameChrome.message;
            const desc = msg.extDescription && msg.extDescription.message;
            expect(typeof name, `${lang}: extName`).toBe('string');
            expect(typeof chromeName, `${lang}: extNameChrome`).toBe('string');
            expect(typeof desc, `${lang}: extDescription`).toBe('string');
            expect(name.startsWith(BRAND), `${lang}: name keeps the brand`).toBe(true);
            expect(chromeName.startsWith(BRAND), `${lang}: Chrome name keeps the brand`).toBe(true);
            expect(name.length, `${lang}: name length`).toBeLessThanOrEqual(NAME_MAX);
            expect(chromeName.length, `${lang}: Chrome name length`).toBeLessThanOrEqual(CHROME_NAME_MAX);
            expect(desc.length, `${lang}: description length`).toBeLessThanOrEqual(SUMMARY_MAX);
        }
    });
});
