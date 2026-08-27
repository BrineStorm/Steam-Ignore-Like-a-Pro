# Directory Structure & Script Load Order

## Directory Structure

```
Steam-Ignore-Like-a-Pro/
├── platform/
│   ├── chromium/manifest.json   # MV3 manifest for Chrome/Edge
│   └── firefox/manifest.json    # MV3 manifest for Firefox
├── src/
│   ├── escape.js                # window.ILAP.Sanitizer: the pure string-boundary helpers — escapeHTML (single HTML-escaper) + sanitizeName (storage-boundary name normalizer: strips <>, control chars → space, collapses whitespace, clamps to 120). ONE definition for ALL THREE worlds: loaded FIRST in content_scripts, first in popup.html and first in the SW's importScripts (neither of which loads utils.js), so the SW/log/curator copies that used to drift are gone
│   ├── steam-palette.js          # window.ILAP.SteamPalette: Steam's review-score palette, the ONE table both classifiers read (Explore Queue rows on the app page, Discovery Queue cards in the modal). Each band is a SET of shades, current first, the ones Steam painted before behind it — classification fails safe, so an older entry can only restore recognition after a rollback or a partial rollout, never invent one. It was two private copies until one drifted: Steam repainted Mixed in the modal, DQ kept comparing to the old shade, and Keep High Score silently ignored nothing for a whole release. isBad(colour) is what both classifiers call; current(band) is what the live guards assert against (the canary deliberately accepts ONLY current)
│   ├── stats.js                 # window.ILAP.StatsLogic: the Last-Ignored record's shape — the three key names (ilap_ignored_count / _history / _last_ignored_name), the 20-entry history cap, and increment/decrement/pushHistory/nextState, plus countState and uncountState: the count-only halves, ±1, for an ignore that must be COUNTED but not SHOWN (a drained curator ignore — no name to display, and a job-sized batch would flush the history) and for a confirmed rollback, which takes its ignore back out of the total and equally leaves the history alone (a rolled-back entry still happened; what is UNDOABLE is ignore-log.js's question, not this one). The decrement is floored at 0: a rollback of a game ignored before install has no increment of its own to take back. ONE definition for the TWO worlds that WRITE it: utils.js StatsManager (content script) and background.js's shims (the SW recording a drained MI job via saveStats, a drained curator one via bumpCount, a drained undo via dropCount). Both worlds run all three writers on ONE serialized chain — they read-modify-write the same counter, so a second chain would lose a step where they overlap. Pure; only the chrome.storage read-modify-write around it stays per-world. popup.html just reads those keys by name, so it does not load this
│   ├── steam-net.js             # window.ILAP.SteamNet: the shared Steam network READS — fetchWithTimeout (the 10 s deadline every Steam fetch goes through; optional per-call override, timer deliberately not cleared so the body read is covered too), fetchIgnoredAppsStrict (dynamicstore userdata → Set of ignored appids, null on any failure), probeLogin (/account/ redirect check) and probeLoginCached (the same probe behind ONE shared verdict cache — a confirmed session reused 60 s, a confirmed logout 10 s, a FAILED probe never cached, concurrent callers sharing the in-flight request; the two ignore-side gates ask through it, everything that needs a fresh answer keeps calling probeLogin), checkAppUnavailable (the appdetails success:false probe) and classifyRefusal (the verdict wrapper both drain hosts apply to a refused POST — marks a 400 as a permanent per-appid region lock so the drainer skips it in one attempt instead of burning MAX_FAILS, and, in the SW, before the halt counter sees it). ONE definition for the TWO worlds that talk to Steam: loaded after escape.js in content_scripts and second in the SW's importScripts; popup.html never fetches Steam, so the storage-plumbing duplication rule (store.js) does not apply here. The ignore/unignore POST is NOT here — it stays per-world on purpose (see the file's own header)
│   ├── toast.js                 # window.ILAP.showToast(html, duration): the shared bottom-right push card (.ilap-toast + its own <style>), used by the curator button and Manual Ignore's queue-full warning. EQ/DQ keep their own toasts — those are interactive surfaces, not one-shot cards
│   ├── utils.js                 # Shared infrastructure (loaded after escape.js + steam-net.js; re-exports Sanitizer.sanitizeName as window.ILAP.sanitizeName and the SteamNet reads as window.ILAP.fetchWithTimeout / .fetchIgnoredAppsStrict / .classifyRefusal / SteamAuth.probeLogin for its long-standing callers). Owns what is genuinely content-script-bound: the cookie session id, the ignore/unignore POST (one local post(fields) for both), the lenient fetchIgnoredApps policy wrapper, the DOM login header (SteamAuth: resolveLogin for the UI locks, and hasLiveSession — the ONE ignore-side gate the rate governor and the Manual-Ignore gestures both ask, header trusted only when signed-IN, else the cached probe, tri-state so 'signed out' stays tellable from 'couldn't ask'), StatsManager and the name-extraction strategies
│   ├── gate.js                  # window.ILAP.IgnoreGate: aggregate ignore-POST rate governor (reserve() a slot before every ignore across drainer/EQ/DQ; ilap_ignore_gate min-gap+jitter; master + dead-session stop, the latter via SteamAuth.hasLiveSession — NOT from the sessionid cookie, which anonymous visitors also have; stopVerdict is asked OUTSIDE the claim chain because it can cost a network round trip, and it reports 'offline' apart from 'no-session' because "could not ask" and "signed out" do not recover alike — only 'disabled' is a state the extension itself owns, which is the one the SW parks its retry alarm on) — closes audit #1/#2
│   ├── ignore-log.js            # window.ILAP.IgnoreLog: ilap_ignore_log — timestamped append log of every EXTENSION ignore {appid,name?,ts,source,curatorId?,undoneAt?} (cap 5000 FIFO), the undo feature's data source (Steam's rgIgnoredApps has no dates). Pure selectors (snapshotLastN/Since, undoableCount, reIgnoredAfter, lastUndoneForCurator) + serialized-RMW append/markUndone; self-contained, loaded in content_scripts AND popup.html
│   ├── undo-service.js          # window.ILAP.UndoService: injectable staging for undo jobs — a STATIC appid snapshot from the log (count or time scope) pushed into the shared curator queue as {type:'undo', curatorId:'undo'} (one at a time, same 3-job cap); the drainer branches on the type to POST remove=1
│   ├── surface.js               # window.ILAP.Surface: ilap_surface_mode helper (widget|popup mode, Steam-client UA detect, Ctrl+Alt+Shift+I escape-hotkey + per-platform label + shift-click mouse twin) — pure, loaded in content scripts AND popup.html
│   ├── background.js            # Chromium MV3 service-worker ENTRY (Phase 3; NOT in the --test build, which swaps in the empty background-test.js). Shims window→self, importScripts's escape.js + stats.js + steam-net.js + migrate.js + gate.js + ignore-log.js + curator/store.js + curator/drainer.js, then hosts a CuratorQueueDrainer that drains the queue with NO Steam tab open — it joins the existing lease/handoff protocol as just another drainer. SW-specific parts: sessionid from the ilap_sw_sid cache (mirrored into memory for the gate's sync read), its own ignore POST (the one Steam call that stays per-world — the reads come from steam-net.js) and its own storage RMW for stats (the record's shape comes from stats.js), a gate wrapper that refuses waits >20 s (the SW would die mid-sleep; a chrome.alarms alarm resumes at the penalty's end instead) and the ilap_sw_halt circuit breaker (2 consecutive failed POSTs — stale sid / missing Steam_Language — halt BEFORE the drainer's MAX_FAILS skip burns an appid; any store-page visit re-arms). One retry alarm ('ilap_sw_drain', ≥60 s) re-armed while drainable work remains, cleared when the queue empties, when the route is halted, or on a master-off stop — the only stop whose cure is a storage write this worker hears. Firefox: NOT used (unverified fetch behavior from an event page) — its background stays migrate.js only, the content-script drainer remains the FF path
│   ├── migrate.js               # Install/update surface migration (on Chromium loaded into the SW via background.js importScripts; on Firefox the sole event-page script; NOT in the --test build). Event-only: on chrome.runtime.onInstalled it picks the default ilap_surface_mode — a FRESH install persists 'widget' (+ arms the ilap_intro_glow chevron beacon); an UPDATE from the old popup-only build (key absent) is kept on 'popup' (+ arms the one-shot ilap_update_glow popup highlight). onStartup re-asserts 'widget' when the key is absent (a LOST onInstalled write would otherwise get mis-migrated to 'popup' by a later update) — delayed + yielding to a same-lifetime install/update event so it can't outrace the legacy popup migration
│   ├── manual-ignore/
│   │   ├── utils.js             # ConfigService, ContainerStrategyProvider, gesture detectors (SwipeGestureDetector + ZigzagTracker, the solo un-ignore gesture)
│   │   ├── ui.js                # BadgeFactory, BadgeRenderer, DuplicateDetector
│   │   └── main.js              # App bootstrap + IgnoreManager (both gestures are login-gated via SteamAuth.hasLiveSession, the same call the rate gate makes — a signed-in store header, else the cached live /account/ probe; NOT the sessionid cookie, which anonymous visitors also carry. The badge-right-click un-ignore binding is a delegated listener and checks the master toggle itself, like the gesture detector does for the other two)
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
│   │   ├── store.js             # Phase 2: retention cache (TTL/LRU), queue CRUD, per-job lease lock, miSourceLabel (the one reason→Last-Ignored-label map, read by BOTH drain hosts)
│   │   ├── enqueue-service.js   # Phase 2: window.ILAP.Curator.EnqueueService — injectable stage()/resolve() headless orchestration + the droplist job actions togglePause()/remove() (store + enumerator injected; Node-unit-tested)
│   │   ├── main.js              # Phase 2: curator-page "Add to ignore queue" button + droplist (thin UI/wiring layer over EnqueueService); once a job is staged the droplist adds Pause/Resume + Remove rows (applet parity; open menu re-renders on every queue change, so windows can't diverge); login-gated (no button when logged out). NOT surface-gated: since the SW drain the queue is stageable/manageable from either surface, so the old popup-mode lock (greyed button + escape-hotkey tooltip) is removed
│   │   └── drainer.js           # Phase 2/3: CuratorQueueDrainer — the ignore drainer class, hosted in every store tab (content-script boot at the bottom, which also caches ilap_sw_sid / clears ilap_sw_halt) AND in the Chromium SW (src/background.js, DI'd with SW deps). Also drains undo jobs (type:'undo'): remove=1 POSTs through the same gate/lease, INVERSE userdata dedupe (skip when already un-ignored), "last user intent wins" skip via IgnoreLog.reIgnoredAfter, marks rolled-back log entries undone; every confirmed curator ignore is appended to the undo log (appid-only)
│   └── widget/
│       └── main.js              # On-page shadow-DOM widget host (popup surface); login-gated launcher; collapses to a chevron tab (default) with a shared 60 s idle auto-stash; hover-revealed pin badge disables the auto-stash (goes inert while the extension is master-disabled); parks to a ghost-chevron beacon in popup surface mode (Ctrl+Alt+Shift+I unparks)
├── ui/
│   ├── popup.html
│   ├── popup_markup.js          # Shared popup body markup (window.ILAP_PopupMarkup)
│   ├── popup_main.js            # Stats + history display; bootstrapPopupWindow routes the popup window on ilap_surface_mode (popup mode → full UI; widget mode → signpost stub with an aggregate queue done/total progress line + the ilap_sw_halt hint — the one surface that reports progress with no Steam tab open). Its onChanged handler splits TWO render paths: a write touching only drain-frequency keys (the curator pulse / cursor / skipped / lock keys, the ignore log, the gate slot, the ignored total) re-renders the queue + undo applets and repaints the total by value, while anything else takes the full innerHTML rebuild. Any NEW key written once per ignore POST has to be classified there, or the heavy rebuild comes back at 1–3×/s for the length of a bulk drain
│   ├── popup_settings.js        # Settings UI
│   ├── popup_queue.js           # Curator ignore-queue applet (window.ILAP_Queue); renders undo jobs with a localized name and no filter line; shows the queue_sw_halt hint row while the SW route is halted (ilap_sw_halt)
│   ├── popup_undo.js            # Undo applet (window.ILAP_Undo): the ⟲ button left of the Last-Ignored chip + its droplist — preset chips (10/25/100) + a digits-only count input clamped to "of N" undoable, and a time row (X hours/days); stages via UndoService from either surface (the popup-mode lock died with the empty-queue invariant)
│   └── popup.css                # Popup styles (shadow widget + popup window)
├── styles/styles.css
├── build.js
└── tests/
    ├── auth.setup.spec.js       # Manual Steam login, saves cookies to ~/.playwright-states/steam.json (outside repo)
    ├── _extension.js            # Shared helpers: getExtensionId, storage read/write/clear, popupUrl
    ├── _steam-live.js           # Authenticated same-origin page helpers for the LIVE specs (userdata read, sessionid, ignore/un-ignore POST, userdata polling, pre-clean). Page-context only — a standalone request context reads dynamicstore anonymously
    ├── _search.js               # searchUrl(): a /search/ URL with a RANDOM common term per call (pool of ~20 game words). Used by every spec that just needs "a Steam search page" — MI swipe/click surfaces + widget host pages — so automation doesn't hammer one fixed URL (portal/action) and coverage spans different result layouts. Terms all return /app/ game rows, so pickFirstRow keeps working
    ├── cross-cutting/
    │   ├── history-cap.spec.js       # ilap_ignored_history capped at 20
    │   ├── i18n.unit.spec.js         # Node unit: DICT completeness/extras per locale, {n}/{type} placeholder integrity, t() fallback ladder, onLangChange subscriber contract (fires on effective change; a throwing subscriber doesn't block the rest)
    │   ├── gate.unit.spec.js         # Node unit: IgnoreGate — nextSlot pacing math, 429 penalty escalation/decay/Retry-After, reserve() STOP verdicts (master off, no sessionid, sessionid without a session, probe unreachable → 'offline'), SteamAuth delegation and its tri-state passthrough, serialized pacing, foreground yield, chain survives a throwing claim AND a throwing stop check
    │   ├── ignore-log.unit.spec.js   # Node unit: IgnoreLog pure selectors (snapshots, undoableCount, reIgnoredAfter, lastUndoneForCurator, cap trim) + serialized-RMW append/markUndone against an async chrome stub
    │   ├── surface.unit.spec.js      # Node unit: Surface.KEY/hotkey label, isSteamClientUA, resolve (popup only when stored AND not client), isEscapeHotkey
    │   ├── migrate.unit.spec.js      # Node unit: src/migrate.js onInstalled — install→'widget', update+absent key→'popup', present key untouched, lastError→no write, other reasons no-op; onStartup re-assert (absent key→'widget' no-glow, present key untouched, yields to a same-lifetime install/update event)
    │   ├── background.unit.spec.js   # Node unit: Phase-3 SW drain host (src/background.js) — the REAL gate/store/drainer/ignore-log/migrate modules loaded through a stubbed importScripts into a worker-shaped sandbox; drains a job from the sid cache (paced by the real gate, alarm cleared when done), no-sid → no POST, 2-consecutive-fail halt engages before an appid burns + fresh-sid revival, long 429 penalty → no slot claimed + alarm at the penalty end, alarm handler kicks a pass, live foreign lease respected; an unreachable login probe and a confirmed logout both KEEP the retry alarm (neither ends with a write this worker hears, and parking would strand the drain); only master-off parks it
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
    │   ├── logged-out.spec.js        # Signed out (cookies cleared, but Steam still sets a sessionid): a swipe badges/queues nothing, a planted job is never drained (the gate alone), and a page that loaded signed-out recovers on the next gesture once the session appears
    │   ├── solo-unignore.spec.js     # Solo un-ignore gesture E2E: zigzag → pending mark → remove=1 → badge gone; refusal keeps the badge and raises the card; unbadged capsule inert; binding 'off'; the hard-wired badge click — either button, no setting involved — fires even at 'off' but still obeys the master toggle; the shared bindings ('ctrlKey' click, a freed 'swipeLeft'); an unrecognised stored binding falls back to the default
    │   ├── bindings.unit.spec.js     # Node unit: which action a click/swipe/circle resolves to across the THREE selects — the shared vocabulary (ctrlKey click, freed swipeLeft, the circle carrying an ignore), 'off', gesture values never matching a click, the master toggle, the circle beating the swipe it also completes, and the precedence a hand-edited double binding falls back on (ignore wins, never the rollback)
    │   ├── zigzag.unit.spec.js       # Node unit: ZigzagTracker (solo un-ignore gesture) — a swipe and its release-jitter are NOT a zigzag, a too-short backtrack is not either, right-left / left-right and circles BOTH ways fire (X-only ⇒ CW and CCW are indistinguishable, asserted as a documented consequence)
    │   └── popup-history.spec.js     # Stats reach popup; source label per reason
    ├── popup/
    │   ├── popup-main.spec.js        # Master toggle, counters, history, XSS, live update
    │   ├── settings.spec.js          # Queue toggles, mode, shortcut selects, mutual exclusion across ALL THREE selects, which offer the SAME bindings (the circle included), the un-ignore select (default 'zigzag', writes ilap_unignore_key, labels 'off' as the hard-wired badge click, self-heals an unknown stored value back to the default, and carries the localized native-title hint naming the zigzag its circle-only label leaves out)
    │   ├── queue.spec.js             # Curator queue applet: hidden-when-empty, chip count, pause/remove, running indicator, colours, mutual exclusion
    │   ├── undo.spec.js              # Undo applet: droplist stages an undo job from popup mode (no surface lock), disabled-empty tooltip contract, undo-job row renders localized without a filter line, pause/remove round-trip
    │   ├── surface-stub.spec.js      # popup.html surface routing: widget mode → signpost stub (switch button free with a busy queue; aggregate done/total progress line + ilap_sw_halt hint, live-updating); popup mode → full UI; live flip reloads
    │   ├── tooltips.spec.js          # Our own (non-native) popup tooltips measured against the panel edges in EVERY shipped locale: undo tip (disabled + enabled) and the language-chip tip; chip carries no native title; the language list hides the tip
    │   └── lang-chip.spec.js         # Language-chip styled menu: chip click opens it (Settings untouched), pick persists ilap_lang, bar click toggles Settings + closes it
    ├── curator/
    │   ├── _helpers.js               # interceptIgnoreApi + routeUserdata stubs (no real ignores) + the queue/log readers both LIVE specs assert on
    │   ├── enumerate.unit.spec.js    # Node unit: parseResults / categorize / filterAppids / buildUrl / paged enumerate
    │   ├── store.unit.spec.js        # Node unit: evictCache (TTL+LRU), lockFree, isFresh + serialized queue RMW / cursor keys (chrome stub)
    │   ├── enqueue.spec.js           # Curator-page button (live): injection+logo, dropdown, stage job, Added state, switch-in-place, 3-job cap, droplist Pause/Resume+Remove actions, cross-window open-menu sync, logged-out no-inject, popup-mode staging works (not surface-gated)
    │   ├── drainer.unit.spec.js      # Node unit: drainer lease discipline — dedupe-skip run heartbeats the lease; lease stolen during the gate wait stops before the POST; standby interval armed only while a job exists (and standbyMs:0 disables it — the SW host); undo branch (inverse dedupe + remove=1 + markUndone, re-ignored-after-snapshot skip); curator ignores appended to the undo log; a MAX_FAILS drop leaves a durable `skipped:'failed'` log entry (and an undo drop leaves none); boot sid-cache block (change-only ilap_sw_sid writes, halt re-arm, logged-out no-op)
    │   ├── undo-service.unit.spec.js # Node unit: UndoService staging — snapshot semantics (unique newest-first, undone skipped, time window), added/empty/exists/full outcomes, one-undo-at-a-time
    │   ├── drain.spec.js             # Drainer E2E (stubbed): ignores un-ignored appids, dedupe-skips already-ignored, respects paused
    │   └── sw-live.spec.js           # Service worker E2E LIVE: loads dist/chromium (the SHIPPING build — every other suite runs a stub SW), drains a 2-appid job with no Steam tab open anywhere, asserts real ignores on the account + no halt + the ilap_sw_sid handoff. Un-ignores in a finally
    └── widget/
        ├── login-lock.spec.js        # Login gate: locked launcher when logged out; stale pre-login page unlocks via live probe on click
        ├── collapse.spec.js          # Chevron collapse: default-collapsed mount, chevron expand + persistence, cross-tab sync, idle auto-stash, open panel blocks collapse
        ├── pin.spec.js               # Pin badge: hover-revealed, pressed pin blocks idle stash + survives stale-timestamp mount, cross-tab unpin sync
        ├── master-off.spec.js        # Master gate: ilap_master_enabled=false leaves chevron/launcher/panel usable (re-enable from panel toggle) but the pin goes inert (.disabled), revived live on re-enable
        └── surface-mode.spec.js      # popup mode parks widget to ghost-chevron beacon (escape-hatch tooltip, inert click), live park/restore, Ctrl+Alt+Shift+I unpark (works even while disabled), panel settings toggle switches to popup even with curator jobs queued (invariant removed)
```

## Script Load Order (manifest content_scripts)

```
1.  src/escape.js               → window.ILAP.Sanitizer (shared escapeHTML + sanitizeName; loaded FIRST, before utils.js; also first in popup.html and in the SW's importScripts)
2.  src/steam-palette.js        → window.ILAP.SteamPalette (Steam's review-score palette as ONE table for both classifiers; bands are sets — current shade first, previous ones behind it. Before discovery-queue/logic.js and explore-queue/utils.js, which both read it at load time)
3.  src/stats.js                → window.ILAP.StatsLogic (Last-Ignored record shape: key names, 20-entry cap, increment/pushHistory/nextState, plus countState/uncountState — the count-only halves a drained curator ignore and a confirmed rollback write, since neither has a name and both come in job-sized batches; before utils.js, and in the SW's importScripts — the two worlds that WRITE the record. NOT in popup.html, which only reads those keys by name)
4.  src/steam-net.js            → window.ILAP.SteamNet (shared Steam network reads; before utils.js, which re-exports them; also in the SW's importScripts — NOT in popup.html, which never fetches Steam)
5.  src/utils.js                → window.ILAP global + shared services
6.  src/gate.js                 → window.ILAP.IgnoreGate (aggregate ignore-rate governor; its default session seam reads getSessionID + SteamAuth.hasLiveSession from utils.js, hence the order. The SW loads no utils.js and injects its own seam via IgnoreGate.configure())
7.  src/ignore-log.js           → window.ILAP.IgnoreLog (undo data source: timestamped ignore log; before every module that ignores)
8.  src/surface.js              → window.ILAP.Surface (surface-mode helper: mode key, Steam-client UA detect, escape-hotkey)
9.  src/i18n.js                 → window.ILAP.t / window.ILAP.i18n (popup + on-page UI strings)
10. src/toast.js                → window.ILAP.showToast (shared bottom-right push card: curator button + Manual Ignore)
11. src/manual-ignore/utils.js  → window.ILAP.ManualIgnore.*
12. src/manual-ignore/ui.js
13. src/manual-ignore/main.js
14. src/discovery-queue/ui.js
15. src/discovery-queue/registry.js → window.ILAP.Discovery.Registry (concurrent-DQ cap lease)
16. src/discovery-queue/logic.js → window.ILAP.Discovery.*
17. src/discovery-queue/main.js
18. src/explore-queue/utils.js  → window.ILAP.Explore.*
19. src/explore-queue/ui.js
20. src/explore-queue/automator.js
21. src/explore-queue/main.js
22. src/curator/filters.js      → window.ILAP_Filters (shared filter vocabulary + curatorIdFromPath; self-contained, also in popup.html)
23. src/curator/enumerate.js    → window.ILAP.Curator.Enumerator (parser + paged ajax client)
24. src/curator/store.js        → window.ILAP.Curator.Store (cache + queue + lease lock)
25. src/curator/enqueue-service.js → window.ILAP.Curator.EnqueueService (injectable stage/resolve; built by main.js)
26. src/curator/main.js         → curator-page "Add to ignore queue" button (Phase 2; thin UI over EnqueueService; NOT surface-gated — the old popup-mode lock died with the SW drain; soft re-stage warning row when this curator's ignores were undone <48 h ago)
27. src/curator/drainer.js      → window.ILAP.Curator.CuratorQueueDrainer + boot (asks the gate's stopVerdict before opening a pass, then reserves a slot before every POST; drains undo jobs via remove=1)
28. src/undo-service.js         → window.ILAP.UndoService (undo-job staging; needs Store + IgnoreLog)
29. ui/popup_markup.js          → window.ILAP_PopupMarkup
30. ui/popup_settings.js        → window.ILAP_Settings (+ wireExclusiveDetails)
31. ui/popup_queue.js           → window.ILAP_Queue (curator queue applet)
32. ui/popup_undo.js            → window.ILAP_Undo (undo button + droplist)
33. ui/popup_main.js            → window.ILAP_Popup.init
34. src/widget/main.js          → on-page shadow-DOM widget host (parks to a ghost-chevron beacon in popup surface mode)
35. styles/styles.css
```

> The Discovery Queue `ui.js` loads before `logic.js`; this works because the classes are only referenced after the window `load` event.
