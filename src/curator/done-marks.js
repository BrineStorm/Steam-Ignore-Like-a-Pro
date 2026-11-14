// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // What finished jobs leave behind, apart from the queue (curator/store.js):
    //  - a built-in list run to its end: `ilap_preset_done_<key>` = the list's rev
    //    (data/presets.json), so the lists menu offers it no more. One key per
    //    list, so two drainers finishing two lists at once never write over each
    //    other. A list run at an older rev shows a blue dot in the menu until
    //    the user dismisses it (`ilap_preset_seen_<key>`, the popup writes it);
    //  - a bundle run to its end: its entry in `ilap_ignored_bundles` =
    //    { '<bundle|sub>_<id>': { ts, appids } }, for the IGNORED badge on its
    //    capsules. The appids let a rollback of any of its games take it off;
    //  - a game the AI tab's HIGH level queued and Steam refused: its entry in
    //    `ilap_ai_refused` = { <appid>: { ts, why } }, so the switch leaves it
    //    unshot for a while instead of shooting and POSTing it on every page.
    // The drainer writes all three (marks on a finished job or a dropped entry,
    // unmarks on a rollback), the lists menu and the Manual-Ignore tabs read them.

    window.ILAP = window.ILAP || {};
    window.ILAP.Curator = window.ILAP.Curator || {};

    const Store = window.ILAP.Curator.Store;

    const PRESET_DONE_PREFIX = 'ilap_preset_done_';
    const PRESET_SEEN_PREFIX = 'ilap_preset_seen_';
    const IGNORED_BUNDLES_KEY = 'ilap_ignored_bundles';
    const IGNORED_BUNDLES_MAX = 300;
    const BUNDLE_KEY_RE = /^(bundle|sub)_\d+$/;

    // Storage shim, duplicated per world on purpose (see src/curator/store.js).
    function get(keys) {
        return new Promise(resolve => chrome.storage.local.get(keys, resolve));
    }
    function set(obj) {
        return new Promise(resolve => chrome.storage.local.set(obj, resolve));
    }
    function remove(keys) {
        return new Promise(resolve => chrome.storage.local.remove(keys, resolve));
    }

    // --- built-in lists ---------------------------------------------------------

    // A built-in list job that ran to its end: its list is marked done with its
    // rev. The drainer's call only — a list the user removed was not run, so it
    // stays on offer.
    async function markPresetDone(job) {
        if (!job || !job.presetKey) return;
        await set({ [PRESET_DONE_PREFIX + job.presetKey]: job.presetRev || '' });
    }

    // Games rolled back: a built-in list that ignored any of them is offered
    // again. `curatorIds` = the rolled-back log entries' ids (IgnoreLog.markUndone).
    async function unmarkPresets(curatorIds) {
        const prefix = Store.PRESET_ID_PREFIX;
        const keys = (curatorIds || []).map(String)
            .filter(id => id.indexOf(prefix) === 0)
            .map(id => PRESET_DONE_PREFIX + id.slice(prefix.length));
        if (keys.length) await remove(keys);
    }

    // A rev without the keep tags an AI list's done mark ends in ('+t', '+l').
    const baseRev = (rev) => String(rev).split('+')[0];

    // What the lists menu shows of each built-in list, from one storage read
    // `res` (pure, unit-tested). `revs` = { <key>: rev or [rev...] }, the revs
    // a list counts as done at, all of them on the shipped rev
    // (data/presets.json → rev). Two Sets of keys:
    //  - blocked: queued, or done at a rev of its array. The menu cannot offer it;
    //  - updated: run to its end at an older version of the list, so a run
    //    would ignore the new games. Not queued, and the user has not
    //    dismissed its dot at this version (`ilap_preset_seen_<key>`). A keep
    //    box ticked or cleared since leaves the base rev as it is: no dot.
    function presetMarksOf(res, revs) {
        const queue = Array.isArray(res[Store.QUEUE_KEY]) ? res[Store.QUEUE_KEY] : [];
        const queued = new Set(queue.map(j => j.curatorId));
        const blocked = new Set(), updated = new Set();
        for (const k of Object.keys(revs || {})) {
            const done = res[PRESET_DONE_PREFIX + k];
            const at = [].concat(revs[k]);
            if (queued.has(Store.PRESET_ID_PREFIX + k) || at.includes(done)) blocked.add(k);
            else if (typeof done === 'string' && baseRev(done) !== baseRev(at[0])
                && res[PRESET_SEEN_PREFIX + k] !== baseRev(at[0])) updated.add(k);
        }
        return { blocked, updated };
    }

    async function presetMarks(revs) {
        const keys = Object.keys(revs || {});
        const res = await get([Store.QUEUE_KEY]
            .concat(keys.map(k => PRESET_DONE_PREFIX + k), keys.map(k => PRESET_SEEN_PREFIX + k)));
        return presetMarksOf(res, revs);
    }

    // The user dismissed an updated list's dot: it stays away until the list
    // changes again. `rev` = the shipped rev.
    async function markPresetSeen(key, rev) {
        await set({ [PRESET_SEEN_PREFIX + key]: baseRev(rev) });
    }

    // --- bundles ------------------------------------------------------------------

    // The marks map, serialized within this context like the queue. Two contexts
    // finishing two bundles in the same instant can lose one mark (no CAS): the
    // bundle then shows no badge, and a swipe on it re-runs a job of dedupe skips.
    const bundleSerial = window.ILAP.serialChain();
    async function getBundleMarks() {
        const marks = (await get(IGNORED_BUNDLES_KEY))[IGNORED_BUNDLES_KEY];
        return marks && typeof marks === 'object' ? marks : {};
    }

    // A bundle job that ran to its end: its capsules get the IGNORED badge. The
    // oldest marks go past IGNORED_BUNDLES_MAX.
    function markBundleDone(job) {
        if (!job || !BUNDLE_KEY_RE.test(String(job.curatorId))) return Promise.resolve();
        return bundleSerial(async () => {
            const marks = await getBundleMarks();
            marks[job.curatorId] = { ts: Date.now(), appids: (job.appids || []).map(String) };
            const keep = Object.keys(marks).sort((a, b) => (marks[b].ts || 0) - (marks[a].ts || 0))
                .slice(0, IGNORED_BUNDLES_MAX);
            const next = {};
            for (const k of keep) next[k] = marks[k];
            await set({ [IGNORED_BUNDLES_KEY]: next });
        });
    }

    // Games rolled back: a bundle with any of them in it is no longer all ignored.
    function unmarkBundlesWith(appids) {
        const gone = new Set((appids || []).map(String));
        return bundleSerial(async () => {
            const marks = await getBundleMarks();
            const hit = Object.keys(marks).filter(k => (marks[k].appids || []).some(a => gone.has(String(a))));
            if (!hit.length) return;
            for (const k of hit) delete marks[k];
            await set({ [IGNORED_BUNDLES_KEY]: marks });
        });
    }

    // --- list names -----------------------------------------------------------------

    // The names of the curators and bundles the user queued: `ilap_list_names` =
    // { <curatorId>: { name, ts } }, for the frame on an ignored game's page
    // (manual-ignore/list-frame.js). Written as a list is queued, or by a game
    // page that read a missing name from Steam. The oldest go past LIST_NAMES_MAX.
    const LIST_NAMES_KEY = 'ilap_list_names';
    const LIST_NAMES_MAX = 500;
    const namesSerial = window.ILAP.serialChain();

    async function listNames() {
        const names = (await get(LIST_NAMES_KEY))[LIST_NAMES_KEY];
        return names && typeof names === 'object' ? names : {};
    }

    function noteListName(id, name) {
        const clean = window.ILAP.Sanitizer.sanitizeName(name);
        if (!id || !clean) return Promise.resolve();
        return namesSerial(async () => {
            const names = await listNames();
            if (names[id] && names[id].name === clean) return;
            names[id] = { name: clean, ts: Date.now() };
            const keep = Object.keys(names).sort((a, b) => (names[b].ts || 0) - (names[a].ts || 0))
                .slice(0, LIST_NAMES_MAX);
            const next = {};
            for (const k of keep) next[k] = names[k];
            await set({ [LIST_NAMES_KEY]: next });
        });
    }

    // --- AI games Steam refused ---------------------------------------------------

    // How long a refused game stays unshot, by the refusal. 'unavailable' is
    // a game not sold in the user's region, which a month rarely changes. Any
    // other refusal may be passing, so it is tried again the next day.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const AI_REFUSED_KEY = 'ilap_ai_refused';
    const AI_REFUSED_MS = Object.freeze({ unavailable: 30 * DAY_MS, failed: DAY_MS });
    const AI_REFUSED_MAX = 500;

    const refusalHeld = (r, now) => !!r && Number.isFinite(r.ts) && r.ts <= now
        && now - r.ts < (AI_REFUSED_MS[r.why] || AI_REFUSED_MS.failed);

    // The appids whose refusal still holds at `now`, from a stored map
    // (pure, unit-tested).
    function aiHeld(map, now) {
        const out = new Set();
        if (!map || typeof map !== 'object') return out;
        for (const id of Object.keys(map)) {
            if (/^\d+$/.test(id) && refusalHeld(map[id], now)) out.add(id);
        }
        return out;
    }

    // The map after one refusal: entries that no longer hold are dropped, and
    // past AI_REFUSED_MAX the oldest go (pure, unit-tested).
    function withRefusal(map, appid, why, now) {
        const next = {};
        for (const id of aiHeld(map, now)) next[id] = map[id];
        next[String(appid)] = { ts: now, why: why === 'unavailable' ? 'unavailable' : 'failed' };
        const keep = Object.keys(next).sort((a, b) => next[b].ts - next[a].ts).slice(0, AI_REFUSED_MAX);
        const out = {};
        for (const id of keep) out[id] = next[id];
        return out;
    }

    const refusedSerial = window.ILAP.serialChain();

    // A browsing entry the drainer dropped (`why` as _dropEntry gives it).
    function markAiRefused(appid, why) {
        if (!/^\d+$/.test(String(appid))) return Promise.resolve();
        return refusedSerial(async () => {
            const cur = (await get(AI_REFUSED_KEY))[AI_REFUSED_KEY];
            await set({ [AI_REFUSED_KEY]: withRefusal(cur, appid, why, Date.now()) });
        });
    }

    // The games the browsing switch leaves unshot for now, a Set of appid strings.
    async function aiRefusedNow() {
        return aiHeld((await get(AI_REFUSED_KEY))[AI_REFUSED_KEY], Date.now());
    }

    window.ILAP.Curator.DoneMarks = Object.freeze({
        markPresetDone, unmarkPresets, presetMarks, presetMarksOf, markPresetSeen,
        getBundleMarks, markBundleDone, unmarkBundlesWith,
        listNames, noteListName,
        markAiRefused, aiRefusedNow, aiHeld, withRefusal,
        PRESET_DONE_PREFIX, PRESET_SEEN_PREFIX, IGNORED_BUNDLES_KEY, IGNORED_BUNDLES_MAX, BUNDLE_KEY_RE,
        LIST_NAMES_KEY, LIST_NAMES_MAX,
        AI_REFUSED_KEY, AI_REFUSED_MS, AI_REFUSED_MAX,
    });
})();
