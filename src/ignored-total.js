// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Keeps Steam's ignore-list size (StatsLogic.TOTAL_KEY) from going stale
    // while nothing drains. A drain pass records it for free from the userdata
    // read it makes anyway; this covers the rest: on a store page load, at most
    // once per TTL across all tabs. The store page reads the same userdata on
    // every load itself, so one more read per TTL is noise to Steam.
    //
    // Not per account: after switching accounts in the same browser the old
    // number stands until the next read, at most one TTL. With the master
    // switch off nothing is read: a disabled extension sends Steam nothing.
    const I = window.ILAP;
    const TOTAL_KEY = I.StatsLogic.TOTAL_KEY;
    const MASTER_KEY = I.Settings.KEYS.MASTER;
    const POLL_KEY = 'ilap_ignored_total_poll';   // epoch ms of the last attempt, any tab
    const TTL_MS = 15 * 60 * 1000;
    // userdata lags a fresh ignore by seconds (steam-net.js): a read this soon
    // after a POST may miss one the counter already has.
    const USERDATA_LAG_MS = I.SteamNet.USERDATA_LAG_MS;

    function refreshIfStale() {
        // Nothing awaits the poll: a rejection ends here as one warn line.
        chrome.storage.local.get([TOTAL_KEY, POLL_KEY, MASTER_KEY], (d) => {
            poll(d).catch((e) => console.warn('[ILAP] ignored-total poll failed:', e));
        });
    }

    async function poll(d) {
        if (chrome.runtime.lastError || !I.Settings.isOn(d[MASTER_KEY])) return;
        const snap = d[TOTAL_KEY];
        const age = Date.now() - Math.max((snap && snap.ts) || 0, d[POLL_KEY] || 0);
        // A negative age is a clock set back: poll rather than wait it out.
        if (age >= 0 && age < TTL_MS) return;
        // Not claimed: the next page load asks again.
        if (Date.now() - (await I.IgnoreGate.lastSlotAt()) < USERDATA_LAG_MS) return;
        // Claimed before the session check, so a signed-out visitor does not
        // probe on every page either. Two tabs loading in the same instant
        // can both get past it: one extra read, accepted.
        chrome.storage.local.set({ [POLL_KEY]: Date.now() });
        // A signed-out read is an empty list, which must never become 0.
        if ((await I.SteamAuth.hasLiveSession()) !== true) return;
        const readAt = Date.now();
        const ignored = await I.fetchIgnoredAppsStrict();
        if (!ignored) return;
        // hasLiveSession trusts a signed-in header, which a session that has
        // died since still shows: an empty list needs the fresh probe too.
        if (ignored.size === 0 && (await I.SteamAuth.probeLogin()) !== true) return;
        // Asked again: a POST sent between the check above and the read is as
        // likely to be missing from it.
        if (readAt - (await I.IgnoreGate.lastSlotAt()) < USERDATA_LAG_MS) return;
        await I.recordIgnoredTotal(ignored.size);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', refreshIfStale);
    } else {
        refreshIfStale();
    }
})();
