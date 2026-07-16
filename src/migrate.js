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

    // Set when an install/update event fires in this background lifetime — the
    // onStartup re-assert below must yield to it (see the race note there).
    let installEventSeen = false;

    chrome.runtime.onInstalled.addListener((details) => {
        installEventSeen = true;
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
                // A transient storage error must not read as "key absent" —
                // that would wrongly migrate a widget profile to 'popup'.
                // Leave the key as-is; a wrong no-op here is recoverable (the
                // user can still switch surfaces), a wrong migration is not.
                if (chrome.runtime.lastError) return;
                if (d.ilap_surface_mode == null) {
                    chrome.storage.local.set({ ilap_surface_mode: 'popup', ilap_update_glow: true });
                }
            });
        }
    });

    // Re-assert the surface key at browser startup. The onInstalled write above
    // can be lost if the platform suspends this context before the async set
    // completes (low probability, but a lost INSTALL write has a delayed sting:
    // every reader defaults absent→'widget' so nothing looks wrong, until a
    // LATER update finds the key absent and wrongly migrates the profile to
    // 'popup', parking the on-page UI). Persisting 'widget' — the same value
    // every reader already assumes — closes that window without changing what
    // the user sees. A lost UPDATE write ('popup') cannot be told apart and ends
    // up 'widget' too; that profile self-recovers via the popup's signpost stub.
    //
    // RACE GUARD: when the extension was updated while the browser was closed,
    // onStartup and onInstalled(update) fire in the same background lifetime,
    // and this re-assert could win the read-then-write race against the update
    // branch — its get would then see 'widget' present and skip the legacy
    // popup migration. So the re-assert is delayed a beat and yields whenever
    // an install/update event has fired in this lifetime (that path owns the key).
    chrome.runtime.onStartup.addListener(() => {
        setTimeout(() => {
            if (installEventSeen) return;
            chrome.storage.local.get('ilap_surface_mode', (d) => {
                if (chrome.runtime.lastError) return;
                if (d.ilap_surface_mode == null) {
                    // No glow flags here: we can't know whether this profile lost
                    // an install or an update write, and the beacons are one-shot
                    // cosmetics tied to those specific moments.
                    chrome.storage.local.set({ ilap_surface_mode: 'widget' });
                }
            });
        }, 3000);
    });
})();
