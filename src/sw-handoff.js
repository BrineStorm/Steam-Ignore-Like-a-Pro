// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The page's half of the service-worker drain (src/background.js). The worker
    // cannot read document.cookie, so every store page caches the sessionid for
    // it; the same visit clears the halt flag, which the worker sets after
    // repeated failed POSTs. Written only on change: a same-value write would
    // still wake the worker through onChanged.
    //
    // Chromium only, and the FIREFOX MANIFEST DELIBERATELY LEAVES THIS FILE OUT:
    // Firefox drains from the content script, so there nothing ever reads the
    // cached sessionid — and nothing clears it either (the reaper that drops a
    // sid Steam no longer honours lives in the worker). A token written on every
    // store page and never used is storage we have no reason to keep.
    const { SW_SID_KEY, SW_HALT_KEY } = window.ILAP.Curator.Store;
    const sid = window.ILAP.getSessionID();
    if (sid) {
        chrome.storage.local.get({ [SW_SID_KEY]: null, [SW_HALT_KEY]: false }, (d) => {
            if (d[SW_SID_KEY] !== sid || d[SW_HALT_KEY]) {
                chrome.storage.local.set({ [SW_SID_KEY]: sid, [SW_HALT_KEY]: false });
            }
        });
    }
})();
