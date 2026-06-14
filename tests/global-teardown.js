// Runs once after the suite: un-ignore exactly the games the tests added (the diff
// between the post-run ignore set and the pre-run snapshot from global-setup).
// Reads strictly the diff, capped at MAX_CLEANUP, so the user's pre-existing
// ignores are never touched. See _cleanup.js.

const fs = require('fs');
const { SNAPSHOT_FILE, MAX_CLEANUP, newContext, sessionId, fetchIgnored, unignore } = require('./_cleanup.js');

module.exports = async () => {
    if (!fs.existsSync(SNAPSHOT_FILE)) {
        console.warn('[cleanup] teardown: no snapshot — skipping.');
        return;
    }
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    if (!snapshot.ok) {
        console.warn('[cleanup] teardown: snapshot marked not-ok — skipping.');
        fs.rmSync(SNAPSHOT_FILE, { force: true });
        return;
    }

    let ctx;
    try {
        ctx = await newContext();
        const after = await fetchIgnored(ctx);
        if (!after || after.ownedCount === 0) {
            console.warn('[cleanup] teardown: not logged in now — skipping (no removals).');
            return;
        }

        const before = new Set(snapshot.ids);
        const diff = after.ids.filter(id => !before.has(id));

        if (diff.length === 0) {
            console.log('[cleanup] teardown: no test ignores to remove.');
            return;
        }
        if (diff.length > MAX_CLEANUP) {
            console.error(`[cleanup] teardown: diff of ${diff.length} exceeds cap (${MAX_CLEANUP}) — REFUSING to mass-unignore. Nothing removed.`);
            return;
        }

        const sid = sessionId();
        const removed = [];
        const failed = [];
        for (const appid of diff) {
            const ok = await unignore(ctx, sid, appid);
            (ok ? removed : failed).push(appid);
        }

        // Verify against fresh userdata: nothing from the diff should remain.
        const final = new Set((await fetchIgnored(ctx)).ids);
        const remaining = diff.filter(id => final.has(id));

        console.log(`[cleanup] teardown: removed ${removed.length}/${diff.length} test ignores [${removed.join(', ')}].`);
        if (failed.length) console.warn(`[cleanup] teardown: ${failed.length} unignore call(s) reported failure [${failed.join(', ')}].`);
        if (remaining.length) console.warn(`[cleanup] teardown: ${remaining.length} still present after removal [${remaining.join(', ')}].`);

        fs.rmSync(SNAPSHOT_FILE, { force: true });
    } catch (e) {
        console.warn(`[cleanup] teardown failed (${e.message}) — no further removals.`);
    } finally {
        if (ctx) await ctx.dispose();
    }
};
