// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadEscape } = require('../_escape.js');

// src/sw-handoff.js as a Node unit: every store page caches its sessionid into
// ilap_sw_sid for the service-worker drainer (which cannot read document.cookie)
// and clears a halted SW route (ilap_sw_halt). Writes must be change-only: a
// same-value write would wake the service worker via onChanged for nothing.

function boot(sid, stored) {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'sw-handoff.js'), 'utf8');
    const gets = [];
    const sets = [];
    const sandbox = {
        window: { ILAP: { getSessionID: () => sid } },
        chrome: {
            storage: {
                local: {
                    get: (query, cb) => {
                        gets.push(query);
                        setTimeout(() => {
                            const out = {};
                            for (const k of Object.keys(query)) {
                                out[k] = (stored && k in stored) ? stored[k] : query[k];
                            }
                            cb(out);
                        }, 0);
                    },
                    set: (obj) => { sets.push({ ...obj }); },
                },
            },
        },
    };
    vm.createContext(sandbox);
    loadEscape(sandbox);
    // The two key names come from the queue store, loaded before this file.
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'curator', 'store.js'), 'utf8'), sandbox);
    vm.runInContext(code, sandbox);
    const flush = async () => {
        for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    };
    return { gets, sets, flush };
}

test.describe('SW handoff: sessionid cache (unit)', () => {

    test('a new sessionid is cached (with the halt flag cleared)', async () => {
        const b = boot('sess-1', {});
        await b.flush();
        expect(b.sets).toEqual([{ ilap_sw_sid: 'sess-1', ilap_sw_halt: false }]);
    });

    test('an unchanged sessionid writes nothing (no pointless SW wake)', async () => {
        const b = boot('sess-1', { ilap_sw_sid: 'sess-1', ilap_sw_halt: false });
        await b.flush();
        expect(b.sets).toEqual([]);
    });

    test('a halted SW route is re-armed by the page visit even with the same sid', async () => {
        const b = boot('sess-1', { ilap_sw_sid: 'sess-1', ilap_sw_halt: true });
        await b.flush();
        expect(b.sets).toEqual([{ ilap_sw_sid: 'sess-1', ilap_sw_halt: false }]);
    });

    test('no sessionid (logged out) → the cache is left alone', async () => {
        const b = boot(null, { ilap_sw_sid: 'old', ilap_sw_halt: false });
        await b.flush();
        expect(b.sets).toEqual([]);
        expect(b.gets).toEqual([]); // not even a read — nothing to compare
    });
});
