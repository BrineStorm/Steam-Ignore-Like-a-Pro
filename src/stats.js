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

    window.ILAP = window.ILAP || {};
    window.ILAP.StatsLogic = {
        increment, pushHistory, nextState,
        COUNT_KEY, HISTORY_KEY, LAST_KEY, HISTORY_LIMIT
    };

})();
