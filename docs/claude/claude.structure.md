# Directory Structure & Script Load Order

## Directory Structure

```
Steam-Ignore-Like-a-Pro/
├── platform/
│   ├── chromium/manifest.json   # MV3 manifest for Chrome/Edge
│   └── firefox/manifest.json    # MV3 manifest for Firefox
├── src/
│   ├── escape.js                # window.ILAP.Sanitizer.escapeHTML: single HTML-escaper, loaded FIRST in both worlds (content_scripts AND popup.html, which does not load utils.js)
│   ├── utils.js                 # Shared infrastructure (loaded first after escape.js)
│   ├── gate.js                  # window.ILAP.IgnoreGate: aggregate ignore-POST rate governor (reserve() a slot before every ignore across drainer/EQ/DQ; ilap_ignore_gate min-gap+jitter; master + dead-session stop) — closes audit #1/#2
│   ├── surface.js               # window.ILAP.Surface: ilap_surface_mode helper (widget|popup mode, Steam-client UA detect, Ctrl+Alt+Shift+I escape-hotkey) — pure, loaded in content scripts AND popup.html
│   ├── migrate.js               # The ONLY background context (MV3 service worker in chromium / event-page script in firefox; NOT in the --test build, which swaps in the empty background-test.js). Event-only: on chrome.runtime.onInstalled it picks the default ilap_surface_mode — a FRESH install persists 'widget' (+ arms the ilap_intro_glow chevron beacon); an UPDATE from the old popup-only build (key absent) is kept on 'popup' (+ arms the one-shot ilap_update_glow popup highlight). onStartup re-asserts 'widget' when the key is absent (a LOST onInstalled write would otherwise get mis-migrated to 'popup' by a later update) — delayed + yielding to a same-lifetime install/update event so it can't outrace the legacy popup migration. Never drains ignores (that still needs a live Steam page)
│   ├── manual-ignore/
│   │   ├── utils.js             # ConfigService, ContainerStrategyProvider, gesture detectors
│   │   ├── ui.js                # BadgeFactory, BadgeRenderer, DuplicateDetector
│   │   └── main.js              # App bootstrap + IgnoreManager
│   ├── discovery-queue/
│   │   ├── logic.js             # SlideScanner, DiscoveryQueueAutomator (reserves an IgnoreGate slot before each ignore click)
│   │   ├── ui.js                # Queue UI controls (+ showRefused: transient "cap reached" button message)
│   │   ├── registry.js          # window.ILAP.Discovery.Registry: cross-tab cap (2) on concurrent DQ automators (ilap_dq_active, heartbeated + TTL-reclaimed lease, like the curator lock)
│   │   └── main.js              # DiscoveryQueueController bootstrap (owns the registry gate: acquire on Start, heartbeat, release on stop)
│   ├── explore-queue/
│   │   ├── utils.js             # QueueContext, ReviewAnalyzer, DecisionEngine, NavigationGuard
│   │   ├── ui.js                # ActionUI (toast, visuals, badges)
│   │   ├── automator.js         # ExploreAutomator (state machine)
│   │   └── main.js              # DI wiring + MutationObserver bootstrap
│   ├── curator/
│   │   ├── filters.js           # window.ILAP_Filters: shared curator-page helpers (ignore-filter vocabulary + colours + curatorIdFromPath); self-contained, loaded in content_scripts AND popup.html
│   │   ├── enumerate.js         # Phase 2: results_html parser + paged ajax enumerator (pure + fetch)
│   │   ├── store.js             # Phase 2: retention cache (TTL/LRU), queue CRUD, per-job lease lock
│   │   ├── enqueue-service.js   # Phase 2: window.ILAP.Curator.EnqueueService — injectable stage()/resolve() headless orchestration + the droplist job actions togglePause()/remove() (store + enumerator injected; Node-unit-tested)
│   │   ├── main.js              # Phase 2: curator-page "Add to ignore queue" button + droplist (thin UI/wiring layer over EnqueueService); once a job is staged the droplist adds Pause/Resume + Remove rows (applet parity; open menu re-renders on every queue change, so windows can't diverge); login-gated (no button when logged out) + surface-gated (in popup mode the button stays in place but LOCKED — greyed `.ilap-locked` (pointer-events:none) + inline `.ilap-locked-tip` hover tooltip (`curator_locked_popup`, aria-describedby-linked) naming the Ctrl+Alt+Shift+I escape; the dropdown is forced shut and a pick is refused at click time, so a menu left open across a live surface flip can't stage)
│   │   └── drainer.js           # Phase 2: CuratorQueueDrainer — opportunistic content-script ignore drainer (no SW)
│   └── widget/
│       └── main.js              # On-page shadow-DOM widget host (popup surface); login-gated launcher; collapses to a chevron tab (default) with a shared 60 s idle auto-stash; hover-revealed pin badge disables the auto-stash (goes inert while the extension is master-disabled); parks to a ghost-chevron beacon in popup surface mode (Ctrl+Alt+Shift+I unparks)
├── ui/
│   ├── popup.html
│   ├── popup_markup.js          # Shared popup body markup (window.ILAP_PopupMarkup)
│   ├── popup_main.js            # Stats + history display
│   ├── popup_settings.js        # Settings UI
│   ├── popup_queue.js           # Curator ignore-queue applet (window.ILAP_Queue)
│   └── popup.css                # Popup styles (shadow widget + popup window)
├── styles/styles.css
├── build.js
└── tests/
    ├── auth.setup.spec.js       # Manual Steam login, saves cookies to ~/.playwright-states/steam.json (outside repo)
    ├── _extension.js            # Shared helpers: getExtensionId, storage read/write/clear, popupUrl
    ├── _search.js               # searchUrl(): a /search/ URL with a RANDOM common term per call (pool of ~20 game words). Used by every spec that just needs "a Steam search page" — MI swipe/click surfaces + widget host pages — so automation doesn't hammer one fixed URL (portal/action) and coverage spans different result layouts. Terms all return /app/ game rows, so pickFirstRow keeps working
    ├── cross-cutting/
    │   ├── history-cap.spec.js       # ilap_ignored_history capped at 20
    │   ├── i18n.unit.spec.js         # Node unit: DICT completeness/extras per locale, {n}/{type} placeholder integrity, t() fallback ladder, onLangChange subscriber contract (fires on effective change; a throwing subscriber doesn't block the rest)
    │   ├── surface.unit.spec.js      # Node unit: Surface.KEY/hotkey label, isSteamClientUA, resolve (popup only when stored AND not client), isEscapeHotkey
    │   ├── migrate.unit.spec.js      # Node unit: src/migrate.js onInstalled — install→'widget', update+absent key→'popup', present key untouched, lastError→no write, other reasons no-op; onStartup re-assert (absent key→'widget' no-glow, present key untouched, yields to a same-lifetime install/update event)
    │   └── sw-restart.spec.js        # Survives chrome.runtime.reload + page reload
    ├── explore-queue/
    │   ├── _helpers.js
    │   ├── start-prompt.spec.js      # Toast, mode badge, Close button
    │   ├── intent-and-reload.spec.js # ACTIVE persistence, reload regression, nav token
    │   ├── bad-mode-ignore.spec.js   # End-to-end: finds and ignores a Mixed/Negative game
    │   ├── disable.spec.js           # Disable button → ilap_q_master=false
    │   ├── fast-forward.spec.js      # FF intent set, no ignore API call
    │   ├── decision-matrix.spec.js   # DecisionEngine bad/all × SPARE/IGNORE/NO_REVIEWS
    │   ├── mode-live.spec.js         # Mode badge live-updates on ilap_q_mode change
    │   ├── badge-position.spec.js    # DOM: IGNORED/SPARED label + upper-right 2/3 plate + tooltip no-wrap (about:blank, no login)
    │   └── automator.unit.spec.js    # Node unit: processedSession marks an appid only on a landed ignore — gate stop / failed POST un-mark (retryable after re-enable)
    ├── discovery-queue/
    │   ├── ui.spec.js                # Panel injection, Start/Stop cycle, checkbox, modal close
    │   ├── master-off.spec.js        # ilap_q_master=false → panel not mounted / retracted
    │   ├── registry.unit.spec.js     # Node unit: cross-tab DQ cap — tryAcquire fills to CAP=2 then refuses, TTL reclaim, release
    │   └── automator.unit.spec.js    # Node unit: stop discipline — throw mid-_loop still stops (no zombie slot); Stop during confirm poll refuses the Next advance; confirm-fallback pacing (settle-first, ×2 backoff, ≤3 GETs)
    ├── manual-ignore/
    │   ├── _helpers.js
    │   ├── swipe-gesture.spec.js     # Right/left swipe, threshold, master toggle, dedup
    │   ├── shortcut-key.spec.js      # Ctrl+Click, dual shortcuts coexist
    │   ├── containers.spec.js        # ContainerStrategyProvider: search/storefront/React/tag/app detail + seasonal-sale hero capsule (.hero_capsule: empty overlay anchor, art is a sibling img → Wrapper strategy, hero badge; skips outside sales)
    │   ├── persistence.spec.js       # Reload restores badge from ilap_session_map_v2
    │   └── popup-history.spec.js     # Stats reach popup; source label per reason
    ├── popup/
    │   ├── popup-main.spec.js        # Master toggle, counters, history, XSS, live update
    │   ├── settings.spec.js          # Queue toggles, mode, shortcut selects, mutual exclusion
    │   ├── queue.spec.js             # Curator queue applet: hidden-when-empty, chip count, pause/remove, running indicator, colours, mutual exclusion
    │   ├── surface-stub.spec.js      # popup.html surface routing: widget mode → signpost stub (button guarded by empty-queue invariant); popup mode → full UI; live flip reloads
    │   └── lang-chip.spec.js         # Language-chip styled menu: chip click opens it (Settings untouched), pick persists ilap_lang, bar click toggles Settings + closes it
    ├── curator/
    │   ├── _helpers.js               # interceptIgnoreApi + routeUserdata stubs (no real ignores)
    │   ├── enumerate.unit.spec.js    # Node unit: parseResults / categorize / filterAppids / buildUrl / paged enumerate
    │   ├── store.unit.spec.js        # Node unit: evictCache (TTL+LRU), lockFree, isFresh + serialized queue RMW / cursor keys (chrome stub)
    │   ├── enqueue.spec.js           # Curator-page button (live): injection+logo, dropdown, stage job, Added state, switch-in-place, 3-job cap, droplist Pause/Resume+Remove actions, cross-window open-menu sync, logged-out no-inject, popup-mode no-inject + live surface flip
    │   ├── drainer.unit.spec.js      # Node unit: drainer lease discipline — dedupe-skip run heartbeats the lease; lease stolen during the gate wait stops before the POST; standby interval armed only while a job exists
    │   └── drain.spec.js             # Drainer E2E (stubbed): ignores un-ignored appids, dedupe-skips already-ignored, respects paused
    └── widget/
        ├── login-lock.spec.js        # Login gate: locked launcher when logged out; stale pre-login page unlocks via live probe on click
        ├── collapse.spec.js          # Chevron collapse: default-collapsed mount, chevron expand + persistence, cross-tab sync, idle auto-stash, open panel blocks collapse
        ├── pin.spec.js               # Pin badge: hover-revealed, pressed pin blocks idle stash + survives stale-timestamp mount, cross-tab unpin sync
        ├── master-off.spec.js        # Master gate: ilap_master_enabled=false leaves chevron/launcher/panel usable (re-enable from panel toggle) but the pin goes inert (.disabled), revived live on re-enable
        └── surface-mode.spec.js      # popup mode parks widget to ghost-chevron beacon (escape-hatch tooltip, inert click), live park/restore, Ctrl+Alt+Shift+I unpark (works even while disabled), panel settings toggle locked while curator jobs exist + change-handler queue re-check (race guard)
```

## Script Load Order (manifest content_scripts)

```
1.  src/escape.js               → window.ILAP.Sanitizer.escapeHTML (shared HTML-escaper; loaded FIRST, before utils.js; also first in popup.html)
2.  src/utils.js                → window.ILAP global + shared services
3.  src/gate.js                 → window.ILAP.IgnoreGate (aggregate ignore-rate governor; needs getSessionID from utils.js)
4.  src/surface.js              → window.ILAP.Surface (surface-mode helper: mode key, Steam-client UA detect, escape-hotkey)
5.  src/i18n.js                 → window.ILAP.t / window.ILAP.i18n (popup + on-page UI strings)
6.  src/manual-ignore/utils.js  → window.ILAP.ManualIgnore.*
7.  src/manual-ignore/ui.js
8.  src/manual-ignore/main.js
9.  src/discovery-queue/ui.js
10. src/discovery-queue/registry.js → window.ILAP.Discovery.Registry (concurrent-DQ cap lease)
11. src/discovery-queue/logic.js → window.ILAP.Discovery.*
12. src/discovery-queue/main.js
13. src/explore-queue/utils.js   → window.ILAP.Explore.*
14. src/explore-queue/ui.js
15. src/explore-queue/automator.js
16. src/explore-queue/main.js
17. src/curator/filters.js       → window.ILAP_Filters (shared filter vocabulary + curatorIdFromPath; self-contained, also in popup.html)
18. src/curator/enumerate.js     → window.ILAP.Curator.Enumerator (parser + paged ajax client)
19. src/curator/store.js         → window.ILAP.Curator.Store (cache + queue + lease lock)
20. src/curator/enqueue-service.js → window.ILAP.Curator.EnqueueService (injectable stage/resolve; built by main.js)
21. src/curator/main.js          → curator-page "Add to ignore queue" button (Phase 2; thin UI over EnqueueService; locked-greyed-in-place in popup surface mode)
22. src/curator/drainer.js       → window.ILAP.Curator.CuratorQueueDrainer + boot (reserves a gate slot before every POST)
23. ui/popup_markup.js           → window.ILAP_PopupMarkup
24. ui/popup_settings.js         → window.ILAP_Settings (+ wireExclusiveDetails)
25. ui/popup_queue.js            → window.ILAP_Queue (curator queue applet)
26. ui/popup_main.js             → window.ILAP_Popup.init
27. src/widget/main.js           → on-page shadow-DOM widget host (parks to a ghost-chevron beacon in popup surface mode)
28. styles/styles.css
```

> The Discovery Queue `ui.js` loads before `logic.js`; this works because the classes are only referenced after the window `load` event.
