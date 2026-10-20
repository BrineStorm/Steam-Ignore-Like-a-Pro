// SPDX-License-Identifier: GPL-3.0-or-later
//
// src/queue-common/sale-reward.js in a `vm` sandbox, for the unit spec and the canary alike:
// both run the product's own code rather than a copy of its rules. The caller
// supplies the network (`fetchWithTimeout`, as SteamNet's), the page's token
// (`token`; undefined = no config element at all), the shared storage (`store`)
// and the clock (`nowMs`, movable through the returned `clock`).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'queue-common', 'sale-reward.js');

function loadSaleReward({ fetchWithTimeout, token, store = {}, nowMs = Date.now() }) {
    const clock = { ms: nowMs };
    const sandbox = {
        window: { ILAP: { SteamNet: { fetchWithTimeout } } },
        document: {
            getElementById: (id) => (id === 'application_config' && token !== undefined
                ? { dataset: { store_user_config: JSON.stringify({ webapi_token: token }) } }
                : null),
        },
        chrome: {
            storage: {
                local: {
                    get: (query, cb) => {
                        const out = {};
                        for (const [k, dflt] of Object.entries(query)) out[k] = k in store ? store[k] : dflt;
                        cb(out);
                    },
                    set: (obj, cb) => { Object.assign(store, obj); cb && cb(); },
                },
            },
        },
        Date: { now: () => clock.ms },
        JSON, Math, Number, Object, Promise, encodeURIComponent, atob,
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'sale-reward.js' });
    return { SaleReward: sandbox.window.ILAP.SaleReward, store, clock };
}

// The live suites walk Steam's real Discovery Queue: the Explore Queue specs
// navigate /explore/next/ and press Next, and merely opening the Discovery
// Queue modal makes Steam's page skip a card. During a sale that rewards going
// through the queue (stickers) that earns the reward with no human input —
// exactly what the product refuses to do.
// So the run asks the product's own check up front (global-setup), and every
// entry into a live queue skips unless the answer is 'allowed'.
const VERDICT_ENV = 'ILAP_SALE_REWARD';
const STORE = 'https://store.steampowered.com';

// The saved session's verdict: 'allowed' | 'pending' | 'unknown', from the
// product's check run against live Steam. Asked from a real store page, not a
// bare request: a saved session whose login cookie has lapsed reads signed-out
// to a request, while the page renews it on load (the queue specs run in a
// browser, so that is the session they act as) — and only the page then holds
// the account's own token.
// Resolves { verdict, detail }: `detail` is for the setup log — whose session
// it was and what Steam answered — so an 'allowed' on an account that earned
// the reward days ago reads as that, not as a guard that let the run through.
async function liveSaleRewardVerdict(page) {
    await page.goto(STORE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const token = await page.evaluate(() => {
        try {
            return JSON.parse(document.getElementById('application_config').dataset.store_user_config).webapi_token;
        } catch (e) {
            return null;
        }
    });
    const request = page.context().request;
    const answers = {};   // method name → response, as the product read it
    const { SaleReward } = loadSaleReward({
        token: token || undefined,
        fetchWithTimeout: async (url) => {
            const res = await request.get(url, { headers: { Origin: STORE } });
            const body = await res.json().catch(() => null);
            const method = url.match(/ISaleItemRewardsService\/(\w+)\//);
            if (method) answers[method[1]] = (body && body.response) || null;
            return { ok: res.ok(), json: async () => body };
        },
    });
    const verdict = await SaleReward.check();
    return { verdict, detail: describeAnswers(token, answers) };
}

// "account …1234, sale until YYYY-MM-DD, earned 3/3 (granted YYYY-MM-DD)".
function describeAnswers(token, answers) {
    const day = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
    let account = 'signed out (no token)';
    if (token) {
        try {
            const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
            account = `account …${String(sub).slice(-4)}`;
        } catch (e) {
            account = 'account unreadable';
        }
    }
    const parts = [account];
    const current = answers.GetCurrentDefinition;
    const def = current && current.definition;
    if (!current) parts.push('sale definition unreadable');
    else if (!def) parts.push('no sale reward running');
    else parts.push(`sale until ${day(Number(def.rtime_end_time))}`);
    const claimed = answers.GetClaimedSaleRewards;
    if (def && claimed) {
        const granted = (claimed.reward_items || []).map(r => Number(r.time_granted)).filter(Number.isFinite);
        parts.push(`earned ${claimed.num_items_earned || 0}/${def.num_items_per_def}`
            + (granted.length ? ` (granted ${day(Math.max(...granted))})` : ''));
    }
    return parts.join(', ');
}

// Call first thing in a helper that enters a live queue, inside the test.
// No verdict at all (global-setup did not run) counts as not allowed.
function skipUnlessQueueRewardSafe() {
    const { test } = require('@playwright/test');
    const verdict = process.env[VERDICT_ENV] || 'unknown';
    test.skip(verdict !== 'allowed', verdict === 'pending'
        ? 'A Steam sale queue reward is not earned on this account yet: go through one Discovery Queue by hand, then rerun'
        : 'Could not tell whether a Steam sale queue reward is pending, so the live queue is left alone');
}

module.exports = { loadSaleReward, liveSaleRewardVerdict, skipUnlessQueueRewardSafe, VERDICT_ENV };
