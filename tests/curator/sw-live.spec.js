// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, chromium } = require('@playwright/test');
const { AUTH_FILE } = require('../_fixtures.js');
const {
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
} = require('../_extension.js');
const { readQueue, readLog, logEntry } = require('./_helpers.js');
const { readUserdata, readSid, unignore, pollUserdata, ensureNotIgnored } = require('../_steam-live.js');

// The Phase-3 service worker, for real: the PRODUCTION build, a REAL Steam
// account, REAL ignore POSTs, and no Steam tab anywhere in the browser.
//
// Why this spec launches its own browser instead of using tests/_fixtures.js:
// every other suite loads dist/chromium-test, whose manifest swaps src/background.js
// for an empty stub (build.js --test) so a seeded queue can't be drained out from
// under a spec by a worker nobody asked for. The consequence is that the shipping
// service worker — the one that carries the cross-origin credentialed POST, the
// cached-sessionid handoff and the halt counter — was covered only by the Node
// unit in tests/cross-cutting/background.unit.spec.js, where `fetch` is a stub.
// Everything that can only break against real Chrome and real Steam (cookies on a
// chrome-extension:// → steampowered.com request, CORS on the response, whether
// Steam accepts a POST with no page context) lived outside the suite entirely.
// So this one loads dist/chromium — the exact bytes that ship.
//
// The proof that the WORKER did the draining is structural, not circumstantial:
// the only Steam tab is navigated away before the queue is seeded, so no content
// script exists in the browser while the queue drains. Nothing else can POST.
//
// Skipped without a saved Steam session, without a production build, and under
// Firefox (whose event page has no drain — the content-script drainer is its path).

const PROD_EXT = path.join(__dirname, '..', '..', 'dist', 'chromium');

// Two appids so a broken route is unambiguous: HALT_AFTER is 2 consecutive
// failed POSTs, so a worker that cannot reach Steam sets ilap_sw_halt instead of
// failing quietly. Both are free, global Valve titles — no region lock (which
// would be classified and skipped rather than ignored) and no age gate.
const APPIDS = ['400', '620'];   // Portal, Portal 2

function curatorJob() {
    return {
        id: 'job_sw_live',
        curatorId: '990098',
        curatorName: 'SW Live Drain',
        filter: 'not_recommended',
        appids: [...APPIDS],
        total: APPIDS.length,
        status: 'pending',
        addedAt: Date.now(),
    };
}

// A persistent context on the PRODUCTION extension, with the saved Steam session
// injected (persistent contexts ignore storageState — same reason as _fixtures.js).
async function launchProduction() {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilap-swlive-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: { width: 1440, height: 810 },
        baseURL: 'https://store.steampowered.com',
        args: [
            '--window-position=0,0',
            `--disable-extensions-except=${PROD_EXT}`,
            `--load-extension=${PROD_EXT}`,
        ],
    });
    const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (state.cookies && state.cookies.length) await context.addCookies(state.cookies);
    return { context, userDataDir };
}

test.describe('Curator — LIVE drain by the production service worker', () => {

    test('the shipping SW really ignores with no Steam tab open, then the queue empties', async ({ browserName }) => {
        test.skip(browserName === 'firefox', 'the SW drain is Chromium-only; Firefox drains from the content script');
        test.skip(!fs.existsSync(AUTH_FILE), 'no saved Steam session — run: npm run test:auth');
        test.skip(!fs.existsSync(path.join(PROD_EXT, 'manifest.json')),
            'no production build — run `npm run build` (this spec loads dist/chromium, not the test flavor)');
        test.setTimeout(4 * 60 * 1000);

        const { context, userDataDir } = await launchProduction();
        const page = context.pages()[0] || await context.newPage();
        let sid = null;

        try {
            await page.goto(`/app/${APPIDS[0]}/`);

            // Guard against a vacuous run: userdata must read as logged-in, else
            // every ignore check below would pass against an empty set.
            const auth = await readUserdata(page);
            test.skip(!auth || auth.ownedCount === 0,
                'saved cookies no longer authenticate the userdata API (half-dead session) — refresh: npm run test:auth');
            sid = await readSid(page);
            test.skip(!sid, 'no sessionid cookie on the page — refresh: npm run test:auth');

            // Half the contract under test: the worker has no document.cookie, so
            // the content script caches the sessionid for it at page boot. Without
            // this handoff the gate's no-session stop refuses every slot and the
            // drain below would "pass" by never POSTing at all.
            await expect
                .poll(async () => (await getExtensionStorage(context, 'ilap_sw_sid')).ilap_sw_sid,
                    { timeout: 20000, message: 'the content script must cache the sessionid for the worker' })
                .toBe(sid);

            // Clean slate: an already-ignored appid dedupe-skips (no POST, no log
            // append), which would make every assertion below vacuous.
            for (const appid of APPIDS) await ensureNotIgnored(page, sid, appid);

            // Leave Steam. From here there is no content script anywhere in this
            // browser, so the service worker is the only thing that can drain.
            await page.goto('about:blank');
            expect(context.pages().some(p => p.url().includes('steampowered.com')),
                'no Steam tab may be open while the worker drains').toBe(false);

            // One write, so the worker wakes on a single storage.onChanged and
            // drains immediately — no waiting on the 60 s retry alarm.
            await setExtensionStorage(context, {
                ilap_master_enabled: true,
                ilap_sw_halt: false,
                ilap_curator_queue: [curatorJob()],
            });

            await expect
                .poll(async () => (await readQueue(context)).length,
                    { timeout: 90000, message: 'the worker must drain the job to completion' })
                .toBe(0);

            // A route that cannot reach Steam halts after two failed POSTs, which
            // is exactly the queue length here — so this flag is the difference
            // between "drained" and "gave up".
            const halt = (await getExtensionStorage(context, 'ilap_sw_halt')).ilap_sw_halt;
            expect(halt, 'the SW route must not have halted').toBeFalsy();

            // Durable per-appid evidence: a real ignore, not a classified skip.
            const log = await readLog(context);
            for (const appid of APPIDS) {
                const entry = logEntry(log, appid);
                expect(entry, `${appid} must be logged by the worker`).toBeTruthy();
                expect(entry.skipped, `${appid} must be a real ignore, not a skip`).toBeUndefined();
            }

            // And it landed on the ACCOUNT — the assertion no stub can fake.
            await page.goto(`/app/${APPIDS[0]}/`);
            const snap = await pollUserdata(page, ids => APPIDS.every(a => ids.has(a)), 40000);
            const ids = new Set(snap ? snap.ids : []);
            for (const appid of APPIDS) {
                expect(ids.has(appid), `${appid} must really be ignored on the account`).toBe(true);
            }
        } finally {
            if (sid) {
                // The un-ignore is a same-origin page fetch, so get back on a
                // store page first if the test bailed while parked on about:blank.
                if (!page.url().includes('steampowered.com')) {
                    await page.goto('/about/').catch(() => {});
                }
                for (const appid of APPIDS) await unignore(page, sid, appid).catch(() => {});
            }
            await clearExtensionStorage(context).catch(() => {});
            await context.close();
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    });
});
