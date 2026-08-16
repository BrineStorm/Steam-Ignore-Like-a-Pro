// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The "Last Ignored" record — its key names, its cap and the two pure
    // transforms over it — exposed as window.ILAP.StatsLogic and shared by the
    // TWO worlds that WRITE it: the content script (utils.js StatsManager) and
    // the MV3 service worker (background.js's saveStats shim, which records a
    // drained manual-ignore job). Loaded before utils.js in content_scripts and
    // in the worker's importScripts; popup.html only READS these keys (by name,
    // in ui/popup_main.js) and does not load this file.
    //
    // Pure: no chrome.*, no DOM. The chrome.storage read-modify-write AROUND it
    // stays per-world — that half is the knowingly-duplicated storage plumbing
    // whose canonical note lives in src/curator/store.js. The split is the same
    // one escape.js and steam-net.js apply: what can be one definition is one.
    // A "if you change the shape here, visit the sibling" comment is not a
    // substitute — the name normalizers carried exactly that comment and had
    // drifted anyway.

    const COUNT_KEY = 'ilap_ignored_count';
    const HISTORY_KEY = 'ilap_ignored_history';
    const LAST_KEY = 'ilap_last_ignored_name';
    const HISTORY_LIMIT = 20;   // max entries kept in ilap_ignored_history

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

    function pushHistory(currentHistory, name, source) {
        return [{ name, source }, ...(currentHistory || [])].slice(0, HISTORY_LIMIT);
    }

    // The complete next state for ONE recorded ignore, ready to hand straight to
    // chrome.storage.local.set. Both worlds go through this, so neither can
    // spell the key set differently or forget one of the three.
    // `current` is the { COUNT_KEY, HISTORY_KEY } snapshot the caller just read;
    // `name` must already be sanitized (Sanitizer.sanitizeName) by the caller,
    // which is where the storage boundary is.
    function nextState(current, name, source) {
        current = current || {};
        return {
            [COUNT_KEY]: increment(current[COUNT_KEY]),
            [HISTORY_KEY]: pushHistory(current[HISTORY_KEY], name, source),
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

    window.ILAP = window.ILAP || {};
    window.ILAP.StatsLogic = {
        increment, decrement, pushHistory, nextState, countState, uncountState,
        COUNT_KEY, HISTORY_KEY, LAST_KEY, HISTORY_LIMIT
    };

})();
