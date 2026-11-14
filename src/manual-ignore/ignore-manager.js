// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.ManualIgnore = window.ILAP.ManualIgnore || {};

    // What a gesture does on a store page: the gates it passes, the queue entry it
    // makes and the mark that follows. main.js builds it and hands it everything.

    // How long after ignoring a game its solo un-ignore stays inert: a brake on
    // ignore→rollback POST ping-pong, short enough that nobody notices it.
    const UNIGNORE_COOLDOWN_MS = 2000;

    class IgnoreManager {
        constructor(deps) {
            // Every hook is required: a missing login gate or master check would
            // not fail, it would quietly let a gesture through.
            for (const name of ['enqueue', 'enqueueUndo', 'cancelIgnore', 'signalUnignored', 'spare', 'steamReason',
                'isLoggedIn', 'isEnabled', 'notifyQueueFull', 'notifyUndoQueueFull', 'notifyDropped']) {
                if (typeof deps[name] !== 'function') {
                    throw new TypeError(`[ILAP] IgnoreManager needs deps.${name}`);
                }
            }
            // The collaborators would only fail at the first gesture: check them
            // at boot too.
            const adapters = {
                badgeRenderer: ['render', 'unrender', 'syncPending', 'syncMasks'],
                containerStrategies: ['findContainer'],
                nameExtractor: ['get'],
                // The three mark models (marks.js).
                badgeMarks: ['has', 'reason', 'queuedAt', 'isAuto', 'appids', 'add', 'delete', 'save'],
                tintMarks: ['has', 'reason', 'greyed', 'claims', 'set', 'clear', 'noteUnignored', 'paint', 'hide'],
                bundleMarks: ['has', 'list', 'set', 'paint', 'hide'],
            };
            for (const [name, fns] of Object.entries(adapters)) {
                if (!deps[name] || !fns.every(fn => typeof deps[name][fn] === 'function')) {
                    throw new TypeError(`[ILAP] IgnoreManager needs deps.${name}`);
                }
            }
            this.renderer = deps.badgeRenderer;
            this.strategies = deps.containerStrategies;
            this.enqueue = deps.enqueue;            // (appid, name, reason, ts) => Promise<{ kind }>
            this.enqueueUndo = deps.enqueueUndo;    // (appid) => Promise<{ kind }>
            this.cancelIgnore = deps.cancelIgnore;  // (appid, ts) => Promise<boolean>
            this.signalUnignored = deps.signalUnignored;  // (appid) => Promise<void>
            // (appid) => Promise<void>: the user un-ignored the game by hand,
            // so the browsing switch leaves it from now on.
            this.spare = deps.spare;
            // (appid) => Promise<reason | undefined>: the reason Steam's list has
            // for the game, undefined when it is not there or the read failed.
            this.steamReason = deps.steamReason;
            this.nameExtractor = deps.nameExtractor;
            this.isLoggedIn = deps.isLoggedIn;      // () => Promise<bool> (logged-out gate)
            // Master toggle, read live (() => bool). A disabled extension paints
            // nothing on the page — see refreshAll, refreshBadgesForGame, hideBadges.
            this.isEnabled = deps.isEnabled;
            // () => void each, throttled by the adapter. The un-ignore queue has
            // its own "full" card: the MI one names the ignore job.
            this.notifyQueueFull = deps.notifyQueueFull;
            this.notifyUndoQueueFull = deps.notifyUndoQueueFull;
            this.notifyDropped = deps.notifyDropped;

            this.badges = deps.badgeMarks;
            this.tints = deps.tintMarks;
            this.bundles = deps.bundleMarks;
            // Appids whose solo un-ignore is queued but not confirmed. Per tab, like
            // the badges it marks.
            this.pending = new Set();
            // Swipes whose enqueue is still in flight. The badge check that opens
            // processIgnoreRequest cannot hold across its awaits — the badge is
            // added at the END — so two fast swipes on one capsule both pass it.
            // The queue dedupes, so nothing is ignored twice; what this saves is
            // the second resolve, which on a capsule with no readable name is an
            // appdetails request.
            this._enqueueing = new Set();
        }

        async processIgnoreRequest(intent) {
            const { appid, reason, linkElement } = intent;

            if (this.badges.has(appid) || this._enqueueing.has(appid)) return;

            // Steam already greys this capsule out: the game is on the account's
            // list. The gesture then sets its reason, and Steam's flag takes the
            // gesture's colour instead of a badge of ours.
            const greyed = this.tints.greyed(linkElement, appid);
            if (greyed && this.tints.reason(appid) === reason) return;

            this._enqueueing.add(appid);
            try {
                // A logged-out swipe does nothing: its POST could only be refused,
                // and the drainer parks on a dead session rather than dropping the
                // job, so the badge would never be corrected.
                if (!(await this.isLoggedIn())) return;

                // The reason Steam already has changes nothing: no POST, and no
                // mark either. Unless this tab tinted the other reason since:
                // then it is queued to take that back, and the tint goes. A
                // failed read leaves it to the drainer's own check.
                const asSteam = greyed && (await this.steamReason(appid)) === reason;
                if (asSteam && !this.tints.has(appid)) return;

                // The name now, while the DOM is live: the drainer stamps Last
                // Ignored with it when the POST lands.
                const containerObj = this.strategies.findContainer(linkElement);
                const contextEl = containerObj ? containerObj.element : linkElement;
                const name = await this.nameExtractor.get(appid, contextEl);

                // Enqueue before badging: a swipe past MI_MAX is refused, and the
                // badge must only paint for one that landed.
                const ts = Date.now();
                const outcome = await this.enqueue(appid, name, reason, ts);
                if (!outcome || outcome.kind !== 'added') {
                    // The cap is only reached when the queue is not draining at
                    // all, so say so rather than paint nothing.
                    if (outcome && outcome.kind === 'full') this.notifyQueueFull();
                    return;
                }
                if (asSteam) {
                    this.tints.clear(appid);
                } else if (greyed) {
                    this.tints.set(appid, reason);
                    // Through refreshAll's pass rather than `greyed` alone: the
                    // same game may sit in several capsules on the page.
                    this.refreshAll();
                } else {
                    this._badge(appid, reason, ts, false);
                }
            } finally {
                this._enqueueing.delete(appid);
            }
        }

        // A game the browsing switch may not take: this tab already marked it,
        // has it on the way, or saw it un-ignored, or Steam greys the capsule.
        isMarked(link, appid) {
            return this.badges.has(appid) || this._enqueueing.has(appid) || this.tints.claims(link, appid);
        }

        // A game the browsing switch queued at `ts`, once its shot lands: badged
        // as a swipe's, with the AI mark. A swipe made on it in the meantime
        // keeps its own mark.
        markAuto(appid, ts) {
            if (this.badges.has(appid)) return;
            this._badge(appid, 0, ts, true);
        }

        _badge(appid, reason, ts, auto) {
            this.badges.add(appid, reason, ts, auto);
            this.badges.save();
            this.refreshBadgesForGame(appid);
        }

        // Un-ignore one game, through the same queue and gate. Only what this tab
        // badged: BadgeMarks is the badge model.
        async processUnignoreRequest(intent) {
            const { appid } = intent;

            if (!this.badges.has(appid)) return;     // nothing badged → nothing to undo
            if (this.pending.has(appid)) return;     // already queued; re-gesturing is a no-op

            // Regret before the ignore was sent: cancel the queued entry instead
            // of queueing a rollback. Ahead of both gates below: the cooldown
            // brakes POST ping-pong and a cancel sends no POST, and cancelling
            // needs no session.
            if (await this.cancelIgnore(appid, this.badges.queuedAt(appid))) {
                // Spared before the pulse, so no tab shoots it on the way.
                await this.spare(appid);
                // Through the pulse, not in place: another tab may have badged the
                // same game, and this tab's own listener handles it on the way back.
                await this.signalUnignored(appid);
                return;
            }

            // From here it is a real remove=1 POST: the cooldown applies, silently.
            const at = this.badges.queuedAt(appid);
            if (at && Date.now() - at < UNIGNORE_COOLDOWN_MS) return;

            // Same logged-out gate as the ignore path.
            if (!(await this.isLoggedIn())) return;

            const outcome = await this.enqueueUndo(appid);
            if (!outcome || outcome.kind !== 'added') {
                if (outcome && outcome.kind === 'full') this.notifyUndoQueueFull();
                return;
            }
            this.pending.add(appid);
            this.syncPending();
            await this.spare(appid);
        }

        // A rollback was refused or its job removed: the badges are still true,
        // only the pending marks come off. All of them, since the pulse has no
        // appid; at worst a still-queued gesture loses its mark.
        clearPending() {
            if (!this.pending.size) return;
            this.pending.clear();
            this.syncPending();
        }

        syncPending() {
            this.renderer.syncPending(Array.from(this.pending));
        }

        // The ilap_unignored pulse: drop the marks this tab painted for these
        // games. 'undo' took them off the list; 'removed' and 'failed' left
        // Steam's list as it was. 'failed' is the one the user did
        // not ask for, so only then — and only in a tab that marked one by hand —
        // is it said. A game the browsing switch shot is the user's no more than
        // a curator job's entry is: its badge goes in silence.
        handleUnignored(appids, reason) {
            let dropped = 0;
            let byHand = false;
            for (const raw of (Array.isArray(appids) ? appids : [appids])) {
                const appid = String(raw);
                if (reason === 'undo') this.tints.noteUnignored(appid);
                if (this.tints.clear(appid)) { dropped += 1; byHand = true; }
                const auto = this.badges.isAuto(appid);
                if (!this.badges.delete(appid)) continue;  // only clear what THIS tab badged
                this.pending.delete(appid);   // the badge is going — its mark goes with it
                this.renderer.unrender(appid);
                dropped += 1;
                if (!auto) byHand = true;
            }
            if (!dropped) return;
            this.badges.save();
            if (reason === 'failed' && byHand) this.notifyDropped();
        }

        refreshBadgesForGame(appid) {
            // A gesture mid-enqueue when the switch went off must not paint; its
            // badge stays in the model for the re-enable.
            if (!this.isEnabled()) return;
            const reason = this.badges.reason(appid);
            const auto = this.badges.isAuto(appid);

            const exact = new RegExp(`/app/${appid}(/|\\?|$)`);
            const candidates = document.querySelectorAll(`a[href*="/app/${appid}"]`);
            candidates.forEach(link => {
                if (!exact.test(link.getAttribute('href'))) return;
                this.renderer.render(link, appid, reason, auto);
            });
        }

        // The finished bundles, as stored (ilap_ignored_bundles).
        setBundleMarks(keys) {
            this.bundles.set(keys);
            this.refreshAll();
        }

        isBundleMarked(key) {
            return this.bundles.has(key);
        }

        refreshAll() {
            // Guarded here rather than at the three call sites.
            if (!this.isEnabled()) return;
            this.bundles.paint(document);
            if (this.badges.size === 0 && this.tints.size === 0) return;
            // One document pass against the badges and the tints, not one per
            // appid: this runs on every mutation batch of the storefront.
            const links = document.querySelectorAll('a[href*="/app/"]');
            for (const link of links) {
                const m = (link.getAttribute('href') || '').match(/\/app\/(\d+)([/?]|$)/);
                if (!m) continue;
                this.tints.paint(link, m[1]);
                if (!this.badges.has(m[1])) continue;
                this.renderer.render(link, m[1], this.badges.reason(m[1]), this.badges.isAuto(m[1]));
            }
            // Badges Steam just rebuilt come back without their pending mark.
            if (this.pending.size) this.syncPending();
        }

        syncMasks() {
            this.renderer.syncMasks(this.badges.appids().concat(this.bundles.list()));
        }

        // Master toggle off: unrender every mark this tab painted (badge, blur,
        // veil). The models stay — they are what a re-enable repaints from.
        hideBadges() {
            this.bundles.hide();
            for (const appid of this.badges.appids()) this.renderer.unrender(appid);
            this.tints.hide();
        }
    }

    window.ILAP.ManualIgnore.IgnoreManager = IgnoreManager;
})();
