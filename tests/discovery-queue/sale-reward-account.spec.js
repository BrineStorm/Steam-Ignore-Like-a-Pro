// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('../_fixtures.js');
const { setExtensionStorage, getExtensionStorage } = require('../_extension.js');
const { interceptIgnoreApi } = require('../curator/_helpers.js');
const { routeSaleReward } = require('../_steam-routes.js');
const { SEL, openQueueModal } = require('./_modal.js');

// The sale-reward answer is bound to an account (src/sale-reward.js): the
// account is read from the page's own webapi token, as the `sub` claim of its
// JWT. The unit spec can only feed it a token made up to that shape; this one
// takes the real token off a signed-in store page and checks the account the
// extension reads from it is the SteamID Steam's own page says is signed in
// (`data-userinfo`, an independent source). The reward itself is route-faked to
// 0 of 3, so the token reaches no server and the verdict is the same whatever
// the account has earned.

// The first SteamID64 (account 0): a signed-in test account is never it.
const OTHER = '76561197960265728';

test.describe('Discovery Queue — sale reward bound to the signed-in account', () => {

    test('an earned answer cached for another account is not reused; the new one is this account\'s', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context);
        await routeSaleReward(context, { earned: 0 });
        await setExtensionStorage(context, {
            ilap_sale_reward: { status: 'done', until: Date.now() + 86400000, account: OTHER },
        });
        await openQueueModal(page);

        const me = await page.evaluate(() => {
            try {
                return JSON.parse(document.getElementById('application_config').dataset.userinfo);
            } catch (e) {
                return null;
            }
        });
        expect(me && me.logged_in, 'the store page is signed out: refresh the session (npm run test:auth)').toBe(true);
        const steamid = String(me.steamid);
        expect(steamid, 'data-userinfo carries no SteamID64 to compare with').toMatch(/^7656119\d{10}$/);

        const btn = page.locator(SEL.button);
        await expect(btn).toBeVisible({ timeout: 10000 });
        await btn.click();
        // Refused: the other account's 'done' did not unlock this one.
        await expect(btn).toHaveClass(/locked/, { timeout: 10000 });

        const { ilap_sale_reward: record } = await getExtensionStorage(context, ['ilap_sale_reward']);
        expect(record.status).toBe('pending');
        expect(record.account, 'the account read from the real webapi token').toBe(steamid);
        expect(calls).toHaveLength(0);
    });
});
