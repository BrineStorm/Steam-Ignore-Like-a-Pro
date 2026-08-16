// Runs once before the suite: snapshot the account's currently-ignored appids so
// globalTeardown can un-ignore exactly the games the tests add. See _cleanup.js.

const fs = require('fs');
const path = require('path');
const { SNAPSHOT_FILE, newContext, fetchIgnored } = require('./_cleanup.js');

module.exports = async () => {
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
};
