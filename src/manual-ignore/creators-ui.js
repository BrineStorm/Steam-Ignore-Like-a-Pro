// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    window.ILAP = window.ILAP || {};
    window.ILAP.ManualIgnore = window.ILAP.ManualIgnore || {};

    // Steam's creator ignore on the page (src/creators.js has the data). A
    // creator is a developer, publisher or franchise with a page of its own.
    //  - The link of an ignored creator is grey, wherever this tab knows its
    //    clan id: on a game's page all of its creators (one read), elsewhere the
    //    links of a creator a gesture was made on.
    //  - On a game's page a hover or keyboard focus on a creator's link slides a
    //    pill out to its right: Ignore creator, or Un-ignore for an ignored one.
    //    Where Steam refuses the ignore, the pill is locked and its tooltip says
    //    why: a followed creator, and a creator with no page of its own (its
    //    link is a store search, and the game's read gave it no clan id).
    //  - The ignore gestures on a creator's link ignore it, the un-ignore gesture
    //    takes it back.
    // Nothing is sent from here: an entry goes into the creator job
    // (Store.enqueueCreator), and the drainer sends it.

    // How long a pill stays out after the pointer or the focus left it.
    const PILL_LINGER_MS = 150;
    // The pill's distance from the end of its link.
    const PILL_GAP = 6;
    // Where a game's page lists its creators, by links to creator pages and by
    // the plain search links of a developer or publisher (matched by name).
    const GAME_PAGE_ROWS = '.dev_row, #developers_list';
    const GAME_PAGE_LINKS = '.dev_row a, #developers_list a';
    // The padlock on a locked pill.
    const LOCK_SVG = '<svg class="ilap-cpill-lock" viewBox="0 0 10 12" aria-hidden="true">'
        + '<path d="M2.5 5V3.5a2.5 2.5 0 0 1 5 0V5" fill="none" stroke="currentColor" stroke-width="1.4"/>'
        + '<rect x="1" y="5" width="8" height="6.5" rx="1.3" fill="currentColor"/></svg>';
    // A locked pill's reason: one tooltip for the page, on the root, since
    // Steam's creator rows clip what hangs out of them.
    const TIP_ID = 'ilap-cpill-tip';
    const TIP_GAP = 6;

    // A store search for a developer, publisher or franchise by name: the
    // link Steam gives a creator with no page of its own.
    function isCreatorSearch(href) {
        let url;
        try { url = new URL(href, location.href); } catch (e) { return false; }
        return url.origin === 'https://store.steampowered.com' && url.pathname === '/search/'
            && ['developer', 'publisher', 'franchise'].some(k => url.searchParams.has(k));
    }

    // Where a fixed element's left and top count from: the window, or the
    // nearest ancestor whose transform, filter or containment takes its place
    // (Steam blurs the back of a game page's top block).
    function fixedOrigin(el) {
        for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
            const s = getComputedStyle(e);
            if (s.transform !== 'none' || s.filter !== 'none' || s.perspective !== 'none'
                || (s.backdropFilter && s.backdropFilter !== 'none')
                || /paint|layout|strict|content/.test(s.contain)
                || /transform|filter|perspective/.test(s.willChange)
                || (s.containerType && s.containerType !== 'normal')) {
                const r = e.getBoundingClientRect();
                return { left: r.left + e.clientLeft, top: r.top + e.clientTop };
            }
        }
        return { left: 0, top: 0 };
    }

    class CreatorControl {
        // read()                → Promise<{ mirror, job, cursor }>
        // effective(m, j, c)    → Map clanid -> name (Creators.effective)
        // enqueue(spec)         → Promise<{ kind }>   (Store.enqueueCreator)
        // fetchClanId(href)     → Promise<clanid | null>
        // fetchAppCreators(id)  → Promise<[{ id, name }] | null>
        // creatorPath(href)     → 'developer/<name>' and the like, or null (gestures.js)
        // linkSelector          the creator links a gesture takes (gestures.js CREATOR_LINK)
        // isLoggedIn()          → Promise<bool>, a live session: what a request needs
        // isSignedIn()          → Promise<bool>, by the page's header first: what the pills need
        // isEnabled()           → bool (the master switch, live)
        // toast(key, params)
        // t(key)                → this language's string
        // iconUrl               the extension's logo on the pill (optional)
        constructor(deps) {
            for (const name of ['read', 'effective', 'enqueue', 'fetchClanId', 'fetchAppCreators',
                'isLoggedIn', 'isSignedIn', 'isEnabled', 'toast', 't', 'creatorPath']) {
                if (typeof deps[name] !== 'function') {
                    throw new TypeError(`[ILAP] CreatorControl needs deps.${name}`);
                }
            }
            if (typeof deps.linkSelector !== 'string' || !deps.linkSelector) {
                throw new TypeError('[ILAP] CreatorControl needs deps.linkSelector');
            }
            Object.assign(this, deps);
            this.ignored = new Map();      // clanid -> name, as the user sees it
            this.followed = new Set();
            this.byPath = new Map();       // 'developer/<name>' -> clanid
            this.byName = new Map();       // a game page's creator name -> clanid, null for two of one name
            this.names = new Map();        // clanid -> name
            this._busy = new Set();        // paths whose clan id is being read
            this.appRead = false;          // the game's creators were read
            this.signedIn = false;         // as the page said at boot
            this._pageAppid = null;        // the game page open, or null
            this._appAsked = false;        // its creators have been asked for
            this._open = null;             // the one anchor whose pill is out
        }

        // On a game's page, its creators first: their links get the grey and
        // the pill. Then the state.
        async boot(pathname) {
            const m = String(pathname || '').match(/^\/app\/(\d+)/);
            this._pageAppid = m ? m[1] : null;
            this.signedIn = await this.isSignedIn();
            await this._readApp();
            await this.refresh();
        }

        // The master switch came on: what the boot could not ask, it asks now.
        async resume() {
            if (this._appAsked) return;
            await this._readApp();
            this.paint();
        }

        // The game's creators, once per page. With the master off or signed out
        // Steam is not asked: nothing here would use the answer.
        async _readApp() {
            if (!this._pageAppid || this._appAsked || !this.signedIn || !this.isEnabled()) return;
            this._appAsked = true;
            const list = await this.fetchAppCreators(this._pageAppid);
            this.appRead = Array.isArray(list);
            for (const c of list || []) {
                // Two creators of one name (a developer and a franchise, say)
                // cannot be told apart by a link's text: such a link is known
                // by its page alone.
                const known = this.byName.get(c.name);
                this.byName.set(c.name, known === undefined || known === c.id ? c.id : null);
                this.names.set(c.id, c.name);
            }
        }

        // The state from storage, then the page painted from it.
        async refresh() {
            const { mirror, job, cursor } = await this.read();
            this.ignored = this.effective(mirror, job, cursor);
            this.followed = new Set((mirror && mirror.followed) || []);
            for (const [id, name] of this.ignored) if (name && !this.names.has(id)) this.names.set(id, name);
            this.paint();
        }

        // The clan id this tab knows a link by, or null.
        idOf(link) {
            const path = this.creatorPath(link.getAttribute('href') || '');
            if (path && this.byPath.has(path)) return this.byPath.get(path);
            const text = (link.textContent || '').trim();
            return this.byName.has(text) && link.closest(GAME_PAGE_ROWS) ? this.byName.get(text) : null;
        }

        _links() {
            return document.querySelectorAll(`${this.linkSelector}, ${GAME_PAGE_LINKS}`);
        }

        // Grey on the links of ignored creators, a pill on a game page's
        // creator links. With the master switch off, none of it, and signed out no
        // pill, whose click could only do nothing. A link to a
        // creator's page gets its pill even while its clan id is unknown (the
        // game's read failed): the click reads the id then. A search link gets
        // a locked one only once the game's read said it has no clan id.
        paint() {
            const on = this.isEnabled();
            for (const link of this._links()) {
                const id = on ? this.idOf(link) : null;
                if (id && this.ignored.has(id)) link.dataset.ilapCreator = 'ignored';
                else delete link.dataset.ilapCreator;
                const href = link.getAttribute('href') || '';
                const pageLink = !!this.creatorPath(href);
                // A name two creators share says nothing of either's page.
                const shared = this.byName.get((link.textContent || '').trim()) === null;
                const noPage = !id && !pageLink && !shared && this.appRead && isCreatorSearch(href);
                if (on && this.signedIn && (id || pageLink || noPage) && link.closest(GAME_PAGE_ROWS)) this._wirePill(link);
                const anchor = link.nextElementSibling;
                if (anchor && anchor.classList.contains('ilap-cpill-anchor')) {
                    anchor.dataset.clanid = id || '';
                    const lock = noPage ? 'creator_no_page'
                        : id && this.followed.has(id) && !this.ignored.has(id) ? 'creator_followed' : '';
                    if (lock) anchor.dataset.lock = lock;
                    else delete anchor.dataset.lock;
                    anchor.hidden = !on;
                    this._label(anchor);
                }
            }
        }

        // The pill's button after the link, so Tab reaches it next. Once per
        // link; paint() keeps its clan id.
        _wirePill(link) {
            if (link.dataset.ilapCpill) return;
            link.dataset.ilapCpill = '1';
            this._followScroll();
            const anchor = document.createElement('span');
            anchor.className = 'ilap-cpill-anchor';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ilap-cpill';
            anchor.appendChild(btn);
            link.after(anchor);
            this._label(anchor);

            let timer = null;
            const open = () => {
                clearTimeout(timer);
                if (anchor.hidden) return;
                // One pill out at a time: the one before goes at once, so a
                // move from one creator's link to the next shows one pill.
                if (this._open && this._open !== anchor) this._shut(this._open, true);
                this._open = anchor;
                this._label(anchor);
                this._place(anchor);
                delete anchor.dataset.snap;
                anchor.dataset.open = '';
            };
            const close = () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    // Focus still on the link or the pill keeps it out.
                    if (anchor.contains(document.activeElement) || document.activeElement === link) return;
                    this._shut(anchor, false);
                }, PILL_LINGER_MS);
            };
            // A locked pill's reason, on a hover of the pill itself or its
            // keyboard focus (the reason is its description either way).
            btn.addEventListener('mouseenter', () => this._showTip(anchor, true));
            btn.addEventListener('focus', () => this._showTip(anchor, btn.matches(':focus-visible')));
            btn.addEventListener('mouseleave', () => this._hideTip());
            btn.addEventListener('blur', () => this._hideTip());
            for (const el of [link, btn]) {
                el.addEventListener('mouseenter', open);
                el.addEventListener('mouseleave', close);
                el.addEventListener('focus', open);
                el.addEventListener('blur', close);
                el.addEventListener('keydown', (e) => {
                    if (e.key !== 'Escape' || !('open' in anchor.dataset)) return;
                    clearTimeout(timer);
                    this._shut(anchor, false);
                });
            }
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!e.isTrusted || anchor.dataset.lock) return;
                this.request({ link, ignore: !this.ignored.has(anchor.dataset.clanid) })
                    .catch((err) => console.warn('[ILAP] creator pill failed:', err));
            });
        }

        // A pill back in, faded or at once (`snap`).
        _shut(anchor, snap) {
            if (snap) anchor.dataset.snap = '';
            delete anchor.dataset.open;
            if (this._open === anchor) this._open = null;
            this._hideTip();
        }

        // The pill is fixed, since Steam's creator rows clip what hangs out
        // of them: right of its link, on the link's middle.
        _place(anchor) {
            const r = anchor.getBoundingClientRect();
            const l = anchor.previousElementSibling.getBoundingClientRect();
            const o = fixedOrigin(anchor);
            anchor.firstElementChild.style.left = (r.left - o.left + PILL_GAP) + 'px';
            anchor.firstElementChild.style.top = (l.top - o.top + l.height / 2) + 'px';
        }

        // An open pill stays on its link through a scroll or a resize.
        _followScroll() {
            if (this._following) return;
            this._following = true;
            const follow = () => { if (this._open) this._place(this._open); };
            window.addEventListener('scroll', follow, { passive: true, capture: true });
            window.addEventListener('resize', follow, { passive: true });
        }

        // The page's one tooltip, made on first use.
        _tip() {
            let tip = document.getElementById(TIP_ID);
            if (!tip) {
                tip = document.createElement('span');
                tip.id = TIP_ID;
                tip.className = 'ilap-cpill-tip';
                tip.setAttribute('role', 'tooltip');
                document.documentElement.appendChild(tip);
            }
            return tip;
        }

        // The reason of a locked pill, as its description, and when `visible`
        // faded in under the pill, kept inside the window's width.
        _showTip(anchor, visible) {
            const lock = anchor.dataset.lock;
            if (!lock) return;
            const tip = this._tip();
            tip.textContent = this.t(lock);
            if (!visible) return;
            const r = anchor.firstElementChild.getBoundingClientRect();
            const room = document.documentElement.clientWidth - tip.offsetWidth - TIP_GAP;
            tip.style.left = (window.scrollX + Math.max(TIP_GAP, Math.min(r.left, room))) + 'px';
            tip.style.top = (window.scrollY + r.bottom + TIP_GAP) + 'px';
            tip.classList.add('shown');
        }

        _hideTip() {
            const tip = document.getElementById(TIP_ID);
            if (tip) tip.classList.remove('shown');
        }

        // The pill's logo and words, and on a locked one the padlock and its
        // description. Rewritten only on a change, so an open pill keeps its
        // transition.
        _label(anchor) {
            const btn = anchor.firstElementChild;
            const lock = anchor.dataset.lock || '';
            const text = this.t(!lock && this.ignored.has(anchor.dataset.clanid) ? 'creator_unignore' : 'creator_ignore');
            if (btn.textContent !== text || btn.dataset.lock !== lock) {
                btn.innerHTML = lock ? LOCK_SVG : '';
                if (this.iconUrl) {
                    const logo = document.createElement('img');
                    logo.className = 'ilap-cpill-logo';
                    logo.src = this.iconUrl;
                    logo.alt = '';
                    btn.prepend(logo);
                }
                btn.append(text);
                btn.dataset.lock = lock;
            }
            if (lock) {
                btn.setAttribute('aria-disabled', 'true');
                btn.setAttribute('aria-describedby', TIP_ID);
            } else {
                btn.removeAttribute('aria-disabled');
                btn.removeAttribute('aria-describedby');
            }
        }

        // A gesture or a pill click on a creator's link: `ignore` true to
        // ignore it, false to take it back.
        async request({ link, ignore }) {
            if (!this.isEnabled()) return;
            const path = this.creatorPath(link.getAttribute('href') || '');
            const key = path || (link.textContent || '').trim();
            if (this._busy.has(key)) return;
            this._busy.add(key);
            try {
                if (!(await this.isLoggedIn())) return;
                let id = this.idOf(link);
                if (!id && path) {
                    id = await this.fetchClanId(link.getAttribute('href'));
                    if (id) {
                        this.byPath.set(path, id);
                        // Its grey and its pill's words, also when nothing is sent.
                        this.paint();
                    }
                }
                if (!id) {
                    this.toast('creator_no_page');
                    return;
                }
                // Already as asked: nothing to send.
                if (this.ignored.has(id) === ignore) return;
                if (ignore && this.followed.has(id)) {
                    this.toast('creator_followed');
                    return;
                }
                const name = this.names.get(id) || window.ILAP.Sanitizer.sanitizeName((link.textContent || '').trim());
                const outcome = await this.enqueue({ clanid: id, name, ignore });
                if (!outcome || outcome.kind !== 'added') {
                    if (outcome && outcome.kind === 'full') this.toast('creator_queue_stuck');
                    return;
                }
                if (ignore) this.toast('creator_ignored_toast', { name });
                // The queue write repaints every tab; this one at once.
                await this.refresh();
            } finally {
                this._busy.delete(key);
            }
        }
    }

    window.ILAP.ManualIgnore.CreatorControl = CreatorControl;

})();
