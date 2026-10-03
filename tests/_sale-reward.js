// SPDX-License-Identifier: GPL-3.0-or-later
//
// src/sale-reward.js in a `vm` sandbox, for the unit spec and the canary alike:
// both run the product's own code rather than a copy of its rules. The caller
// supplies the network (`fetchWithTimeout`, as SteamNet's), the page's token
// (`token`; undefined = no config element at all), the shared storage (`store`)
// and the clock (`nowMs`, movable through the returned `clock`).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'sale-reward.js');

function loadSaleReward({ fetchWithTimeout, token, store = {}, nowMs = Date.now() }) {
    const clock = { ms: nowMs };
    const sandbox = {
        window: { ILAP: { SteamNet: { fetchWithTimeout } } },
        document: {
            getElementById: (id) => (id === 'application_config' && token !== undefined
                ? { dataset: { store_user_config: JSON.stringify({ webapi_token: token }) } }
                : null),
        },
        chrome: {
            storage: {
                local: {
                    get: (query, cb) => {
                        const out = {};
                        for (const [k, dflt] of Object.entries(query)) out[k] = k in store ? store[k] : dflt;
                        cb(out);
                    },
                    set: (obj, cb) => { Object.assign(store, obj); cb && cb(); },
                },
            },
        },
        Date: { now: () => clock.ms },
        JSON, Math, Number, Object, Promise, encodeURIComponent, atob,
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'sale-reward.js' });
    return { SaleReward: sandbox.window.ILAP.SaleReward, store, clock };
}

module.exports = { loadSaleReward };
