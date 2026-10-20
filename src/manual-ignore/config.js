// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.ManualIgnore = window.ILAP.ManualIgnore || {};

    // Manual Ignore's settings: read from storage through the schema's rules,
    // re-read when one of its keys changes.

    const Settings = window.ILAP.Settings;
    const CONFIG_KEYS = {
        SHORTCUT: Settings.KEYS.SHORTCUT,
        PLATFORM: Settings.KEYS.PLATFORM,
        MASTER: Settings.KEYS.MASTER,
        MASK: Settings.KEYS.MASK,
        UNIGNORE: Settings.KEYS.UNIGNORE
    };
    const CONFIG_STORAGE_KEYS = Object.values(CONFIG_KEYS);

    class ConfigReader {
        constructor(defaultConfig) {
            this.config = { ...defaultConfig };
        }

        async init() {
            return this.refresh();
        }

        async refresh() {
            return new Promise(resolve => {
                chrome.storage.local.get(CONFIG_STORAGE_KEYS, (res) => {
                    // Same rule as StatsManager._commit (src/utils.js): the
                    // executor above only covers the synchronous get() call, and a
                    // throw in HERE would leave this promise pending for good.
                    // `res` is undefined when the read errored, and
                    // _updateInternal dereferences it. App.init() AWAITS this one,
                    // so the page would never wire its gestures and boot()'s
                    // .catch would never hear about it — Manual Ignore simply
                    // absent, with nothing said. Resolve with what we have (the
                    // defaults, or the last good values) and let the next config
                    // change re-read.
                    //
                    // The synchronous throw of an invalidated context is NOT
                    // caught: it rejects this promise, init() with it, and boot()
                    // logs it. Swallowing it would march on to wire listeners
                    // against a page that has no storage left.
                    try {
                        // `chrome.runtime &&` like i18n.js: the read is what
                        // matters, and a host without a runtime handle must not
                        // cost the config its values.
                        if (!(chrome.runtime && chrome.runtime.lastError)) this._updateInternal(res);
                    } catch (e) {
                        console.warn('[ILAP] config read failed:', e);
                    }
                    resolve(this.config);
                });
            });
        }

        get() {
            return this.config;
        }

        _updateInternal(res) {
            // Same rule as the un-ignore key below: a clamped-away value keeps
            // the current binding rather than becoming one no gesture matches.
            const normalize = Settings.normalizeShortcut;
            const shortcut = normalize(res[CONFIG_KEYS.SHORTCUT]);
            if (shortcut) this.config.defaultKey = shortcut;
            const platform = normalize(res[CONFIG_KEYS.PLATFORM]);
            if (platform) this.config.platformKey = platform;
            // Through Settings.isOn, not a raw assignment: what counts as OFF is
            // the schema's to say (only an explicit false), and it is said once
            // there. Readers of this config get a real boolean.
            if (res[CONFIG_KEYS.MASTER] !== undefined) {
                this.config.enabled = Settings.isOn(res[CONFIG_KEYS.MASTER]);
            }
            if (res[CONFIG_KEYS.MASK] !== undefined) {
                this.config.maskEnabled = Settings.isOn(res[CONFIG_KEYS.MASK]);
            }
            // A value it does not know keeps the current binding rather than
            // becoming one no page could explain.
            const unignore = Settings.normalizeUnignore(res[CONFIG_KEYS.UNIGNORE]);
            if (unignore) this.config.unignoreKey = unignore;
        }
    }

    class ConfigChangeEmitter {
        constructor(refreshFn) {
            this.listeners = [];
            this.refreshFn = refreshFn;
        }

        listen() {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local') return;
                // Only react to the config keys we read. Without this filter every
                // open Steam tab re-read config and swept the whole DOM
                // (refreshAll + syncMasks) on ANY local write — e.g. the curator
                // drainer's cursor, written 1–3×/s for the length of a bulk drain.
                if (!Object.keys(changes).some(k => CONFIG_STORAGE_KEYS.includes(k))) return;
                this.refreshFn().then(config => {
                    this.listeners.forEach(cb => cb(config));
                });
            });
        }

        onChange(callback) {
            this.listeners.push(callback);
        }
    }

    class ConfigService {
        constructor(defaultConfig) {
            this.reader = new ConfigReader(defaultConfig);
            this.emitter = new ConfigChangeEmitter(() => this.reader.refresh());
        }

        init() { return this.reader.init(); }
        get() { return this.reader.get(); }
        listen() { this.emitter.listen(); }
        onChange(callback) { this.emitter.onChange(callback); }
    }

    window.ILAP.ManualIgnore.ConfigService = ConfigService;

})();
