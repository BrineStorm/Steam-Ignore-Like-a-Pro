// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The "Last Ignored" record: its key names, its cap and the pure transforms
    // over it. Written by the content script (utils.js StatsManager) and the
    // service worker (background.js); popup.html loads it for the key names.
    // Pure: the chrome.storage read-modify-write around it stays per world.

    const COUNT_KEY = 'ilap_ignored_count';
    const HISTORY_KEY = 'ilap_ignored_history';
    const LAST_KEY = 'ilap_last_ignored_name';
    const HISTORY_LIMIT = 20;   // max entries kept in ilap_ignored_history
    // Every history label (stored, so never renamed): the two queue automators,
    // Manual Ignore's two reasons, and the four kinds of queue job that leave
    // one entry when they finish (jobEntry).
    const SOURCE = Object.freeze({
        EQ: 'Explore Auto-Queue',
        DQ: 'Queue',
        MI_DEFAULT: 'Default Ignore',
        MI_PLAYED: 'Played Elsewhere',
        CURATOR: 'Curator',
        PRESET: 'Built-in List',
        BUNDLE: 'Bundle',
        UNDO: 'Undo',
    });

    // An MI entry's reason → its label. 2 is the Played Elsewhere swipe; a reason
    // read back from storage may be a string. The badge colour in
    // manual-ignore/ui.js is a separate presentation of the same reason.
    const miSourceLabel = (reason) => (Number(reason) === 2 ? SOURCE.MI_PLAYED : SOURCE.MI_DEFAULT);

    function increment(currentCount) {
        return (currentCount || 0) + 1;
    }

    // Floored at 0 on purpose: the counter holds the ignores THIS extension has
    // performed, so a rollback of a game ignored before it was installed (the
    // badge gesture answers to Steam's list, not to ours) has no increment of
    // its own to take back.
    function decrement(currentCount) {
        return Math.max(0, (currentCount || 0) - 1);
    }

    // Array.isArray, not `|| []`: a stored value that is neither an array nor
    // falsy (a corrupt or hand-edited record) is truthy and not spreadable, and
    // the TypeError would be thrown inside a chrome.storage callback — where it
    // wedges the caller's write chain rather than failing one save (see
    // StatsManager in src/utils.js).
    // `appid` lets the popup open the game's store page from its entry. Kept
    // only when it is a plain number: the popup builds a URL from it.
    function pushHistory(currentHistory, name, source, appid) {
        const prev = Array.isArray(currentHistory) ? currentHistory : [];
        const entry = /^\d+$/.test(String(appid)) ? { name, source, appid: String(appid) } : { name, source };
        return [entry, ...prev].slice(0, HISTORY_LIMIT);
    }

    // The complete next state for ONE recorded ignore, ready to hand straight to
    // chrome.storage.local.set. Both worlds go through this, so neither can
    // spell the key set differently or forget one of the three.
    // `current` is the { COUNT_KEY, HISTORY_KEY } snapshot the caller just read;
    // `name` must already be sanitized (Sanitizer.sanitizeName) by the caller,
    // which is where the storage boundary is.
    function nextState(current, name, source, appid) {
        current = current || {};
        return {
            [COUNT_KEY]: increment(current[COUNT_KEY]),
            [HISTORY_KEY]: pushHistory(current[HISTORY_KEY], name, source, appid),
            [LAST_KEY]: name
        };
    }

    // The count-only half of the record, for an ignore that must be COUNTED but
    // not SHOWN: a drained curator ignore. The curator path carries no name
    // (enumeration reads appids only), and a job of several hundred would flush
    // the 20-entry "Last Ignored" history of hand-made swipes in one pass — so
    // it lands in the total and nowhere else.
    function countState(current) {
        return { [COUNT_KEY]: increment((current || {})[COUNT_KEY]) };
    }

    // Its mirror, for a CONFIRMED un-ignore: the total counts ignores that are
    // still standing, so a rollback takes its ignore back out of it. The history
    // is deliberately NOT rewound — it is a "what did I ignore lately" log, and
    // an entry that was rolled back still happened (the undo applet reads the
    // separate ilap_ignore_log for what is undoable). Count-only for the same
    // reason curator ignores are: an undo job drains in batches and carries no
    // name, so there is nothing to put in Last Ignored anyway.
    function uncountState(current) {
        return { [COUNT_KEY]: decrement((current || {})[COUNT_KEY]) };
    }

    // The shown-but-not-counted half: a swipe that changed the reason of a game
    // already on Steam's list. It is in Last Ignored like any swipe, but the
    // list did not grow, so the total stays.
    function historyState(current, name, source, appid) {
        return {
            [HISTORY_KEY]: pushHistory((current || {})[HISTORY_KEY], name, source, appid),
            [LAST_KEY]: name
        };
    }

    // A finished queue job as ONE history entry: a curator's list, a built-in
    // list, a bundle or an undo. Its games stay out (a job of hundreds would flush the
    // hand-made swipes), the job itself goes in. `name` is what the entry is
    // matched by in Last Ignored, the popup draws the label from the rest
    // (popup_main.js historyLabel). null for a job that leaves no entry: the
    // two gesture jobs record each game, and an unknown type records nothing.
    // Each entry keeps its job's id (jobState).
    function jobEntry(job) {
        const entry = kindEntry(job);
        if (entry && job.id) entry.jobId = String(job.id);
        return entry;
    }
    function kindEntry(job) {
        if (!job) return null;
        const type = job.type || 'curator';
        if (type === 'curator') {
            const id = /^\d+$/.test(String(job.curatorId)) ? String(job.curatorId) : null;
            const entry = { name: String(job.curatorName || job.curatorId || ''), source: SOURCE.CURATOR, filter: job.filter || '' };
            if (id) entry.curatorId = id;
            return entry;
        }
        if (type === 'preset') return { name: String(job.presetKey || ''), source: SOURCE.PRESET, presetKey: String(job.presetKey || '') };
        if (type === 'bundle') {
            // `bundle` is the store path the popup opens, kept only in its known shape.
            const m = String(job.curatorId || '').match(/^(bundle|sub)_(\d+)$/);
            const entry = { name: String(job.curatorName || ''), source: SOURCE.BUNDLE };
            if (m) entry.bundle = m[1] + '/' + m[2];
            return entry;
        }
        if (type === 'undo') {
            const entry = { name: 'undo', source: SOURCE.UNDO };
            if (job.scope && Number(job.scope.n) > 0) entry.scope = { n: Number(job.scope.n), unit: job.scope.unit };
            return entry;
        }
        return null;
    }

    // The history write for a finished job: shown, not counted (each of its
    // ignores was counted as it landed). Nothing for a job with no entry, nor
    // for one already in the history: two drainers that both swept the same
    // leftover job (drainer.js _collectDrained) record it once.
    function jobState(current, job) {
        const entry = jobEntry(job);
        if (!entry) return {};
        const prev = Array.isArray((current || {})[HISTORY_KEY]) ? current[HISTORY_KEY] : [];
        if (entry.jobId && prev.some(e => e && e.jobId === entry.jobId)) return {};
        return {
            [HISTORY_KEY]: [entry, ...prev].slice(0, HISTORY_LIMIT),
            [LAST_KEY]: entry.name
        };
    }

    // Steam's own size of the account's ignore list, as last read from
    // dynamicstore/userdata, with the counter above as it stood at that write.
    // The popup headlines the counter and shows this on hover: the counter only
    // knows what this extension did, Steam's list also contains ignores made before
    // install, elsewhere or on the site itself.
    const TOTAL_KEY = 'ilap_ignored_total';

    // The snapshot write for one userdata read of `size` ignored apps. Goes
    // through the same per-world chain as the counter writes, so `tallyAt` is
    // the counter at this write. An ignore counted between the read and the
    // write (another source in this tab, or the other world) is then off by one
    // in the hover tip until the next read replaces the snapshot.
    function totalState(current, size, now) {
        return { [TOTAL_KEY]: { total: size, tallyAt: (current || {})[COUNT_KEY] || 0, ts: now } };
    }

    // What the popup shows: Steam's total plus whatever the counter moved since
    // it was read, so a swipe shows at once instead of waiting for the next
    // read, and every read resets the estimate to Steam's number. null when
    // there has been no read yet: the counter is a different number, never a
    // stand-in for this one.
    function displayTotal(snapshot, count) {
        if (!snapshot || typeof snapshot.total !== 'number') return null;
        return Math.max(0, snapshot.total + ((count || 0) - (snapshot.tallyAt || 0)));
    }

    window.ILAP = window.ILAP || {};
    window.ILAP.StatsLogic = {
        increment, decrement, pushHistory, nextState, countState, uncountState, historyState,
        jobEntry, jobState,
        totalState, displayTotal,
        miSourceLabel, COUNT_KEY, HISTORY_KEY, LAST_KEY, TOTAL_KEY, HISTORY_LIMIT, SOURCE
    };

})();
