// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The global master toggle for a module that needs nothing else from
    // storage: read once, then followed live. Modules that read it inside a wider
    // settings snapshot (EQ, Manual Ignore, the widget) keep doing so.
    const Settings = window.ILAP.Settings;
    const KEY = Settings.KEYS.MASTER;

    // onInit(on) once, then onChange(on) per write to the key. The change listener
    // is attached only once the first read has landed, so onChange can never run
    // before onInit has.
    function watch({ onInit, onChange }) {
        chrome.storage.local.get([KEY], (res) => {
            // onInit does real work against the page — the curator control
            // injects itself from here — so unexpected DOM can throw. The
            // listener is registered either way: a throw that escaped would
            // leave this page deaf to the master toggle for the rest of its
            // life, with nothing said. The ordering above is preserved, since
            // onInit still runs to completion (or fails) first.
            try {
                onInit(Settings.isOn(res[KEY]));
            } catch (e) {
                console.warn('[ILAP] master-switch onInit failed:', e);
            }
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local' || !changes[KEY]) return;
                // Guarded for the same reason onInit is, and it is the same work:
                // the DQ controller's onChange mounts and unmounts a panel in
                // Steam's modal. The cost differs — an escaping throw here loses
                // one toggle rather than every future one, since the listener
                // stays registered — but a page that half-applied a master flip
                // and said nothing is the failure either way.
                try {
                    onChange(Settings.isOn(changes[KEY].newValue));
                } catch (e) {
                    console.warn('[ILAP] master-switch onChange failed:', e);
                }
            });
        });
    }

    window.ILAP = window.ILAP || {};
    window.ILAP.MasterSwitch = { watch };
})();
