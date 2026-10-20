// Runs once before the suite: snapshot the account's currently-ignored appids so
// globalTeardown can un-ignore exactly the games the tests add (see _cleanup.js),
// and ask whether a Steam sale's queue reward is still to be earned, which keeps
// the live queue specs out of the queue (see _sale-reward.js).

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { SNAPSHOT_FILE, AUTH_FILE, newContext, fetchIgnored } = require('./_cleanup.js');
const { liveSaleRewardVerdict, VERDICT_ENV } = require('./_sale-reward.js');

module.exports = async () => {
    await snapshotIgnored();
    await askSaleReward();
};

// Workers inherit the environment globalSetup leaves behind.
async function askSaleReward() {
    let browser;
    let verdict = 'unknown';
    let detail = 'no answer';
    try {
        browser = await chromium.launch();
        const context = await browser.newContext(
            fs.existsSync(AUTH_FILE) ? { storageState: AUTH_FILE } : {});
        ({ verdict, detail } = await liveSaleRewardVerdict(await context.newPage()));
    } catch (e) {
        console.warn(`[sale-reward] setup: check failed (${e.message}).`);
    } finally {
        if (browser) await browser.close();
    }
    process.env[VERDICT_ENV] = verdict;
    if (verdict === 'allowed') {
        console.log(`[sale-reward] setup: ${detail} → allowed — the live queue specs run.`);
    } else {
        console.warn(`[sale-reward] setup: ${detail} → ${verdict} — the live Discovery Queue specs SKIP (earn the sale reward by hand first).`);
    }
}

async function snapshotIgnored() {
    // On a fresh machine (a CI runner) the state dir does not exist yet, and the
    // no-op marker below is written from a catch block — an ENOENT there would
    // escape the handler and fail the whole run before a single test starts.
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });

    let ctx;
    try {
        ctx = await newContext();
        const snap = await fetchIgnored(ctx);
        if (!snap || snap.ownedCount === 0) {
            // Not logged in (anonymous userdata) — write a no-op marker so teardown
            // skips rather than diffing against an empty "before" set.
            fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ ok: false, ts: Date.now() }));
            console.warn('[cleanup] setup: not logged in or userdata empty — cleanup disabled for this run.');
            return;
        }
        fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ ok: true, ids: snap.ids, ts: Date.now() }));
        console.log(`[cleanup] setup: snapshot of ${snap.ids.length} ignored apps saved.`);
    } catch (e) {
        fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ ok: false, ts: Date.now() }));
        console.warn(`[cleanup] setup failed (${e.message}) — cleanup disabled for this run.`);
    } finally {
        if (ctx) await ctx.dispose();
    }
}
