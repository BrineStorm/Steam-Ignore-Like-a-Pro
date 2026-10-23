// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.ManualIgnore = window.ILAP.ManualIgnore || {};

    // A gesture on a bundle or package capsule ignores everything in it, games
    // and DLC. Steam keeps ignores per app, so the capsule has no ignore of its
    // own: its apps are read from Steam and staged as one job (Store.stageBundle).

    // A second ignore gesture on the same capsule within this long confirms the
    // first. One swipe too many on a game capsule must never ignore dozens of apps.
    const CONFIRM_MS = 8000;

    // The store's anonymous item lookup: a bundle's or a package's apps with their
    // names and the bundle's own name. No key or token, and it answers the store
    // origin's CORS, so a content script can ask it like the sale-reward check.
    const GET_ITEMS = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=';

    // The language Steam shows this page in, for the names it returns.
    function storeLanguage() {
        const m = document.cookie.match(/(?:^|;\s*)Steam_Language=([a-z_]+)/);
        return m ? m[1] : 'english';
    }

    // The account's store country from the page config, US when it is not there.
    function storeCountry() {
        try {
            const el = document.getElementById('application_config');
            const cfg = el && JSON.parse(el.dataset.config);
            return cfg && /^[A-Z]{2}$/.test(cfg.COUNTRY) ? cfg.COUNTRY : 'US';
        } catch (e) {
            return 'US';
        }
    }

    // { name, apps: [{ appid, name }] } for `ref` ({ kind: 'bundle' | 'sub', id }),
    // or null when Steam did not answer with a list. Paced in the ignores'
    // stream like every read outside a drain pass.
    async function fetchBundle(ref) {
        const idKey = ref.kind === 'bundle' ? 'bundleid' : 'packageid';
        const input = {
            ids: [{ [idKey]: Number(ref.id) }],
            context: { language: storeLanguage(), country_code: storeCountry() },
            data_request: { include_included_items: true },
        };
        await window.ILAP.IgnoreGate.paceRead();
        try {
            const res = await window.ILAP.SteamNet.fetchWithTimeout(GET_ITEMS + encodeURIComponent(JSON.stringify(input)));
            if (!res.ok) return null;
            const data = await res.json();
            const item = data && data.response && Array.isArray(data.response.store_items)
                ? data.response.store_items[0] : null;
            if (!item) return null;
            const included = item.included_items && Array.isArray(item.included_items.included_apps)
                ? item.included_items.included_apps
                : (Array.isArray(item.included_appids) ? item.included_appids.map(appid => ({ appid })) : []);
            const sanitize = window.ILAP.Sanitizer.sanitizeName;
            const apps = included
                .filter(a => a && /^\d+$/.test(String(a.appid)))
                .map(a => ({ appid: String(a.appid), name: a.name ? sanitize(String(a.name)) : '' }));
            return { name: item.name ? sanitize(String(item.name)) : '', apps };
        } catch (e) {
            return null;
        }
    }

    class BundleRequests {
        // read(ref)       → Promise<{ name, apps } | null>  (fetchBundle)
        // stage(spec)     → Promise<outcome>                (Store.stageBundle)
        // isDone(key)     → bool: the bundle's job already ran to its end (its badge is up)
        // isLoggedIn()    → Promise<bool>
        // toast(key, params)                                 a push card in this language
        constructor(deps) {
            for (const name of ['read', 'stage', 'isDone', 'isLoggedIn', 'toast']) {
                if (typeof deps[name] !== 'function') {
                    throw new TypeError(`[ILAP] BundleRequests needs deps.${name}`);
                }
            }
            this.read = deps.read;
            this.stage = deps.stage;
            this.isDone = deps.isDone;
            this.isLoggedIn = deps.isLoggedIn;
            this.toast = deps.toast;
            // The capsule the last first gesture asked about: { key, at }.
            this._armed = null;
            // Bundles being read or staged in this tab: a third swipe meanwhile is a no-op.
            this._busy = new Set();
        }

        // An ignore gesture on a bundle capsule. `intent.bundle` = { kind, id },
        // `intent.reason` the gesture's ignore reason.
        async request(intent) {
            const { kind, id } = intent.bundle;
            const key = kind + '_' + id;
            // Already badged IGNORED: like a swipe on a badged game, nothing to do.
            if (this._busy.has(key) || this.isDone(key)) return;
            // Signed out, nothing could be ignored: no card asking for a second swipe.
            if (!(await this.isLoggedIn())) return;
            const now = Date.now();
            const armed = this._armed;
            if (!armed || armed.key !== key || now - armed.at > CONFIRM_MS) {
                this._armed = { key, at: now };
                this.toast('bundle_swipe_again');
                return;
            }
            this._armed = null;
            this._busy.add(key);
            try {
                const contents = await this.read({ kind, id });
                if (!contents || !contents.apps.length) {
                    this.toast('bundle_unreadable');
                    return;
                }
                const outcome = await this.stage({
                    kind, id, name: contents.name, apps: contents.apps, reason: intent.reason || 0
                });
                const kindOf = outcome && outcome.kind;
                if (kindOf === 'added' || kindOf === 'merged') {
                    this.toast('bundle_queued', { name: contents.name, n: contents.apps.length });
                } else if (kindOf === 'queued') {
                    this.toast('bundle_already_queued');
                } else if (kindOf === 'full') {
                    // Every job slot taken and no room left in the MI job.
                    this.toast('bundle_queue_full');
                } else {
                    this.toast('bundle_unreadable');
                }
            } finally {
                this._busy.delete(key);
            }
        }
    }

    window.ILAP.ManualIgnore.BundleRequests = BundleRequests;
    window.ILAP.ManualIgnore.fetchBundle = fetchBundle;
    window.ILAP.ManualIgnore.BUNDLE_CONFIRM_MS = CONFIRM_MS;

})();
