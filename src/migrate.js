// SPDX-License-Identifier: GPL-3.0-or-later
//
// Two profile migrations, in the service worker on Chromium and the background
// script on Firefox (the `--test` build replaces it with an empty worker):
//
//  1. the default `ilap_surface_mode` on install and update — a fresh install
//     gets the on-page widget, a profile from a build without the key keeps the
//     toolbar popup;
//  2. reaping the service worker's sessionid cache where no worker exists.
(function () {
    'use strict';

    // The onStartup re-assert below yields to an install/update in this lifetime.
    let installEventSeen = false;

    chrome.runtime.onInstalled.addListener((details) => {
        installEventSeen = true;
        if (details.reason === 'install') {
            // Written, not left to the read-time default, so a later update sees
            // the key. ilap_intro_glow highlights the easy-to-miss chevron until
            // its first click.
            chrome.storage.local.set({ ilap_surface_mode: 'widget', ilap_intro_glow: true });
        } else if (details.reason === 'update') {
            // A missing key: a build that only had the popup, so keep it. A value
            // present is the user's. ilap_update_glow is a one-shot highlight for
            // the next popup open, armed only here.
            chrome.storage.local.get('ilap_surface_mode', (d) => {
                // A storage error is not "absent": a wrong no-op is recoverable,
                // a wrong migration is not.
                if (chrome.runtime.lastError) return;
                if (d.ilap_surface_mode == null) {
                    chrome.storage.local.set({ ilap_surface_mode: 'popup', ilap_update_glow: true });
                }
            });
        }
    });

    // --- the sessionid cache, where nothing can use it ----------------------
    // `ilap_sw_sid` is a copy of the Steam session token, cached by every store
    // page FOR the Chromium background drain (src/background.js) — the worker
    // cannot read cookies itself. That worker paces itself with chrome.alarms, so
    // a world without that API has no such drain and no reason to hold the token.
    //
    // On Firefox that was always true — the queue is drained by the store page,
    // where the real cookie is — but builds before 1.3.0 loaded the hand-off
    // script there anyway, and the reaper that drops a dead sid lives in the
    // worker Firefox does not have. So an upgraded profile would keep the copy
    // for good: nothing left to read it, and nothing left to clear it. The halt
    // flag is its pair and just as meaningless here.
    //
    // Top-level rather than inside onInstalled: this must not depend on catching
    // one event in one lifetime. Removing an absent key is a no-op that writes
    // nothing and fires no onChanged, so it costs a startup profile nothing.
    if (!chrome.alarms) {
        chrome.storage.local.remove(['ilap_sw_sid', 'ilap_sw_halt']);
    }

    // At startup, write 'widget' if the key is still absent: an install write
    // lost to a suspended context would otherwise make a later update migrate the
    // profile to 'popup'. Readers already assume 'widget', so nothing visible
    // changes. Delayed, and skipped when onInstalled fired in this lifetime: an
    // update while the browser was closed fires both, and that path owns the key.
    chrome.runtime.onStartup.addListener(() => {
        setTimeout(() => {
            if (installEventSeen) return;
            chrome.storage.local.get('ilap_surface_mode', (d) => {
                if (chrome.runtime.lastError) return;
                if (d.ilap_surface_mode == null) {
                    // No glow: which write was lost cannot be known.
                    chrome.storage.local.set({ ilap_surface_mode: 'widget' });
                }
            });
        }, 3000);
    });
})();
