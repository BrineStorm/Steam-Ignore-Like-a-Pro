// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};

    // Aggregate ignore-POST rate governor. The ban risk is the SUM of ignore
    // POSTs to one account across every source in every tab: the drainer, the
    // Explore Queue, and the Discovery Queue click (which makes Steam's own page
    // POST, so this cannot be a wrapper around our fetch). Every source reserves
    // a slot here first; one shared timestamp in storage turns N streams into one
    // paced stream. The two stops — master off, no live session — are enforced
    // here too.

    const GATE_KEY = 'ilap_ignore_gate';       // last reserved slot (bare epoch-ms number)
    const PENALTY_KEY = 'ilap_ignore_gate_penalty'; // rate-limit backoff ({ until, level })
    const Settings = window.ILAP.Settings;
    const MASTER_KEY = Settings.KEYS.MASTER;
    // Last ignore from a visible source (EQ / DQ); the background drainer yields
    // while it is fresh.
    const FOREGROUND_KEY = 'ilap_ignore_foreground_at';

    // Gap between two ignores across all sources: a fixed 650 ms, ~1.5/s, a pace
    // the account has tolerated. Fixed on purpose: the pace is courtesy to
    // Steam's servers, not an imitation of anything. GAP_FLOOR is a guardrail
    // against a careless edit to MIN_GAP, not a security control.
    const MIN_GAP = 650;
    const GAP_FLOOR = 350;
    const GAP = Math.max(GAP_FLOOR, MIN_GAP);

    // How long the background drainer yields after a visible ignore: about four
    // gaps, so a stream of them keeps it paused and a lone one holds it only
    // briefly.
    const YIELD_MS = 2500;

    // 429 backoff, shared by every source: doubles from PENALTY_BASE up to
    // PENALTY_MAX (a Retry-After is honoured up to the same cap), escalating
    // while each 429 lands within PENALTY_DECAY of the previous penalty's end.
    // A slot already reserved still fires; the penalty gates the next one.
    const PENALTY_BASE = 5000;
    const PENALTY_MAX = 300000;
    const PENALTY_DECAY = 60000;

    // Real queueing pushes a slot seconds ahead, plus at most one penalty. A slot
    // further ahead is clock skew or corruption, and waiting it out would make
    // the extension look dead.
    const MAX_AHEAD = 30000 + PENALTY_MAX;

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // At least one gap past the last slot, never in the past; a last slot beyond
    // MAX_AHEAD — or one that is not a number at all — counts as now.
    function nextSlot(lastAt, now, gap) {
        // Number.isFinite before the compare: a numeric STRING passes the
        // MAX_AHEAD test by coercion and then CONCATENATES in `last + gap`,
        // putting the slot ~50 000 years out. It self-heals (the next call reads
        // that back and this same guard rejects it) and an overflowing setTimeout
        // fires at once, so the cost is one unpaced ignore rather than a dead
        // extension — but this guard exists to answer for corruption, and a
        // hand-edited or downgraded key is corruption.
        const at = Number.isFinite(lastAt) ? lastAt : 0;
        const last = at > now + MAX_AHEAD ? now : at;
        return Math.max(now, last + gap);
    }

    // Escalates while the previous penalty is warm, resets after a quiet spell;
    // an implausibly-future stored penalty counts as absent.
    function nextPenalty(prev, now, retryAfterMs) {
        const p = (prev && typeof prev.until === 'number' && prev.until <= now + PENALTY_MAX)
            ? prev : null;
        const level = (p && now < p.until + PENALTY_DECAY) ? (p.level || 0) + 1 : 1;
        const backoff = Math.min(PENALTY_BASE * Math.pow(2, level - 1), PENALTY_MAX);
        const wait = Math.min(Math.max(backoff, retryAfterMs || 0), PENALTY_MAX);
        return { until: now + wait, level };
    }

    // The active penalty deadline, or 0 — same corruption rule as nextPenalty.
    function penaltyUntil(p, now) {
        if (!p || typeof p.until !== 'number') return 0;
        if (p.until > now + PENALTY_MAX) return 0;
        return p.until;
    }

    // Storage shim, duplicated per world on purpose (see src/curator/store.js).
    const get = (query) => new Promise(r => chrome.storage.local.get(query, r));
    const set = (obj) => new Promise(r => chrome.storage.local.set(obj, r));

    // Serializes the claim (read → compute → write) within this context. Across
    // tabs there is no CAS, so two tabs can occasionally share a slot; the
    // streams still collapse into one. The wait happens outside the chain.
    const serial = window.ILAP.serialChain();

    // "Is there a live Steam session?" — async and tri-state: null means the
    // check itself failed, which recovers differently from a logout.
    // The default answers for the tab (utils.js loads first). The service worker
    // has no utils.js and supplies its own through configure().
    async function defaultHasSession() {
        const ILAP = window.ILAP;
        // The sessionid cookie is only the precondition: Steam gives one to
        // anonymous visitors too.
        if (!(ILAP.getSessionID && ILAP.getSessionID())) return false;
        // No SteamAuth where utils.js loads is a broken build: a definite no.
        return ILAP.SteamAuth ? ILAP.SteamAuth.hasLiveSession() : false;
    }

    let hasSession = defaultHasSession;

    // For a host the default cannot serve; called once at boot.
    function configure(deps) {
        if (deps && deps.hasSession) hasSession = deps.hasSession;
    }

    // 'disabled' (master off), 'no-session' (confirmed), 'offline' (could not
    // check), or null when clear. Every verdict stops a pass. Only 'disabled'
    // ends with a storage write this extension hears, which is why the service
    // worker parks its alarm on it and keeps retrying the other two. Exported so
    // a drainer can ask before opening a pass.
    async function stopVerdict() {
        const data = await get({ [MASTER_KEY]: true });
        // Through the schema's isOn, like every other reader of a switch:
        // what counts as OFF is settled in one place, not re-spelled on the
        // path that decides whether an ignore may be sent.
        if (!Settings.isOn(data[MASTER_KEY])) return 'disabled';
        const live = await hasSession();
        if (live === true) return null;
        return live === null ? 'offline' : 'no-session';
    }

    // Called before every ignore. `opts.foreground` marks a visible source
    // (EQ / DQ): it stamps activity and never yields; the background drainer
    // yields while that stamp is fresh. Resolves { ok: true } when the slot
    // arrives, or { ok: false, reason } with a stop verdict or 'yield'; callers
    // stop the whole pass on !ok.
    function reserve(opts) {
        const foreground = !!(opts && opts.foreground);
        // Outside the chain: it can cost a network probe and writes nothing.
        const claim = stopVerdict().then((stop) => {
            if (stop) return { stop };
            return serial(async () => {
                const data = await get({ [GATE_KEY]: 0, [PENALTY_KEY]: null, [FOREGROUND_KEY]: 0 });
                const now = Date.now();
                if (!foreground && (now - (data[FOREGROUND_KEY] || 0)) < YIELD_MS) {
                    return { yield: true };
                }
                // An active penalty folds into the slot.
                const slot = Math.max(
                    nextSlot(data[GATE_KEY], now, GAP),
                    penaltyUntil(data[PENALTY_KEY], now)
                );
                const write = { [GATE_KEY]: slot };
                if (foreground) write[FOREGROUND_KEY] = now;
                await set(write);
                return { slot };
            });
        });
        return claim.then(async (r) => {
            if (r.stop) return { ok: false, reason: r.stop };
            if (r.yield) return { ok: false, reason: 'yield' };
            const wait = r.slot - Date.now();
            if (wait > 0) {
                await sleep(wait);
                // A master flip or logout during the wait stops the ignore; the
                // slot stays spent.
                const stop = await stopVerdict();
                if (stop) return { ok: false, reason: stop };
            }
            return { ok: true };
        });
    }

    // A 429 from the ignore endpoint: escalate the shared penalty. Same chain as
    // reserve(), so the two read-modify-writes cannot interleave in one context.
    function reportRateLimited(retryAfterMs) {
        return serial(async () => {
            const data = await get({ [PENALTY_KEY]: null });
            const p = nextPenalty(data[PENALTY_KEY], Date.now(), retryAfterMs);
            await set({ [PENALTY_KEY]: p });
            return p;
        });
    }

    window.ILAP.IgnoreGate = {
        configure,
        reserve, reportRateLimited, stopVerdict, nextSlot, nextPenalty, penaltyUntil,
        GATE_KEY, PENALTY_KEY, FOREGROUND_KEY, MIN_GAP, GAP_FLOOR, MAX_AHEAD, YIELD_MS,
        PENALTY_BASE, PENALTY_MAX, PENALTY_DECAY
    };
})();
