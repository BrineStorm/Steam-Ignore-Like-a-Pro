// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const { test, expect } = require('../_fixtures.js');
const { waitForContentScript } = require('./_helpers');
const { setExtensionStorage, getExtensionStorage, clearExtensionStorage } = require('../_extension.js');

// The Classic Discovery Queue's red IGNORED frame on the own page of a game a
// list ignored (src/manual-ignore/list-frame.js): which list its tooltip
// names, from the seeded ignore log, done marks and list names, and how it
// follows Steam's Ignore button, a rollback and the master switch. The game
// pages are ours, served at /app/<id>/ on the store's origin with Steam's
// markup of the Ignore button. Nothing is sent to Steam.

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'presets.json'), 'utf8'));
const APP = '620';
const DENUVO_APP = String(DATA.denuvo[0]);
const CURATOR = '4777282';
// Midday, so the day is the same in every time zone the suite runs in.
const TS = Date.UTC(2026, 9, 12, 12);
const DAY = 'Oct 12, 2026';
const RED = 'rgb(211, 47, 47)';

// Steam's Ignore button: "Ignored" shown and "Ignore" hidden for a game on the list.
function gamePage(appid, ignored) {
    const shown = (on) => (on ? '' : 'display: none;');
    return '<!doctype html><html><head><title>Game</title>'
        + '<style>body{background:#1b2838;color:#c6d4df;font:12px Arial}</style></head><body>'
        + `<div class="page_content_ctn"><div id="appHubAppName" class="apphub_AppName">Game ${appid}</div>`
        + '<div id="queueActionsCtn" class="queue_actions_ctn" style="margin:200px 0 0 300px">'
        + '<div id="ignoreBtn" style="position: relative; display: flex;"><div class="queue_control_button queue_btn_ignore">'
        + `<button class="btnv6_blue_hoverfade btn_medium queue_btn_inactive" style="${shown(!ignored)}"><span>Ignore</span></button>`
        + `<button class="btnv6_blue_hoverfade btn_medium queue_btn_active" style="${shown(ignored)}"><span>Ignored</span></button>`
        + '</div></div></div></div></body></html>';
}

const url = (appid) => `https://store.steampowered.com/app/${appid}/`;
async function open(page, context, appid, { ignored = true, storage = {} } = {}) {
    await context.route(url(appid), (r) => r.fulfill({ status: 200, contentType: 'text/html', body: gamePage(appid, ignored) }));
    await setExtensionStorage(context, Object.assign({ ilap_lang: 'en', ilap_ai_level: 0 }, storage));
    await page.goto(url(appid));
    await waitForContentScript(page);
}

const badge = (page) => page.locator('#ignoreBtn .ilap-micro-badge');
const tip = (page) => page.locator('#ignoreBtn .ilap-tooltip');
const shadow = (page) => page.locator('#ignoreBtn').evaluate(el => el.style.boxShadow);
// Steam flips its button in place.
const flip = (page, ignored) => page.evaluate((on) => {
    document.querySelector('.queue_btn_active').style.display = on ? '' : 'none';
    document.querySelector('.queue_btn_inactive').style.display = on ? 'none' : '';
}, ignored);

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Manual Ignore — the list frame on a game page', () => {

    test('a built-in list names itself and the day in the frame\'s tooltip', async ({ page, context }) => {
        await open(page, context, APP, { storage: {
            ilap_ignore_log: [{ appid: APP, ts: TS, source: 'curator', curatorId: 'preset_denuvo' }],
        } });
        await expect(badge(page)).toHaveText('IGNORED');
        await expect(tip(page)).toContainText('Ignored by a built-in list');
        await expect(tip(page)).toContainText('Denuvo DRM');
        await expect(tip(page)).toContainText(DAY);
        // Red like the Classic Discovery Queue's IGNORED, the ring 2 px so it
        // reads round the button.
        expect(await shadow(page)).toBe(`${RED} 0px 0px 0px 2px`);
        await expect(badge(page)).toHaveCSS('background-color', RED);
    });

    test('a curator list shows its stored name, or reads it from Steam once and stores it', async ({ page, context }) => {
        await open(page, context, APP, { storage: {
            ilap_ignore_log: [{ appid: APP, ts: TS, source: 'curator', curatorId: CURATOR }],
            ilap_list_names: { [CURATOR]: { name: 'Stored Curator', ts: 1 } },
        } });
        await expect(tip(page)).toContainText('Ignored by a curator list');
        await expect(tip(page)).toContainText('Stored Curator');

        await clearExtensionStorage(context);
        await context.route(`https://store.steampowered.com/curator/${CURATOR}/?l=english`, (r) => r.fulfill({
            status: 200, contentType: 'text/html',
            body: '<html><head><meta property="og:title" content="Steam Curator: Read &amp; Kept"></head></html>',
        }));
        await open(page, context, APP, { storage: {
            ilap_ignore_log: [{ appid: APP, ts: TS, source: 'curator', curatorId: CURATOR }],
        } });
        await expect(tip(page)).toContainText('Read & Kept');
        await expect.poll(async () => {
            const names = (await getExtensionStorage(context, ['ilap_list_names'])).ilap_list_names || {};
            return names[CURATOR] && names[CURATOR].name;
        }).toBe('Read & Kept');
    });

    test('a game the AI filter shot while browsing says so', async ({ page, context }) => {
        await open(page, context, APP, { storage: {
            ilap_ignore_log: [{ appid: APP, ts: TS, source: 'mi', name: 'G', auto: true }],
        } });
        await expect(tip(page)).toContainText('Ignored by the AI filter while you browsed the store');
        await expect(tip(page)).toContainText(DAY);
    });

    test('a built-in list run after the Queue Helper ignored the game claims it', async ({ page, context }) => {
        // The list skipped the game as already ignored: no entry of its own.
        await open(page, context, DENUVO_APP, { storage: {
            ilap_ignore_log: [{ appid: DENUVO_APP, ts: TS, source: 'eq', name: 'G' }],
            ilap_preset_done_denuvo: DATA.rev.denuvo,
        } });
        await expect(tip(page)).toContainText('Ignored by a built-in list');
        await expect(tip(page)).toContainText('Denuvo DRM');
    });

    test('no frame for a hand\'s ignore, or for a game the page shows off the list', async ({ page, context }) => {
        await open(page, context, APP, { storage: {
            ilap_ignore_log: [{ appid: APP, ts: TS, source: 'mi', name: 'G' }],
        } });
        await expect(badge(page)).toHaveCount(0);

        await open(page, context, APP, { ignored: false, storage: {
            ilap_ignore_log: [{ appid: APP, ts: TS, source: 'curator', curatorId: 'preset_denuvo' }],
        } });
        await expect(badge(page)).toHaveCount(0);
        expect(await shadow(page)).toBe('');
    });

    test('the frame follows Steam\'s button, a rollback and the master switch', async ({ page, context }) => {
        const entry = { appid: APP, ts: TS, source: 'curator', curatorId: 'preset_denuvo' };
        await open(page, context, APP, { storage: { ilap_ignore_log: [entry] } });
        await expect(badge(page)).toHaveCount(1);

        // Un-ignored with Steam's own button, then ignored again.
        await flip(page, false);
        await expect(badge(page)).toHaveCount(0);
        expect(await shadow(page)).toBe('');
        await flip(page, true);
        await expect(badge(page)).toHaveCount(1);

        // The extension off and on.
        await setExtensionStorage(context, { ilap_master_enabled: false });
        await expect(badge(page)).toHaveCount(0);
        await setExtensionStorage(context, { ilap_master_enabled: true });
        await expect(badge(page)).toHaveCount(1);

        // Rolled back by the extension while the page still says Ignored.
        const log = await getExtensionStorage(context, ['ilap_ignore_log_index']);
        const key = 'ilap_ignore_log_c' + log.ilap_ignore_log_index.last;
        await setExtensionStorage(context, { [key]: [Object.assign({}, entry, { undoneAt: TS + 1000 })] });
        await expect(badge(page)).toHaveCount(0);
        expect(await shadow(page)).toBe('');
    });
});
