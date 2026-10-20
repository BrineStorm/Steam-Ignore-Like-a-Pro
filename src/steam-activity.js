// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // What the user does on a Steam store page, told to the ignore gate
    // (src/gate.js). Input marks the user active, which slows the background
    // drain. Every ignore POST the page sends joins the paced stream, and a 429
    // on it escalates the shared penalty. Content script only. With the master
    // switch off nothing is written: a disabled extension paces nothing.

    const Gate = window.ILAP.IgnoreGate;
    const OwnPosts = window.ILAP.OwnIgnorePosts;
    let enabled = false;

    // Input on the extension's own UI (the widget, the toast, the curator
    // controls) sends nothing to Steam by itself. Counting it would slow the
    // first seconds of every drain the widget starts.
    const isOwnUi = (node) => {
        if (!node || node.nodeType !== 1) return false;
        const cls = typeof node.className === 'string' ? node.className : '';
        return /^ilap-/.test(node.id) || /(^|\s)ilap-/.test(cls);
    };
    const quiet = (p) => p.catch(() => {});

    function onInput(e) {
        if (!enabled || !e.isTrusted) return;
        if (e.composedPath().some(isOwnUi)) return;
        quiet(Gate.noteUserActivity());
    }

    // Steam posts an ignore by XHR or by fetch, with or without the trailing
    // slash (the React calendar drops it). Verified live on the app page, search
    // and the personal calendar. The entry has no method; nothing on the store
    // GETs this path.
    const IGNORE_PATH = /^\/recommended\/ignorerecommendation\/?$/;
    function isIgnoreRequest(name) {
        try {
            const url = new URL(name);
            return url.origin === location.origin && IGNORE_PATH.test(url.pathname);
        } catch (e) { return false; }
    }

    function onEntries(list) {
        if (!enabled) return;
        for (const entry of list.getEntries()) {
            if (!isIgnoreRequest(entry.name)) continue;
            // Our own POST: its caller already counted it and reported its 429.
            if (OwnPosts.claim(entry.startTime)) continue;
            quiet(Gate.noteNativeIgnore(entry.responseStatus || 0));
        }
    }

    window.ILAP.MasterSwitch.watch({
        // The page load itself sends requests to Steam.
        onInit: (on) => { enabled = on; if (on) quiet(Gate.noteUserActivity()); },
        onChange: (on) => { enabled = on; }
    });
    window.addEventListener('pointerdown', onInput, true);
    window.addEventListener('keydown', onInput, true);
    new PerformanceObserver(onEntries).observe({ type: 'resource' });
})();
