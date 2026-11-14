// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The drainer as a store tab hosts it: its collaborators, and what wakes a
    // pass. The service worker builds its own (src/background.js), where utils.js
    // and its POST are absent.

    const I = window.ILAP;
    const Store = I.Curator.Store;

    // 400 classification wraps the POST here, not inside apiIgnoreGame: EQ and
    // DQ share that function and neither retries nor skips a failed appid.
    const drainer = new I.Curator.CuratorQueueDrainer({
        ownerId: I.newOwnerId('d_'),
        store: Store,
        marks: I.Curator.DoneMarks,
        lease: I.Curator.Lease,
        api: {
            ignore: async (appid, reason) =>
                I.classifyRefusal(appid, await I.apiIgnoreGame(appid, reason)),
            unignore: async (appid) =>
                I.classifyRefusal(appid, await I.apiUnignoreGame(appid)),
            creator: (clanid, ignore) => I.apiCreatorIgnore(clanid, ignore)
        },
        creators: I.Creators,
        gate: {
            reserve: (opts) => I.IgnoreGate.reserve(opts),
            reportRateLimited: (ms) => I.IgnoreGate.reportRateLimited(ms),
            stopped: () => I.IgnoreGate.stopVerdict(),
            lastSlotAt: () => I.IgnoreGate.lastSlotAt(),
            quietUntil: () => I.IgnoreGate.quietUntil()
        },
        fetchUserdata: () => I.fetchIgnoredAppsStrict({ onRateLimited: (ms) => I.IgnoreGate.reportRateLimited(ms) }),
        probeLogin: () => I.SteamAuth.probeLogin(),
        stats: {
            save: (name, reason, appid) => I.saveStats(name, I.StatsLogic.miSourceLabel(reason), appid),
            saveHistory: (name, reason, appid) => I.saveHistory(name, I.StatsLogic.miSourceLabel(reason), appid),
            saveJob: (job) => I.saveJobHistory(job),
            saveCreator: (name, clanid, ignore) => I.saveCreatorHistory(name, clanid, ignore),
            bumpCount: () => I.bumpIgnoredCount(),
            dropCount: () => I.dropIgnoredCount(),
            recordTotal: (size) => I.recordIgnoredTotal(size),
        },
        log: I.IgnoreLog.drainerHooks()
    });
    I.Curator.drainer = drainer;

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const touched = changes[Store.QUEUE_KEY]
            || changes[I.Settings.KEYS.MASTER]   // re-enabling the master resumes a gate-stopped drain
            || I.Curator.Lease.freedByOther(changes, drainer.ownerId);
        if (touched) drainer.kick();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => drainer.kick());
    } else {
        drainer.kick();
    }
})();
