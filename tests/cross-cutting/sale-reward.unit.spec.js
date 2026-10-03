// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const { loadSaleReward } = require('../_sale-reward.js');

// SaleReward (src/sale-reward.js) as a Node unit — no browser, no Steam. What it
// decides is whether a queue automator may advance a queue on its own, so the
// contract is about which answers unlock and which do not:
//   - no sale reward running, or an earned one → 'allowed';
//   - a running one not yet earned → 'pending';
//   - a running one whose status cannot be read → 'unknown', and so does a
//     definition whose shape is not the one Steam serves today: a renamed field
//     must not read as "no sale".
// And about what it costs: the answers that let a run go on ("earned", "no
// sale") are cached for every tab, each for as long as it can hold, so one
// advance per game sends next to nothing; the ones that stop a run are asked
// again each time, which only ever happens at a human pace.
// And about whose answer it is: an account's progress is never reused for
// another account signed into the same browser.
// The two responses are the shapes Steam returned live (Autumn Sale): an
// account at 0/3 and one at 3/3.

const NOW = 1790900000;   // seconds, inside the window below
const DEF = {
    sale_reward_def_id: 9, appid: 5308810, virtual_item_reward_event_id: 69,
    rtime_start_time: 1790873100, rtime_end_time: 1791478800,
    num_items_per_def: 3, reward_def_type: 2,
};
const claimed = (earned) => ({
    num_items_granted: earned, num_items_earned: earned, current_def: DEF,
});
const RUNNING = (earned) => ({ GetCurrentDefinition: { definition: DEF }, GetClaimedSaleRewards: claimed(earned) });

// A webapi token as Steam issues it: a JWT whose `sub` is the SteamID.
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub) => `${b64url({ typ: 'JWT', alg: 'EdDSA' })}.${b64url({ iss: 'steam', sub, aud: ['web:store'] })}.sig`;
const ME = '76561198000000001';
const OTHER = '76561198000000002';

// `answers` maps an API method to its `response` (null → a failed request);
// `clock.ms` is the time the module sees, movable by a test.
function load({ answers = {}, token = jwt(ME), store = {} } = {}) {
    const requests = [];
    const loaded = loadSaleReward({
        fetchWithTimeout: async (url) => {
            const method = url.match(/ISaleItemRewardsService\/(\w+)\//)[1];
            requests.push({ method, url });
            const answer = answers[method];
            if (answer === null || answer === undefined) return { ok: false, json: async () => ({}) };
            return { ok: true, json: async () => ({ response: answer }) };
        },
        token, store, nowMs: NOW * 1000,
    });
    const { SaleReward } = loaded;
    return Object.assign(loaded, { requests, cached: () => store[SaleReward.CACHE_KEY] });
}

test.describe('SaleReward.check — the verdict (unit)', () => {

    test('no sale reward running → allowed, without touching the token', async () => {
        const { SaleReward, requests } = load({ answers: { GetCurrentDefinition: {} } });
        expect(await SaleReward.check()).toBe('allowed');
        expect(requests.map(r => r.method)).toEqual(['GetCurrentDefinition']);
    });

    test('a definition outside its window → allowed', async () => {
        const ended = Object.assign({}, DEF, { rtime_end_time: NOW - 1 });
        const { SaleReward } = load({ answers: { GetCurrentDefinition: { definition: ended } } });
        expect(await SaleReward.check()).toBe('allowed');
    });

    test('running and unearned (0/3) → pending', async () => {
        const { SaleReward } = load({ answers: RUNNING(0) });
        expect(await SaleReward.check()).toBe('pending');
    });

    test('a zero count left out of the answer still reads as unearned', async () => {
        const { SaleReward } = load({
            answers: { GetCurrentDefinition: { definition: DEF }, GetClaimedSaleRewards: { current_def: DEF } },
        });
        expect(await SaleReward.check()).toBe('pending');
    });

    test('running and earned (3/3) → allowed', async () => {
        const { SaleReward } = load({ answers: RUNNING(3) });
        expect(await SaleReward.check()).toBe('allowed');
    });

    test('numbers sent as strings read as the same numbers', async () => {
        const asStrings = Object.assign({}, DEF, {
            rtime_start_time: String(DEF.rtime_start_time), rtime_end_time: String(DEF.rtime_end_time),
            num_items_per_def: '3',
        });
        for (const [earned, verdict] of [['3', 'allowed'], ['1', 'pending']]) {
            const { SaleReward } = load({
                answers: { GetCurrentDefinition: { definition: asStrings }, GetClaimedSaleRewards: { num_items_earned: earned } },
            });
            expect(await SaleReward.check()).toBe(verdict);
        }
    });

    test('the token goes to Steam\'s API host only, in the claimed-rewards request', async () => {
        const { SaleReward, requests } = load({ answers: RUNNING(0) });
        await SaleReward.check();
        for (const r of requests) expect(r.url.startsWith('https://api.steampowered.com/')).toBe(true);
        expect(requests.find(r => r.method === 'GetCurrentDefinition').url).not.toContain('access_token');
        expect(requests.find(r => r.method === 'GetClaimedSaleRewards').url)
            .toContain('access_token=' + encodeURIComponent(jwt(ME)));
    });

    const UNKNOWN_CASES = [
        ['the definition request fails', { answers: { GetCurrentDefinition: null } }],
        ['the definition has no readable window',
            { answers: { GetCurrentDefinition: { definition: { num_items_per_def: 3 } } } }],
        ['the definition has no item count',
            { answers: { GetCurrentDefinition: { definition: Object.assign({}, DEF, { num_items_per_def: undefined }) } } }],
        ['the page carries no token (signed out)', { token: '', answers: { GetCurrentDefinition: { definition: DEF } } }],
        ['the page carries no config at all', { token: undefined, answers: { GetCurrentDefinition: { definition: DEF } } }],
        ['the claimed-rewards request fails',
            { answers: { GetCurrentDefinition: { definition: DEF }, GetClaimedSaleRewards: null } }],
        // A null is not a zero: an explicit null window must not read as one that
        // ended in 1970, i.e. "no sale".
        ['the window is null',
            { answers: { GetCurrentDefinition: { definition: Object.assign({}, DEF, { rtime_start_time: null, rtime_end_time: null }) } } }],
        ['the item count is zero',
            { answers: { GetCurrentDefinition: { definition: Object.assign({}, DEF, { num_items_per_def: 0 }) } } }],
        // An answer with no definition is "no sale" only when it is empty, as
        // Steam serves it for a reward type with nothing running: a definition
        // renamed or moved must not unlock.
        ['the definition is not where it was',
            { answers: { GetCurrentDefinition: { sale_definition: DEF, reward_items: [] } } }],
        ['the earned count is unreadable',
            { answers: { GetCurrentDefinition: { definition: DEF }, GetClaimedSaleRewards: { num_items_earned: 'n/a' } } }],
    ];
    for (const [name, opts] of UNKNOWN_CASES) {
        test(`while a sale runs, ${name} → unknown`, async () => {
            const { SaleReward } = load(opts);
            expect(await SaleReward.check()).toBe('unknown');
        });
    }
});

test.describe('SaleReward.check — what it costs (unit)', () => {

    // The two answers that let a run go on are reused, each for as long as it
    // holds; a check inside sends nothing, one past it asks again.
    const HOLDS = [
        ['earned', RUNNING(3), DEF.rtime_end_time * 1000 - NOW * 1000],
        // Short: a sale can begin inside it, and a run on an old "no sale" would
        // be advancing on its own into that sale.
        ['no sale', { GetCurrentDefinition: {} }, 60000],
    ];
    for (const [name, answers, holdsMs] of HOLDS) {
        test(`an ${name} answer is reused for ${holdsMs} ms, then asked again`, async () => {
            const { SaleReward, requests, clock } = load({ answers });
            expect(await SaleReward.check()).toBe('allowed');
            const sent = requests.length;

            clock.ms += holdsMs - 1;
            expect(await SaleReward.check()).toBe('allowed');
            expect(requests.length).toBe(sent);

            clock.ms += 1;
            await SaleReward.check();
            expect(requests.length).toBeGreaterThan(sent);
        });
    }

    // The two that stop a run are asked again every time: only ever at a human
    // pace (a Start clicked again, a Next pressed by hand), so there is nothing
    // to save, and a queue finished by hand or a recovered network counts at once.
    for (const [name, answers, verdict] of [
        ['unearned', RUNNING(0), 'pending'],
        ['unreadable', { GetCurrentDefinition: null }, 'unknown'],
    ]) {
        test(`an ${name} answer is never reused`, async () => {
            const { SaleReward, requests } = load({ answers });
            expect(await SaleReward.check()).toBe(verdict);
            const sent = requests.length;
            expect(await SaleReward.check()).toBe(verdict);
            expect(requests.length).toBe(sent * 2);
        });
    }

    test('a queue finished by hand counts at the next check', async () => {
        const store = {};
        expect(await load({ answers: RUNNING(0), store }).SaleReward.check()).toBe('pending');
        expect(await load({ answers: RUNNING(3), store }).SaleReward.check()).toBe('allowed');
    });

    test('a refusal replaces a "no sale" another tab cached: no tab keeps advancing on it', async () => {
        const store = {};
        await load({ answers: { GetCurrentDefinition: {} }, store }).SaleReward.check();
        // A Start clicked as the sale begins asks fresh and is refused...
        expect(await load({ answers: RUNNING(0), store }).SaleReward.check({ fresh: true })).toBe('pending');
        // ...and a running loop in another tab, asking from the cache, is too.
        expect(await load({ answers: RUNNING(0), store }).SaleReward.check()).toBe('pending');
    });

    test('a sale due to start is not cached past its start', async () => {
        const upcoming = Object.assign({}, DEF, { rtime_start_time: NOW + 30, rtime_end_time: NOW + 86400 });
        const { SaleReward, cached } = load({ answers: { GetCurrentDefinition: { definition: upcoming } } });
        expect(await SaleReward.check()).toBe('allowed');
        expect(cached()).toEqual({ status: 'none', until: (NOW + 30) * 1000, account: ME });
    });

    test('the answer is shared through storage: another tab asks nothing', async () => {
        const store = {};
        const first = load({ answers: RUNNING(3), store });
        await first.SaleReward.check();
        const second = load({ answers: RUNNING(3), store });
        expect(await second.SaleReward.check()).toBe('allowed');
        expect(second.requests).toHaveLength(0);
    });

    test('checks made while one is in flight share it: one round of requests', async () => {
        const { SaleReward, requests } = load({ answers: RUNNING(0) });
        const verdicts = await Promise.all([SaleReward.check(), SaleReward.check(), SaleReward.check()]);
        expect(verdicts).toEqual(['pending', 'pending', 'pending']);
        expect(requests.map(r => r.method)).toEqual(['GetCurrentDefinition', 'GetClaimedSaleRewards']);
    });

    test('a record from an ended sale, or one implausibly far out, is not trusted', async () => {
        for (const record of [{ status: 'done', until: NOW * 1000 - 10, account: ME },
            { status: 'done', until: NOW * 1000 + 400 * 86400000, account: ME },
            { status: 'bogus', until: NOW * 1000 + 1000, account: ME }]) {
            const { SaleReward } = load({ answers: RUNNING(0), store: { ilap_sale_reward: record } });
            expect(await SaleReward.check()).toBe('pending');
        }
    });
});

test.describe('SaleReward.check — whose answer it is (unit)', () => {

    test('an earned reward is not reused for another account in the same browser', async () => {
        const store = {};
        await load({ answers: RUNNING(3), store, token: jwt(ME) }).SaleReward.check();
        expect(store.ilap_sale_reward.account).toBe(ME);

        const other = load({ answers: RUNNING(0), store, token: jwt(OTHER) });
        expect(await other.SaleReward.check()).toBe('pending');
        expect(other.requests.length).toBeGreaterThan(0);
        expect(store.ilap_sale_reward.account).toBe(OTHER);
    });

    test('a token whose account cannot be read reuses no earned answer', async () => {
        const store = {};
        await load({ answers: RUNNING(3), store, token: 'not-a-jwt' }).SaleReward.check();
        const again = load({ answers: RUNNING(0), store, token: 'not-a-jwt' });
        expect(await again.SaleReward.check()).toBe('pending');
        expect(again.requests.length).toBeGreaterThan(0);
    });

    test('"no sale running" holds for every account', async () => {
        const store = {};
        await load({ answers: { GetCurrentDefinition: {} }, store, token: jwt(ME) }).SaleReward.check();
        const other = load({ answers: RUNNING(0), store, token: jwt(OTHER) });
        expect(await other.SaleReward.check()).toBe('allowed');
        expect(other.requests).toHaveLength(0);
    });
});

test.describe('SaleReward.check — a Start the user clicked (unit)', () => {

    test('a fresh check asks again over a cached "no sale": a run never starts on an answer from before a sale', async () => {
        const store = {};
        await load({ answers: { GetCurrentDefinition: {} }, store }).SaleReward.check();
        // The sale has begun since.
        const after = load({ answers: RUNNING(0), store });
        expect(await after.SaleReward.check({ fresh: true })).toBe('pending');
        expect(after.requests.length).toBeGreaterThan(0);
    });

    test('a fresh check still reuses an earned answer', async () => {
        const store = {};
        await load({ answers: RUNNING(3), store }).SaleReward.check();
        const again = load({ answers: RUNNING(3), store });
        expect(await again.SaleReward.check({ fresh: true })).toBe('allowed');
        expect(again.requests).toHaveLength(0);
    });
});
