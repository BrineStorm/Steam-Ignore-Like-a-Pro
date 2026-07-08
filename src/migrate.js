// SPDX-License-Identifier: GPL-3.0-or-later
//
// One-shot install/update migration for the interface surface. This is the ONLY
// background context in the extension and it does NOTHING but listen for the
// install/update event — it never drains ignores (draining must run in a live
// Steam page; see the deliberate no-SW design in CLAUDE.md). Its sole job is to
// pick the default `ilap_surface_mode` so that:
//   • a FRESH install lands on the on-page widget (the new default surface), and
//   • a profile UPDATING from the old popup-only build (which never wrote the
//     key) stays on the toolbar popup it already knows.
// In the Playwright `--test` build, build.js overwrites `background` with an
// empty test service worker, so this listener never runs under test — keeping
// the whole suite unaffected by the migration.
(function () {
    'use strict';

    chrome.runtime.onInstalled.addListener((details) => {
        if (details.reason === 'install') {
            // Fresh install → the on-page widget. Persist it explicitly (don't
            // just lean on the read-time default) so a LATER update finds the key
            // present and won't mistake this profile for a pre-surface-key one.
            // ilap_intro_glow marks the widget's collapsed chevron with a permanent
            // gold halo until the first click — a first-time user has never seen
            // the on-page surface and the slim chevron is easy to miss.
            chrome.storage.local.set({ ilap_surface_mode: 'widget', ilap_intro_glow: true });
        } else if (details.reason === 'update') {
            // Update. A missing key means the profile comes from a build that
            // predates the surface switch (popup was the only surface) — keep it
            // on the popup. A value already there (widget, or an explicit popup
            // choice) is the user's and is left untouched.
            // ilap_update_glow arms a one-shot 5 s highlight for the next popup
            // open ("yes, this is still your extension"). It rides the same
            // absent-key condition, so LATER updates (key present) never re-arm it.
            chrome.storage.local.get('ilap_surface_mode', (d) => {
                if (d.ilap_surface_mode == null) {
                    chrome.storage.local.set({ ilap_surface_mode: 'popup', ilap_update_glow: true });
                }
            });
        }
    });
})();
