// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Steam's creator ignore (developers, publishers, franchises), as this
    // extension knows it. Loaded by the content script and the popup.
    //  - The mirror (`ilap_creators`): the account's ignored creators with their
    //    names, and the followed ones, from dynamicstore/userdata. The popup
    //    cannot ask Steam, so a store tab keeps it: the ignored-total poll syncs
    //    it, a landed creator POST notes its change.
    //    { ignored: { <clanid>: name }, followed: [clanid], ts, tried?: { <clanid>: ts } }
    //    `tried`: when a name read last gave nothing, for creators still unnamed.
    //  - What the user sees is the mirror with the creator job's waiting entries
    //    over it (`effective`), so a gesture shows at once, and a removed job or
    //    a dropped entry corrects itself with no pulse.
    //  - The reads a store tab makes for it: a creator's name, a creator page's
    //    clan id.

    window.ILAP = window.ILAP || {};

    const MIRROR_KEY = 'ilap_creators';
    // A creator POST Steam refused: { ts }. Every store tab says so once.
    const FAILED_KEY = 'ilap_creator_failed';
    // The names read per sync: a creator ignored on Steam before this
    // extension knew it has no name yet, and each name is a page read.
    const NAMES_PER_SYNC = 5;
    // A name the page did not give is asked again no sooner than this.
    const NAME_RETRY_MS = 24 * 60 * 60 * 1000;

    const CURATOR_PAGE = 'https://store.steampowered.com/curator/';
    // The English page title starts with this (og:title), the name follows.
    const TITLE_PREFIX = 'Steam Curator: ';

    // --- pure (unit-tested) ---------------------------------------------------

    const emptyMirror = () => ({ ignored: {}, followed: [] });

    // A stored value as a mirror, whatever is there.
    function asMirror(v) {
        const m = emptyMirror();
        if (!v || typeof v !== 'object') return m;
        if (v.ignored && typeof v.ignored === 'object') {
            for (const id of Object.keys(v.ignored)) {
                if (/^\d+$/.test(id)) m.ignored[id] = String(v.ignored[id] || '');
            }
        }
        if (Array.isArray(v.followed)) m.followed = v.followed.map(String).filter(id => /^\d+$/.test(id));
        if (Number.isFinite(v.ts)) m.ts = v.ts;
        if (v.tried && typeof v.tried === 'object') {
            for (const id of Object.keys(v.tried)) {
                if (/^\d+$/.test(id) && Number.isFinite(v.tried[id])) (m.tried = m.tried || {})[id] = v.tried[id];
            }
        }
        return m;
    }

    // The mirror after one landed POST.
    function noted(mirror, clanid, name, ignore) {
        const m = asMirror(mirror);
        const id = String(clanid);
        if (ignore) m.ignored[id] = String(name || m.ignored[id] || '');
        else delete m.ignored[id];
        return m;
    }

    // The mirror after a userdata read: Steam's two lists, with the names
    // already known kept. null lists (a changed answer) leave the mirror be.
    function synced(mirror, ignoredSet, followedSet, now) {
        const m = asMirror(mirror);
        if (!ignoredSet || !followedSet) return m;
        const ignored = {};
        const tried = {};
        for (const raw of ignoredSet) {
            const id = String(raw);
            ignored[id] = m.ignored[id] || '';
            if (!ignored[id] && m.tried && m.tried[id]) tried[id] = m.tried[id];
        }
        const out = { ignored, followed: Array.from(followedSet).map(String), ts: now };
        if (Object.keys(tried).length) out.tried = tried;
        return out;
    }

    // The clan ids the mirror has no name for, less those whose read gave
    // nothing within NAME_RETRY_MS of `now`.
    function unnamed(mirror, now) {
        const m = asMirror(mirror);
        const tried = m.tried || {};
        return Object.keys(m.ignored)
            .filter(id => !m.ignored[id] && !(id in tried && now - tried[id] < NAME_RETRY_MS));
    }

    // The mirror after one name read: the name, or the time it gave nothing.
    function named(mirror, clanid, name, now) {
        const m = asMirror(mirror);
        const id = String(clanid);
        if (!(id in m.ignored) || m.ignored[id]) return m;
        if (name) {
            m.ignored[id] = name;
            if (m.tried) delete m.tried[id];
            if (m.tried && !Object.keys(m.tried).length) delete m.tried;
        } else {
            (m.tried = m.tried || {})[id] = now;
        }
        return m;
    }

    // What the user sees: Map clanid -> name of the ignored creators, the
    // creator job's waiting entries (from `cursor` on) applied in order.
    function effective(mirror, job, cursor) {
        const m = asMirror(mirror);
        const out = new Map(Object.entries(m.ignored));
        const ids = job && Array.isArray(job.appids) ? job.appids : [];
        for (let i = Math.max(0, cursor || 0); i < ids.length; i++) {
            const id = String(ids[i]);
            const meta = (job.meta || {})[id];
            if (!meta) continue;
            if (meta.ignore) out.set(id, meta.name || out.get(id) || '');
            else out.delete(id);
        }
        return out;
    }

    // A creator's name from its English curator page, or ''.
    function nameFromPage(html) {
        const m = String(html || '').match(/<meta\s+property="og:title"\s+content="([^"]*)"/);
        if (!m) return '';
        const text = m[1]
            .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        const name = text.indexOf(TITLE_PREFIX) === 0 ? text.slice(TITLE_PREFIX.length) : text;
        return window.ILAP.Sanitizer.sanitizeName(name);
    }

    // The clan id a creator page ignores itself by (Steam's own button), or null.
    function clanIdFromPage(html) {
        const m = String(html || '').match(/IgnoreCurator\(\s*(\d+)\s*,/);
        return m ? m[1] : null;
    }

    // --- storage ----------------------------------------------------------------
    // Duplicated per world on purpose (see src/curator/store.js).
    function get(keys) {
        return new Promise(resolve => chrome.storage.local.get(keys, resolve));
    }
    function set(obj) {
        return new Promise(resolve => chrome.storage.local.set(obj, resolve));
    }

    // One write chain per context. Across contexts the next sync puts it right.
    const serialized = window.ILAP.serialChain();

    async function read() {
        return asMirror((await get(MIRROR_KEY))[MIRROR_KEY]);
    }

    // The mirror with the creator job and its cursor, the three things
    // `effective` takes. Read the same way by a store tab and by the popup.
    // `store` is the Curator Store.
    async function readState(store) {
        const [mirror, queue, cursor] = await Promise.all([
            read(), store.getQueue(), store.getCursor(store.CREATOR_JOB_ID)]);
        const job = queue.find(j => store.jobType(j) === store.JOB_TYPE.CREATOR) || null;
        return { mirror, job, cursor: cursor || 0 };
    }

    function write(next) {
        return serialized(async () => {
            const cur = (await get(MIRROR_KEY))[MIRROR_KEY];
            await set({ [MIRROR_KEY]: next(cur) });
        });
    }

    const note = (clanid, name, ignore) => write(cur => noted(cur, clanid, name, ignore));

    async function signalFailed() {
        await set({ [FAILED_KEY]: { ts: Date.now() } });
    }

    // --- store tab reads ------------------------------------------------------

    // A page read, paced in the ignores' stream like every read outside a drain.
    async function readPage(url) {
        await window.ILAP.IgnoreGate.paceRead();
        try {
            const res = await window.ILAP.SteamNet.fetchWithTimeout(url, { credentials: 'include' });
            return res.ok ? await res.text() : null;
        } catch (e) {
            return null;
        }
    }

    async function fetchName(clanid) {
        return nameFromPage(await readPage(`${CURATOR_PAGE}${clanid}/?l=english`));
    }

    // The clan id behind a creator page's link (/developer/, /publisher/,
    // /franchise/), or null.
    async function fetchClanId(href) {
        let url;
        try { url = new URL(href, location.href); } catch (e) { return null; }
        if (url.origin !== 'https://store.steampowered.com') return null;
        return clanIdFromPage(await readPage(url.origin + url.pathname));
    }

    // The creators of a game with a page of their own, as Steam lists them:
    // [{ id, name }] for its developers, publishers and franchises, or null.
    // One anonymous read (the store's item lookup, as for a bundle).
    async function fetchAppCreators(appid, country) {
        await window.ILAP.IgnoreGate.paceRead();
        const item = await window.ILAP.SteamNet.fetchStoreItem({ appid: Number(appid) },
            { language: 'english', country_code: country || 'US' }, { include_basic_info: true });
        return item ? appCreators(item) : null;
    }

    // The [{ id, name }] of one GetItems store item.
    function appCreators(item) {
        const info = (item && item.basic_info) || {};
        const out = [];
        for (const list of [info.developers, info.publishers, info.franchises]) {
            for (const c of Array.isArray(list) ? list : []) {
                const id = c && c.creator_clan_account_id;
                if (!/^\d+$/.test(String(id)) || !c.name) continue;
                out.push({ id: String(id), name: window.ILAP.Sanitizer.sanitizeName(String(c.name)) });
            }
        }
        return out;
    }

    // After a userdata read (`map` as fetchIgnoredAppsStrict returns it): the
    // two lists into the mirror, then a few of the missing names.
    async function syncFromAccount(map) {
        if (!map || !map.creatorsIgnored || !map.creatorsFollowed) return;
        const now = Date.now();
        await write(cur => synced(cur, map.creatorsIgnored, map.creatorsFollowed, now));
        for (const id of unnamed(await read(), now).slice(0, NAMES_PER_SYNC)) {
            const name = await fetchName(id);
            await write(cur => named(cur, id, name, Date.now()));
        }
    }

    window.ILAP.Creators = {
        // pure
        asMirror, noted, synced, unnamed, named, effective, nameFromPage, clanIdFromPage, appCreators,
        // storage
        read, readState, note, signalFailed,
        // store tab
        fetchName, fetchClanId, fetchAppCreators, syncFromAccount,
        // keys
        MIRROR_KEY, FAILED_KEY, NAMES_PER_SYNC, NAME_RETRY_MS
    };
})();
