// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // On-page surface for the popup. The browser-toolbar action popup is
    // unreachable inside the Steam desktop client, so the same popup component is
    // hosted here in a shadow root: an icon launcher pinned top-right that expands
    // the panel. Both surfaces are views over chrome.storage.local.

    if (window.__ilapWidgetMounted) return;
    window.__ilapWidgetMounted = true;

    const ICON = 34;
    const TOP = Math.round(ICON * 1.5); // sit ~1.5 icon-heights below the top, clear of Steam's header

    // Collapsed-launcher state, shared across tabs via chrome.storage.local:
    // 0 / absent = collapsed to the chevron tab; >0 = expanded, value = the
    // last-activity timestamp. Any tab's idle timer may collapse the widget,
    // but the shared timestamp (bumped on interaction, throttled) keeps a tab
    // that's actually in use from being collapsed by an idle sibling.
    const STATE_KEY = 'ilap_widget_expanded_ts';
    // Pin badge pressed: the launcher stays out, the idle auto-stash is disabled
    // until the user unpresses it. Shared across tabs like STATE_KEY.
    const PIN_KEY = 'ilap_widget_pinned';
    // Global on/off (the panel's master toggle). While the extension is disabled
    // the pin is inert — it's a preference for an active widget, so pinning makes
    // no sense with everything off. Absent = enabled.
    const MASTER_KEY = 'ilap_master_enabled';
    const IDLE_MS = 60000;            // stash after a minute with the panel closed
    const ACTIVITY_THROTTLE_MS = 5000; // min gap between activity-timestamp writes

    const SPARED = '#45A1FA'; // EQ "Spared" outline colour
    const SPARED_DIM = 'rgba(69, 161, 250, .4)'; // paler idle outline for the launcher
    const LOGO_RED = '#d32f2f'; // the IGNORED-ribbon red (same red EQ/DQ use)
    const LOGO_WHITE = '#e8eef4'; // the dice white
    const FONT = '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif';

    const LAUNCHER_CSS = `
        /* Force the popup font across the whole widget via a direct rule (beats
           popup.css inheritance, so labels like "Your Discovery Queue" can't fall
           back to Steam's page font), and don't depend on the linked stylesheet
           having loaded yet. */
        :host, :host * { font-family: ${FONT}; }
        .ilap-launcher {
            width: ${ICON}px; height: ${ICON}px; padding: 0;
            display: flex; align-items: center; justify-content: center;
            background: #1a2735; border: 1px solid ${SPARED_DIM}; border-radius: 8px;
            cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.5);
            transition: border-color .15s ease, box-shadow .15s ease, transform .25s ease, opacity .2s ease;
        }
        /* Stashed: slid off past the right screen edge, chevron takes over. */
        .ilap-launcher.stashed { transform: translateX(${ICON + 14}px); opacity: 0; pointer-events: none; }
        /* The chevron tab shown while the launcher is stashed. Passive look is
           flat and outline-free; the blue outline is reserved for the temporary
           "welcome back" highlight after a popup→widget switch (.restored). */
        .ilap-chevron {
            position: absolute; top: 50%; right: 3px; margin-top: -13px; padding: 0;
            width: 15px; height: 26px;
            display: flex; align-items: center; justify-content: center;
            border: 1px solid transparent; border-radius: 6px;
            background: #1a2735;
            cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.5);
            opacity: 0; pointer-events: none;
            transition: opacity .15s ease, box-shadow .15s ease, border-color .3s ease;
        }
        /* Appear slightly after the launcher has slid away — passive chevron is
           a touch faded; a direct hover brings it to full strength. */
        .ilap-chevron.shown {
            opacity: .7; pointer-events: auto;
            transition: opacity .2s ease .18s, box-shadow .15s ease, border-color .3s ease;
        }
        .ilap-chevron.shown:not(.ghost):hover { opacity: 1; }
        .ilap-chevron:hover { box-shadow: 0 0 7px rgba(69,161,250,.5), 0 2px 8px rgba(0,0,0,.5); }
        /* A hover adds a real blue outline on top of the glow. */
        .ilap-chevron:not(.ghost):hover { border-color: ${SPARED}; }
        .ilap-chevron:hover svg { opacity: 1; }
        /* Temporary highlight right after coming back from the parked popup
           surface: a 3 s gold pulse (.gold) grabs the eye, then it settles to a
           steady blue outline for ~7 s more, then fades back to the passive
           outline-free look (both classes dropped on a JS timeline). */
        .ilap-chevron.restored {
            opacity: 1; border-color: ${SPARED};
            box-shadow: 0 0 7px rgba(69,161,250,.5), 0 2px 8px rgba(0,0,0,.5);
        }
        /* Gold phase: a golden gradient halo radiates outward from the chevron
           (larger than the chevron, via a scaling ::before), on a steady gold rim. */
        .ilap-chevron.restored.gold { border-color: #f5c518; }
        .ilap-chevron.restored.gold::before {
            content: ''; position: absolute; inset: -8px; border-radius: 12px;
            background: radial-gradient(ellipse at center, rgba(245,197,24,.7) 0%, rgba(245,197,24,.3) 45%, rgba(245,197,24,0) 72%);
            pointer-events: none; z-index: -1;
            animation: ilap-chevron-radiate 1.1s ease-out infinite;
        }
        @keyframes ilap-chevron-radiate {
            0%   { transform: scale(.45); opacity: .95; }
            100% { transform: scale(2.3); opacity: 0; }
        }
        /* Popup-surface ghost: the widget is parked — only a barely-visible
           chevron stays as a beacon. Hovering reveals it (and its "how to get
           the widget back" tooltip); clicking it does nothing in this state. */
        .ilap-chevron.ghost { opacity: .1; cursor: default; transition: opacity .25s ease, box-shadow .15s ease; }
        .ilap-chevron.ghost:hover { opacity: .95; }
        /* Custom tooltip for the chevron (styled like the EQ badge tooltip), so
           hovering it never falls back to a native browser title. Used for both
           the parked-ghost "how to get the widget back" hint and the passive
           "expand" hint; sizes to its content up to a cap. */
        .ilap-ghost-tip {
            position: absolute; top: 50%; right: 22px; transform: translateY(-50%);
            max-width: 190px; background: #171a21; color: #c7d5e0;
            padding: 8px 12px; border-radius: 4px; border: 1px solid ${SPARED};
            font-size: 11px; line-height: 1.4; text-align: left;
            box-shadow: 0 5px 20px rgba(0,0,0,.8);
            z-index: 1000; pointer-events: none;
            visibility: hidden; opacity: 0; transition: opacity .15s ease, visibility .15s ease;
        }
        .ilap-ghost-tip.shown { visibility: visible; opacity: 1; }
        /* The passive "expand" hint is a slim single-line strip, sat well below
           the chevron's centre rather than dead-centre. */
        .ilap-ghost-tip.expand {
            max-width: none; white-space: nowrap;
            padding: 4px 8px; font-size: 10px;
            transform: translateY(calc(-50% + 16px));
        }
        .ilap-chevron.pulse { animation: ilap-launcher-pulse .9s ease-in-out 1; }
        .ilap-chevron svg { display: block; pointer-events: none; opacity: .8; transition: opacity .15s ease; }
        /* Mini pushpin badge sitting as a small rounded square ABOVE the launcher,
           flush to its right edge, just clear of the launcher's top. Contourless.
           Revealed by a direct hover, or by holding the pointer on the launcher
           (see the delayed rule below); pressed = the launcher is pinned out and
           the idle auto-stash is disabled. Slides away with the launcher. */
        .ilap-pin {
            position: absolute; top: -22px; right: 0; padding: 0;
            width: 19px; height: 18px;
            display: flex; align-items: center; justify-content: center;
            background: #8a949e; border-radius: 6px;
            color: #2b3138; cursor: pointer;
            opacity: 0;
            transition: color .15s ease, transform .25s ease, opacity .2s ease;
        }
        /* Direct hover on the pin reveals it instantly. A pressed pin is NOT
           forced visible — it stays hidden like an unpressed one until hovered
           (or the launcher is held), so the user can peek at the pin state on
           demand without a badge sitting there permanently. */
        .ilap-pin:hover { opacity: 1; }
        /* Hovering the launcher reveals the pin only after a deliberate ~5 s hold
           (delayed opacity transition), so a casual pass over the icon can't flash it. */
        .ilap-launcher:hover ~ .ilap-pin { opacity: 1; transition-delay: 5s; }
        .ilap-pin.pinned { color: #fff; }
        .ilap-pin.stashed { transform: translateX(${ICON + 14}px); opacity: 0; pointer-events: none; }
        /* Pinning is a visibility preference, not a Steam action — it stays
           clickable while login-locked, just greyed to match the launcher. */
        .ilap-pin.locked { filter: grayscale(1); }
        /* Extension disabled (master toggle off): the pin is a no-op. It still
           greys and reveals on a launcher hold so its state stays visible, but it
           can't be toggled while everything is off. */
        .ilap-pin.disabled { pointer-events: none; filter: grayscale(1); }
        .ilap-pin svg { display: block; pointer-events: none; }
        .ilap-launcher:hover, .ilap-launcher.active { border-color: ${SPARED}; box-shadow: 0 2px 12px rgba(0,0,0,.6); }
        /* Logged-out lock: greyed, no hover highlight, panel won't open. */
        .ilap-launcher.locked, .ilap-launcher.locked:hover {
            filter: grayscale(1); opacity: .55; cursor: not-allowed;
            border-color: ${SPARED_DIM}; box-shadow: 0 2px 8px rgba(0,0,0,.5);
        }
        /* One-shot highlight blink, fired when a curator ignore-queue job finishes. */
        @keyframes ilap-launcher-pulse {
            0%   { border-color: ${SPARED_DIM}; box-shadow: 0 2px 8px rgba(0,0,0,.5); }
            35%  { border-color: ${SPARED}; box-shadow: 0 0 0 3px rgba(69,161,250,.55), 0 2px 12px rgba(0,0,0,.6); }
            100% { border-color: ${SPARED_DIM}; box-shadow: 0 2px 8px rgba(0,0,0,.5); }
        }
        .ilap-launcher.pulse { animation: ilap-launcher-pulse .9s ease-in-out 1; }
        .ilap-launcher img { width: 26px; height: 26px; border-radius: 5px; display: block; pointer-events: none; }
        .ilap-panel { display: none; position: absolute; top: ${ICON + 8}px; right: 0; }
        .ilap-panel.open { display: block; }
        /* 1px Spared-coloured outline + smoothed corners on the panel itself.
           The toolbar popup gets scrolling from the browser for free; here the
           panel must cap itself to the viewport (host top + panel offset +
           bottom margin) and scroll, or on short screens (≤~768px with the
           settings accordion open) its lower part would be unreachable. */
        .ilap-panel #popup-root {
            outline: none; border: 1px solid ${SPARED}; border-radius: 10px;
            max-height: calc(100vh - ${TOP + ICON + 8 + 12}px); overflow-y: auto;
        }
    `;

    const t = (k, p) => (window.ILAP && window.ILAP.t) ? window.ILAP.t(k, p) : k;

    // Build the shadow host + all its elements (no behaviour). Returns the element
    // bag the controllers below wire up. Kept as pure construction so mount() reads
    // as assembly, not a 300-line god-closure.
    function buildDom() {
        const host = document.createElement('div');
        host.id = 'ilap-widget-host';
        Object.assign(host.style, {
            position: 'fixed',
            top: TOP + 'px',
            right: '12px',
            width: ICON + 'px',
            height: ICON + 'px',
            zIndex: '2147483000'
        });

        const shadow = host.attachShadow({ mode: 'open' });

        const sheet = document.createElement('link');
        sheet.rel = 'stylesheet';
        sheet.href = chrome.runtime.getURL('ui/popup.css');
        shadow.appendChild(sheet);

        const style = document.createElement('style');
        style.textContent = LAUNCHER_CSS;
        shadow.appendChild(style);

        const launcher = document.createElement('button');
        launcher.type = 'button';
        launcher.className = 'ilap-launcher';
        launcher.setAttribute('aria-label', 'Steam Ignore Like A Pro');
        launcher.innerHTML = `<img src="${chrome.runtime.getURL('assets/icons/icon48.png')}" alt="">`;
        shadow.appendChild(launcher);

        const chevron = document.createElement('button');
        chevron.type = 'button';
        chevron.className = 'ilap-chevron';
        chevron.setAttribute('aria-label', 'Show Steam Ignore Like A Pro');
        // Double chevron in the logo's colours: ribbon-red trailing, dice-white leading.
        chevron.innerHTML = '<svg width="9" height="11" viewBox="0 0 9 11">'
            + `<path d="M1 1 L4.4 5.5 L1 10" fill="none" stroke="${LOGO_RED}"`
            + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
            + `<path d="M4.6 1 L8 5.5 L4.6 10" fill="none" stroke="${LOGO_WHITE}"`
            + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        shadow.appendChild(chevron);

        const chevronTip = document.createElement('div');
        chevronTip.className = 'ilap-ghost-tip';
        shadow.appendChild(chevronTip);

        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'ilap-pin';
        pin.setAttribute('aria-label', 'Pin');
        pin.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">'
            + '<path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5'
            + 'c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';
        shadow.appendChild(pin);

        const panel = document.createElement('div');
        panel.className = 'ilap-panel';
        panel.innerHTML = window.ILAP_PopupMarkup;
        shadow.appendChild(panel);

        return { host, shadow, launcher, chevron, chevronTip, pin, panel };
    }

    // The collapsed/expanded launcher over STATE_KEY (see top of file). Owns `ts`,
    // the idle timer and the panel open/close (setOpen writes STATE_KEY on close, so
    // the panel belongs with this state). Reads the cross-cutting ghost/pinned flags
    // through ctx, and drives the shared "stashed" look of launcher + pin + chevron.
    function createCollapse(ctx, initialTs) {
        const { host, shadow, launcher, chevron, chevronTip, pin, panel } = ctx.els;
        let ts = initialTs; // 0 = collapsed, >0 = last-activity timestamp
        let idleTimer = null;
        let inited = false;

        function onIdle() {
            if (ctx.isGhost() || !ts) return;
            if (Date.now() - ts < IDLE_MS) { applyState(); return; } // bumped meanwhile — re-arm
            // A pinned launcher or an open panel never idles out — re-bump instead.
            if (ctx.isPinned() || panel.classList.contains('open')) { writeState(Date.now()); return; }
            writeState(0);
        }
        const writeState = (v) => {
            ts = v;
            applyState();
            chrome.storage.local.set({ [STATE_KEY]: v });
        };
        const applyState = () => {
            clearTimeout(idleTimer);
            if (ctx.isGhost()) {
                // Parked: force the stashed look, keep the panel closed, and never
                // arm the idle machinery (ts stays a passive mirror).
                launcher.classList.add('stashed');
                pin.classList.add('stashed');
                chevron.classList.add('shown');
                if (panel.classList.contains('open')) setOpen(false);
                return;
            }
            const collapsed = !ts;
            launcher.classList.toggle('stashed', collapsed);
            pin.classList.toggle('stashed', collapsed);
            chevron.classList.toggle('shown', collapsed);
            if (!collapsed) ctx.surface.clearRestore(); // expanding cancels the welcome-back outline (and its timer)
            if (collapsed && panel.classList.contains('open')) setOpen(false);
            // A pinned launcher stays out, so don't even arm the idle timer — otherwise
            // every open tab re-bumps the shared timestamp once a minute forever (a
            // storage-write + onChanged fan-out cycle). Re-armed when the pin is released
            // (pin click → writeState, or a cross-tab PIN_KEY change → applyState).
            if (!collapsed && !ctx.isPinned()) idleTimer = setTimeout(onIdle, Math.max(ts + IDLE_MS - Date.now(), 0) + 50);
        };
        const setOpen = (open) => {
            panel.classList.toggle('open', open);
            launcher.classList.toggle('active', open); // keep the hover-style highlight while open
            if (open && !inited) {
                inited = true;
                window.ILAP_Popup.init(shadow);
            }
            if (!open && ts && !ctx.isGhost()) writeState(Date.now()); // panel closed → restart the idle minute
        };
        // Any click inside the widget is activity (capture phase catches the
        // launcher and everything in the panel; throttled here).
        const bump = () => {
            if (!ctx.isGhost() && ts && Date.now() - ts >= ACTIVITY_THROTTLE_MS) writeState(Date.now());
        };
        shadow.addEventListener('click', bump, true);
        chevron.addEventListener('click', (e) => {
            e.stopPropagation();
            if (ctx.isGhost()) return; // the ghost beacon is informational only
            writeState(Date.now()); // slide the launcher out
        });
        // Collapse when clicking elsewhere on the page. Clicks inside the shadow are
        // retargeted to the host, so host.contains(target) stays true for them.
        // Capture phase so it still fires when another extension control (e.g. the
        // curator "Add to ignore queue" button) calls stopPropagation in the bubble phase.
        document.addEventListener('click', (e) => {
            if (panel.classList.contains('open') && !host.contains(e.target)) setOpen(false);
        }, true);

        return {
            applyState, setOpen, writeState,
            isOpen: () => panel.classList.contains('open'),
            isCollapsed: () => !ts,
            reset: () => { ts = 0; applyState(); }, // land collapsed (used by the surface restore)
            // Initial "stashed" look, set before the host enters the DOM (no flash).
            applyInitial: () => {
                const collapsed = ctx.isGhost() || !ts;
                launcher.classList.toggle('stashed', collapsed);
                pin.classList.toggle('stashed', collapsed);
                chevron.classList.toggle('shown', collapsed);
            },
            // STATE_KEY changed in another tab.
            mirror: (v) => {
                if (v === ts) return; // echo of our own write
                if (ctx.isGhost()) { ts = v; return; } // parked — mirror only, visuals stay ghost
                if (!v && (ctx.isPinned() || panel.classList.contains('open'))) {
                    // An idle sibling collapsed us while our panel is in use (or we're
                    // pinned) — re-assert expanded (the sibling just follows, no ping-pong).
                    writeState(Date.now());
                    return;
                }
                ts = v;
                applyState();
            }
        };
    }

    // The pin badge over PIN_KEY: pressed = the launcher stays out (the collapse
    // controller reads isPinned() to skip the idle stash). Toggling is activity, so
    // it writes STATE_KEY; a cross-tab change re-arms/cancels the idle timer.
    function createPin(ctx, initialPinned) {
        const { pin } = ctx.els;
        ctx._pinned = !!initialPinned;
        const applyPin = () => {
            pin.classList.toggle('pinned', ctx._pinned);
            pin.setAttribute('aria-pressed', String(ctx._pinned));
        };
        // The tooltip hints the action the pin offers, so it only shows while the pin
        // is inactive (pressed = already pinned, no hint needed).
        const applyPinTitle = () => {
            if (ctx._pinned) pin.removeAttribute('title');
            else pin.title = t('widget_pin');
        };
        // Master off greys the pin and makes it inert (pointer-events:none in CSS,
        // plus this guard so a synthetic/forced click can't sneak a toggle through).
        const applyMaster = () => pin.classList.toggle('disabled', !ctx._masterOn);
        pin.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!ctx._masterOn) return; // inert while the extension is disabled
            ctx._pinned = !ctx._pinned;
            applyPin();
            applyPinTitle();
            chrome.storage.local.set({ [PIN_KEY]: ctx._pinned });
            ctx.collapse.writeState(Date.now()); // toggling is activity; an unpin restarts the idle minute
        });
        pin.addEventListener('mouseenter', applyPinTitle); // locale loads async — refresh at hover time
        return {
            applyInitial: () => { applyPin(); applyPinTitle(); applyMaster(); },
            // MASTER_KEY changed (panel toggle or another tab) — re-gate the pin.
            mirrorMaster: (on) => { ctx._masterOn = on; applyMaster(); },
            mirror: (newVal) => {
                ctx._pinned = !!newVal;
                applyPin();
                applyPinTitle();
                ctx.collapse.applyState(); // re-arm on a sibling unpin, or cancel on a sibling pin
            }
        };
    }

    // The surface parking over Surface.KEY: popup mode parks the widget to a barely
    // visible ghost chevron; the escape hotkey / a live flip brings it back. Owns the
    // ghost flag, the chevron tooltip, and the "welcome back" restore highlight.
    function createSurface(ctx) {
        const { chevron, chevronTip } = ctx.els;
        let restoreTimer = null, goldTimer = null; // gold pulse → blue → fade
        let tipTimer = null;

        const ghostHint = () => t('surface_ghost_hint', { keys: ctx.Surface.ESCAPE_HOTKEY_LABEL });
        // The chevron never uses a native browser title — it shows our own tooltip
        // box: the parked-ghost "how to get the widget back" hint appears immediately,
        // the passive "expand" hint after a short hover-intent delay.
        const applyChevronTip = () => {
            chevronTip.textContent = ctx.isGhost() ? ghostHint() : t('widget_expand');
            chevronTip.classList.toggle('expand', !ctx.isGhost());
        };
        const clearRestore = () => {
            clearTimeout(restoreTimer); clearTimeout(goldTimer);
            chevron.classList.remove('restored', 'gold');
        };
        chevron.addEventListener('mouseenter', () => {
            applyChevronTip(); // locale loads async — refresh at hover time
            clearTimeout(tipTimer);
            if (ctx.isGhost()) chevronTip.classList.add('shown');
            else tipTimer = setTimeout(() => chevronTip.classList.add('shown'), 1000);
        });
        chevron.addEventListener('mouseleave', () => {
            clearTimeout(tipTimer);
            chevronTip.classList.remove('shown');
        });
        // Escape hatch: popup mode with an unreachable popup (e.g. the profile
        // migrated into the Steam client) would otherwise be a lock-in — this rare
        // hotkey flips the surface back to the widget from any store page.
        document.addEventListener('keydown', (e) => {
            if (!ctx.isGhost() || !ctx.Surface.isEscapeHotkey(e)) return;
            chrome.storage.local.set({ [ctx.Surface.KEY]: 'widget' });
        }, true);

        const applySurface = (mode) => {
            const g = (mode === 'popup');
            if (g === ctx._ghost) return;
            ctx._ghost = g;
            chevron.classList.toggle('ghost', ctx._ghost);
            if (!ctx._ghost) chevronTip.classList.remove('shown');
            applyChevronTip();
            clearRestore();
            if (ctx._ghost) {
                ctx.collapse.applyState(); // park to the ghost beacon
            } else {
                // Coming back from the parked popup surface: ALWAYS land on the
                // collapsed chevron, regardless of the pre-park expanded/pinned state
                // (local-only — every open tab collapses itself off the same surface-key
                // change; nothing is written to STATE_KEY so there's no cross-tab
                // ping-pong with the pinned re-assert branch). Then flag the chevron with
                // the gold-halo → blue welcome-back highlight.
                ctx.collapse.reset();
                chevron.classList.add('restored', 'gold');
                goldTimer = setTimeout(() => chevron.classList.remove('gold'), 3000); // gold halo → steady blue
                restoreTimer = setTimeout(() => chevron.classList.remove('restored'), 10000); // then fade out
            }
        };
        return {
            applySurface, clearRestore,
            applyInitial: () => {
                chevron.classList.toggle('ghost', ctx.isGhost());
                applyChevronTip();
            }
        };
    }

    // The logged-out lock. Queue/settings management makes no sense without a Steam
    // session, so the whole surface is gated: greyed launcher with a "sign in"
    // tooltip, panel not openable. Initial state comes from the page header; a click
    // while locked re-probes the LIVE cookies, because a page opened before the user
    // signed in (in another tab) still reads logged-out in its own DOM.
    function createLoginGate(ctx) {
        const { launcher, pin } = ctx.els;
        const Auth = window.ILAP.SteamAuth;
        let locked = false, probing = false, lastProbe = 0;
        const setLocked = (v) => {
            locked = v;
            launcher.classList.toggle('locked', v);
            pin.classList.toggle('locked', v);
            if (v) launcher.title = t('widget_login_required');
            else launcher.removeAttribute('title');
        };
        launcher.addEventListener('mouseenter', () => {
            if (locked) launcher.title = t('widget_login_required'); // locale loads async
        });
        launcher.addEventListener('click', (e) => {
            e.stopPropagation();
            if (locked) {
                const now = Date.now();
                if (probing || now - lastProbe < 3000) return;
                probing = true;
                lastProbe = now;
                Auth.probeLogin().then((ok) => {
                    probing = false;
                    if (ok) { setLocked(false); ctx.collapse.setOpen(true); }
                });
                return;
            }
            ctx.collapse.setOpen(!ctx.collapse.isOpen());
        });

        const domState = Auth.isLoggedInDom();
        if (domState === false) {
            setLocked(true);
        } else if (domState === null) {
            // No store header to read (e.g. a stripped surface) — lock until a live
            // probe settles the real state.
            setLocked(true);
            Auth.probeLogin().then((ok) => { if (ok) setLocked(false); });
        }
    }

    // Assemble the widget: build the DOM, wire the four single-concern controllers
    // over a shared ctx (each owns one storage key), then a single onChanged
    // dispatcher routes each changed key to its controller.
    function mount(initialTs, initialPinned, initialMode, initialMaster) {
        const els = buildDom();
        const ctx = {
            els,
            Surface: window.ILAP.Surface,
            _ghost: (initialMode === 'popup'),
            _pinned: !!initialPinned,
            _masterOn: initialMaster !== false,
            isGhost() { return this._ghost; },
            isPinned() { return this._pinned; }
        };

        ctx.collapse = createCollapse(ctx, initialTs);
        ctx.pin = createPin(ctx, initialPinned);
        ctx.surface = createSurface(ctx);

        // Initial visuals before the host enters the DOM → no transition flash.
        ctx.collapse.applyInitial();
        ctx.pin.applyInitial();
        ctx.surface.applyInitial();

        document.body.appendChild(els.host);

        createLoginGate(ctx);

        // Blink once whenever a curator queue job finishes — on whichever control is
        // visible (launcher, or the chevron while stashed). The drainer writes
        // ilap_curator_pulse on completion; onChanged fires in every tab.
        const { launcher, chevron } = els;
        launcher.addEventListener('animationend', () => launcher.classList.remove('pulse'));
        chevron.addEventListener('animationend', () => chevron.classList.remove('pulse'));
        const blink = () => {
            const el = ctx.collapse.isCollapsed() ? chevron : launcher;
            el.classList.remove('pulse');
            void el.offsetWidth; // reflow so re-adding restarts the animation
            el.classList.add('pulse');
        };

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area && area !== 'local') return;
            if (changes.ilap_curator_pulse) blink();
            if (changes[MASTER_KEY]) ctx.pin.mirrorMaster(changes[MASTER_KEY].newValue !== false);
            if (changes[PIN_KEY]) ctx.pin.mirror(changes[PIN_KEY].newValue);
            if (changes[ctx.Surface.KEY]) {
                ctx.surface.applySurface(ctx.Surface.resolve(changes[ctx.Surface.KEY].newValue, navigator.userAgent));
            }
            if (changes[STATE_KEY]) ctx.collapse.mirror(changes[STATE_KEY].newValue || 0);
        });

        ctx.collapse.applyState(); // arm the idle timer if we mounted expanded
    }

    function boot() {
        const Surface = window.ILAP.Surface;
        chrome.storage.local.get({ [STATE_KEY]: 0, [PIN_KEY]: false, [Surface.KEY]: 'widget', [MASTER_KEY]: true }, (data) => {
            const v = data[STATE_KEY] || 0;
            const pinned = !!data[PIN_KEY];
            const mode = Surface.resolve(data[Surface.KEY], navigator.userAgent);
            // A stale timestamp (browser closed while expanded) reads as collapsed —
            // unless pinned, which keeps the launcher out regardless of age.
            mount(pinned ? (v || Date.now()) : (Date.now() - v < IDLE_MS ? v : 0), pinned, mode, data[MASTER_KEY] !== false);
        });
    }

    if (document.body) {
        boot();
    } else {
        document.addEventListener('DOMContentLoaded', boot);
    }
})();
