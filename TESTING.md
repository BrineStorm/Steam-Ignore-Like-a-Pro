# Testing

Playwright E2E tests running against a live Steam session in a real Chromium instance with the extension loaded.  
Mostly end-to-end, validated against Steam's actual DOM; the pure-logic checks (`DecisionEngine`, `StatsLogic` history cap, `StatsManager` context guard, the i18n dictionary/`t()` contract, the `Surface` mode helper, the ignore-rate `IgnoreGate`, the curator enumerator/store/enqueue-service, and the SW drain host `src/background.js`) run as Node unit tests that load the class via `vm` with a stubbed `window`/`chrome`.

Many suites are **login-agnostic** — the popup, unit, and most on-page widget tests do not need a Steam session (they stub storage, intercept the ignore API, or never open the login-gated panel). A saved session is required for the suites that drive the real logged-in flow — Manual Ignore, Discovery Queue, Explore Queue, the live curator-page button, and the widget's logged-in panel tests; the login-gated ones `test.skip` themselves when no session is saved.

## Setup

```bash
npm install
npm run test:auth     # one-time: opens a browser, log in manually, saves session to ~/.playwright-states/steam.json (outside the repo)
```

Re-run `test:auth` whenever the saved session expires.

## Running tests

```bash
npm test              # build + run all suites
npm run test_mi       # Manual Ignore only
npm run test_dq       # Discovery Queue only
npm run test_eq       # Explore Queue only
npm run test_popup    # Popup UI only
npm run test_curator  # Curator ignore queue only
npm run test_widget   # On-page widget only
```

There is no per-suite script for the cross-cutting Node unit tests; run them directly, e.g. `npx playwright test tests/cross-cutting`.

All scripts run `node build.js --test` first, which produces `dist/chromium-test/` — a test-flavor build with a stub MV3 service worker. Playwright uses it to resolve the extension ID; `dist/chromium/` (production) is not touched.

## Firefox

```bash
npm run test:ff       # build + run the browser-driven suites under Firefox
```

The same store-page E2E suites also run under a **`firefox`** Playwright project. Firefox differs from Chromium in three ways that shape the harness (all in `tests/_firefox.js` / `tests/_extension.js`):

- **Loading the extension.** Playwright's Firefox has no `--load-extension`. `tests/_firefox.js` launches with `-start-debugger-server <port>`, speaks the Remote Debugging Protocol over TCP with a tiny hand-rolled client (no new dependency), and calls `installTemporaryAddon`. A fixed internal UUID is pinned via the `extensions.webextensions.uuids` pref written into the profile's `user.js` **before** launch (Playwright applies `firefoxUserPrefs` too late, after startup).
- **No SW handle, no navigable extension page.** Firefox exposes no extension service worker and **blocks navigating a tab to a `moz-extension://` page**. So there is no context to `page.evaluate` storage in. The test build (`dist/firefox-test/`) instead **drops the background entirely** and injects a test-only content script (`src/test-storage-bridge.js`) that relays `chrome.storage.local` to the page over `postMessage`; the helpers drive it from a `store.steampowered.com/about/` **bridge tab** kept open per context (warmed in the fixture so the first storage write isn't slowed).
- **Heavier + flakier.** The `firefox` project runs with `timeout: 60s` and `retries: 2` (headed Firefox launch + per-context add-on install + synthetic mouse timing flake under a long run's CPU contention). The gesture-heavy Manual-Ignore swipe/Ctrl+Click tests are the flakiest — solid in isolation, they intermittently miss under a full run's load (Firefox also fires `contextmenu` at mouse-down, mid-gesture); the retries absorb the streaks.

Because a `moz-extension://` popup page can't be opened, the whole **`tests/popup/`** suite and `manual-ignore/popup-history` are Chromium-only (the same popup UI is exercised on-page by the widget suite). The Node unit specs already run in the chromium project, so they're excluded from firefox too.

**Known Firefox gaps / exclusions** (all others pass):
- `manual-ignore/tag-page.spec.js` boot-render tests are `test.skip`ped on Firefox — a confirmed bug: `IgnoreManager.refreshAll()` paints **no** badges on `/tags/` from the session map under Firefox (Chromium badges them; a live ignore badges fine on Firefox too, so the `:231` persistence test stays enabled). Deferred for a content-script fix.
- `manual-ignore/swipe-gesture.spec.js` "suppresses the native context menu" is skipped on Firefox — under Playwright's synthetic mouse, Firefox emits `contextmenu` at mouse-down (before the swipe is recognised on mouse-up), so the spy reads `defaultPrevented=false`; no real OS menu opens (verified), so it's a synthetic-event timing artifact.
- `discovery-queue/ui.spec.js` panel-injection tests are **flaky** on Firefox — injecting `#ilap-queue-controls` into Steam's React-rendered queue modal races (mostly green with the one retry; likely the same MutationObserver-on-React-subtree reliability as the `/tags/` gap above).

## Test account cleanup (automatic)

Some suites ignore **real** games on the test account: Explore Queue `bad-mode-ignore` (1 game, via the ignore API) and Discovery Queue test #6 (~12 games, via live UI clicks). To keep the account clean, every `npx playwright test` run wraps itself in a snapshot-and-diff cleanup:

- `globalSetup` (`tests/global-setup.js`) snapshots the account's currently-ignored appids — read from `store.steampowered.com/dynamicstore/userdata/` → `rgIgnoredApps` — to `~/.playwright-states/ignored-before.json`.
- `globalTeardown` (`tests/global-teardown.js`) re-reads userdata, computes `diff = after \ before`, and un-ignores **exactly** that diff (the games the run added), then verifies via a fresh read.

This runs on **every** invocation (full `npm test` or any single-module script) as a self-contained snapshot→diff cycle. Suites that intercept the ignore API with `context.route` (Manual Ignore, EQ fast-forward) make no real change, so they never appear in the diff and nothing is removed for them.

Safety (`tests/_cleanup.js`): removes strictly the diff — never the user's pre-existing ignores; `MAX_CLEANUP=200` cap refuses an implausibly large diff; logged-in guard (`ownedCount>0`) skips cleanup if the session is stale at setup or teardown. Un-ignore reuses the ignore endpoint with `remove=1`.

## Test suites

### Manual Ignore (`tests/manual-ignore/`)

**Important:** Manual Ignore calls Steam's ignore API directly. Every test intercepts `POST /recommended/ignorerecommendation/` with `context.route` and fulfills a fake `{success:1}`, so no real account changes happen. (The earlier `window.ILAP.apiIgnoreGame` stub didn't work — content scripts live in the isolated world, invisible to `page.evaluate`; route interception is world-independent and guarantees no real ignore.)

| File | What it covers |
|---|---|
| `swipe-gesture.spec.js` | Right swipe → reason 0 (default ignore); Left swipe → reason 2 (Already Played); short swipe no-op; master toggle off; gesture isolation (each swipe direction maps to exactly one reason); context menu suppression after gesture; dedup. |
| `containers.spec.js` | Badge renders with the right variant across strategy branches: search results (Fallback, grid), homepage featured carousel (Wrapper, hero), homepage spotlight (Direct Image, hero), New & Trending tab rows + sale capsules (Fallback, grid), tag browse (any variant, appid-tagged). |
| `shortcut-key.spec.js` | Switch default binding to `ctrlKey`: Ctrl+Click fires, right swipe no longer does. Two click-based shortcuts coexist with distinct reasons. |
| `popup-history.spec.js` | After ignore: `ilap_ignored_count`, `ilap_last_ignored_name`, `ilap_ignored_history` land in storage. Popup shows the game name under *Last Ignored*; hover on the trigger reveals the history dropdown with the correct entry and source label. |
| `persistence.spec.js` | Ignore a game → reload the page → badge re-renders from `ilap_session_map_v2` (session storage) with no second API call. |
| `tag-page.spec.js` | On a `/tags/<lang>/<Tag>` sale page, the content script resolves a container and badges each distinct capsule block (hover-capsule strip, bottom sale grid) by seeding the session map. |

### Discovery Queue (`tests/discovery-queue/`)

| File | What it covers |
|---|---|
| `ui.spec.js` | Panel injects into the queue modal; Start activates loop (running class); Stop returns to idle; Keep High Score checkbox toggles; panel unmounts on modal close; **test #6** — Start ignores ~12 real games across a queue boundary (`Continue`), Stop → idle. |
| `master-off.spec.js` | `ilap_q_master=false` keeps the panel out of the modal; flipping it to false while the modal is open retracts the panel. |
| `registry.unit.spec.js` | **Unit** — `Discovery.Registry` concurrent-DQ cap: `activeCount`/`prune` pure helpers; `tryAcquire` fills to `CAP`=2 then refuses a new owner (renews an existing one), reclaims expired slots, `release` frees. |
| `automator.unit.spec.js` | **Unit** — automator stop discipline: a throw mid-`_loop` iteration still lands in `stop()` (no zombie `isRunning`/registry slot, warned not silent); a Stop landing during the confirm poll refuses the Next advance (the confirmed ignore is still counted). Plus userdata confirm-fallback pacing: settle delay before the FIRST read, doubling backoff per miss (600→1200→2400 ms), hard cap of 3 GETs per unconfirmed ignore. |
| `ui.spec.js` (cap test) | Two seeded live `ilap_dq_active` slots fill the cap → Start is refused (flashes "max {n}" message, never enters running, no ignore), then auto-reverts to the idle Start button. |

DQ automator clicks Steam's own in-page Ignore button rather than calling `apiIgnoreGame` itself — but that click makes **Steam's own page JS fire `POST /recommended/ignorerecommendation`** (verified by a network capture during a live DQ run). So DQ is NOT request-free: it is an ignore-POST source like EQ and the curator drainer, just one our code doesn't originate. Test #6 deliberately ignores ~12 real games to exercise the queue-boundary `Continue` path; these are removed afterward by the automatic cleanup (see *Test account cleanup* above).

### Explore Queue (`tests/explore-queue/`)

| File | What it covers |
|---|---|
| `start-prompt.spec.js` | Toast appears with Run/FF/Disable buttons; mode badge defaults to *Bad Reviews*; Close hides toast without setting intent. |
| `bad-mode-ignore.spec.js` | Run in bad mode scans the queue until a Mixed/Negative game is found and ignored; verifies IGNORE micro-badge appears. |
| `intent-and-reload.spec.js` | Run sets `ACTIVE` + `ACTIVE_APPID` in session storage; reload in ACTIVE state shows no duplicate start prompt; sideways nav to a different appid without a nav token re-shows the prompt; manual Steam Next click while ACTIVE issues a nav token. |
| `fast-forward.spec.js` | Fast Forward sets the FF intent in session storage and makes **no** ignore API call (API intercepted via `context.route`). |
| `decision-matrix.spec.js` | **Unit** — `DecisionEngine.decide`: bad mode ignores only IGNORE (spares SPARE/NO_REVIEWS); all mode ignores everything; unknown mode falls back to bad. |
| `review-classify.unit.spec.js` | **Unit** — `ReviewAnalyzer.classify`: maps Steam review-summary colours to SPARE/IGNORE/NO_REVIEWS, with the fail-safe on an unknown colour (stop, don't act). |
| `automator.unit.spec.js` | **Unit** — `ExploreAutomator` session-marking: an appid stays in `processedSession` only when the ignore actually landed — a gate stop (no POST, toast torn down) or a failed POST un-marks it so the game is retryable after a re-enable; a rate-limited POST (429) additionally reports to the shared gate so every source backs off. |
| `mode-live.spec.js` | Mode badge live-updates when `ilap_q_mode` flips between *bad* and *all* in storage. |
| `disable.spec.js` | Disable button sets `ilap_q_master=false`, removes the toast, and prevents the prompt on reload. |
| `badge-position.spec.js` | **DOM-only** (`about:blank`, no login) — drives `ActionUI.applyVisuals`: IGNORED/SPARED plate label + upper-right ⅔ placement (`left:66%`), and the NO_REVIEWS tooltip criterion `white-space:nowrap` regression guard. |

EQ ignores via the ignore API (`apiIgnoreGame`), so `bad-mode-ignore` performs a **real** ignore on the account; it is removed afterward by the automatic cleanup (see *Test account cleanup* above). `fast-forward` intercepts the API with `context.route` and makes no real change.

### Popup (`tests/popup/`)

| File | What it covers |
|---|---|
| `popup-main.spec.js` | Master toggle persists to storage and dims UI; count/last-game reflect storage; history shows latest 3 entries; XSS escaping in history; live re-render on storage change. |
| `settings.spec.js` | Shortcut selectors persist; queue master toggle; mode toggle (bad vs all); mutual exclusion between default and platform selectors; the `#surface-toggle` segmented row (widget ↔ popup). |
| `language.spec.js` | Selecting a language writes `ilap_lang`, updates the chip code, and relabels the UI; stored `ilap_lang` is applied on open; change from another context re-renders live; switching with settings open relabels the settings panel. |
| `lang-chip.spec.js` | Language-chip focus-trap: clicking just left of a focused chip toggles Settings (the widened transparent `<select>` no longer hijacks the click and re-opens the language list). |
| `queue.spec.js` | Curator ignore-queue applet: hidden when empty; chip count; Pause/Resume + remove; running indicator derived from a live lease lock; per-status colours; cursor-key progress; surface mutual exclusion. |
| `undo.spec.js` | Undo applet: the ⟲ button is enabled in popup surface mode (the staging lock died with the empty-queue invariant) and the droplist stages a real undo job into the queue; disabled + "nothing to undo" tooltip on an empty log; a seeded `type:'undo'` job renders a localized row with no filter line and round-trips Pause/Remove through the applet. Snapshot semantics stay Node-unit-covered (`undo-service.unit.spec.js` + `ignore-log.unit.spec.js`). |
| `surface-stub.spec.js` | `popup.html` self-routing on `ilap_surface_mode`: widget mode → signpost stub — the "move interface here" button works with a busy queue (invariant removed; the queue rides along), plus the aggregate drain progress line (one `done / total` over ALL jobs — pendings included, curator and undo alike; hidden when idle, live-updates on queue/cursor writes) and the `ilap_sw_halt` hint (visible while set, clears live); popup mode → full UI; a live mode flip reloads. |

### Curator ignore queue (`tests/curator/`)

The bulk-ignore feature: an enumerate → stage → drain pipeline. Enumeration and the storage model are pure and Node-unit-tested; the curator-page button and the drainer run under Playwright with the ignore API intercepted (`interceptIgnoreApi` in `tests/curator/_helpers.js`) so **no real ignores** happen.

| File | What it covers |
|---|---|
| `enumerate.unit.spec.js` | **Unit** — `parseResults`/`categorize`/`filterAppids`/`buildUrl` and the paged ajax `enumerate` against the `results_html` string (appid + `.color_*` recommendation type, language-independent). |
| `store.unit.spec.js` | **Unit** — `evictCache` (TTL + LRU), `lockFree`/`isFresh` lease helpers, and serialized queue read-modify-write / cursor-key round-trips against an async `chrome.storage` stub (20 concurrent patches, update+remove); `setCursor` refuses for a job not in the queue, so a remove racing a resolve/drain can't leak the cursor key. |
| `enqueue-service.unit.spec.js` | **Unit** — `EnqueueService.stage()/resolve()` with injected store + enumerator (cache-vs-enumerate, cursor reset), the headless orchestration extracted out of the UI layer; plus the droplist job actions `togglePause()/remove()` (pause/resume flip, removeJob routing, null no-op when the job vanished from another window). |
| `drainer.unit.spec.js` | **Unit** — `CuratorQueueDrainer` lease discipline with injected store/gate/api: a pure dedupe-skip run still heartbeats the lease (no POSTs), a lease stolen during the gate wait stops before the POST with no cursor burn, a 429 (rate-limited) POST ends the pass without burning `fails`/cursor and forwards `Retry-After` to the shared gate, and the 9 s standby interval is armed only while the queue holds a job (disarmed on empty — no eternal tick in idle tabs). Timing races the E2E can't drive deterministically. Plus the 400-classification: a `res.unavailable` verdict (region-locked appid, no store object in the account's region) skips in ONE attempt — no `MAX_FAILS` burn — bumps the per-job skip counter and appends a `skipped:'unavailable'` log entry (an undo job skips silently: nothing was rolled back, so no log write/mark). Plus the undo branch: inverse dedupe (already-un-ignored appids skipped AND marked undone, so they can't inflate the undoable count), `remove=1` POSTs + `markUndone` per confirmed un-ignore, the "last user intent wins" skip (re-ignored after `snapshotTs` → no POST, no mark), curator ignores appended to the undo log, a failed strict userdata read stopping an undo pass instead of skip-burning the job, an EMPTY userdata set demanding a live login probe (dead session → stop, job intact; legit-empty → completes via marked skips), and the userdata-lag guard: an appid whose newest live log ts is within `UNDO_FRESH_MS` is un-ignored (`remove=1`, idempotent) instead of skip-marked even when absent from the set — a just-ignored game can't be stranded ignored with its log entry burned. Also the SW-host hooks: `standbyMs: 0` disables the standby interval (the SW retries via alarms), and the boot block's sessionid cache (`ilap_sw_sid` written change-only so a same-value write can't wake the SW for nothing, a halted route re-armed by a page visit, logged-out → untouched). |
| `undo-service.unit.spec.js` | **Unit** — `UndoService` staging with a stub store and the REAL `IgnoreLog` selectors: snapshot semantics (unique appids newest-first, undone entries skipped, time-window scope), clamp to what the log holds, and the `added`/`empty`/`exists` (one undo at a time)/`full` outcome branching. |
| `enqueue.spec.js` | Curator-page **button** (live): injection + logo, filter dropdown, stage a job, *Added* state, switch-in-place, 3-job cap; the post-add droplist job actions (Pause↔Resume round-trip, Remove → button back to add-state) and the cross-window open-menu sync (an OPEN droplist swaps add-/added-variant, flips to Resume, and drops the rows on external queue writes); logged-out → no inject; popup surface mode → the button works the same and stages (not surface-gated since the SW drain); live `ilap_lang` switch relabels the button in place (i18n `onLangChange`). |
| `drain.spec.js` | **Drainer** E2E (stubbed): ignores un-ignored appids, dedupe-skips already-ignored ones (via `dynamicstore/userdata/`), stops on a paused job; the rate gate paces consecutive POSTs ≥ floor apart; master-off stops the drainer without burning the cursor (audit #1). |
| `drain-live.spec.js` | **Drainer** E2E **LIVE** (real ignores, NO stubs — `npm run test_live`; skipped without a saved session and under Firefox). Validates the two empirical assumptions the unit tests can only postulate. **Region lock:** a real POST for Spacewar (`480`) 400s and is classified region-locked (`skipped:'unavailable'` in the log — reachable ONLY via the `status===400` + appdetails-`success:false` branch), while the appid queued behind it really ignores — the end-to-end proof of the 400-gate against live Steam. **Undo:** a freshly-ignored game (ignored + log-seeded directly, so setup doesn't ride the userdata-dedupe-flaky curator drainer) staged for undo is really un-ignored and its log entry marked `undoneAt` — the userdata-lag guard's user-visible contract (a just-ignored game is never stranded ignored with its log entry burned). Reads/POSTs run as same-origin page fetches (the only authenticated path — a standalone request context reads dynamicstore anonymously here); each test un-ignores its own appid in a finally. |

### On-page widget (`tests/widget/`)

The Shadow-DOM launcher that hosts the popup UI on Steam Store pages. Playwright's CSS selectors pierce the open shadow root, so `.ilap-*` and the panel's controls resolve straight through `#ilap-widget-host`. Most tests are **login-agnostic** (the panel is never opened and no ignore API is reachable); the few that open the login-gated panel `test.skip` without a saved session.

| File | What it covers |
|---|---|
| `login-lock.spec.js` | Login gate: logged-out launcher renders locked (grey + "sign in" tooltip), panel won't open; a page opened pre-login unlocks in place via a live cookie probe on click; logged-in launcher opens the panel. |
| `collapse.spec.js` | Chevron collapse: default-collapsed mount, chevron click slides the launcher out + persists, cross-tab state sync, 60 s idle auto-stash, an open panel blocks the collapse. |
| `pin.spec.js` | Pin badge: hidden by default, revealed by a launcher hold or a direct hover; a pressed pin blocks the idle stash and survives a stale-timestamp mount; cross-tab unpin sync. |
| `master-off.spec.js` | Master gate: `ilap_master_enabled=false` leaves the chevron/launcher/panel usable (re-enable from the panel's master toggle) but the pin goes inert (`.ilap-pin.disabled` — greyed + non-interactive), revived live on re-enable. |
| `surface-mode.spec.js` | Popup surface mode parks the widget to a ghost-chevron beacon (escape-hatch tooltip, inert click); live park/restore; **Ctrl+Alt+Shift+I** un-parks (works even while the extension is disabled); the panel's surface toggle switches to popup mode even while curator jobs exist (the empty-queue invariant is gone — the job rides along untouched). |

### Cross-cutting (`tests/cross-cutting/`)

These are **unit** tests (load the module via `vm` with a stubbed `window`/`chrome`, no browser) — the main-world `page.evaluate` can't reach `window.ILAP` in the isolated world, and these contracts are pure enough not to need one.

| File | What it covers |
|---|---|
| `history-cap.spec.js` | Driving `saveStats` 25× caps `ilap_ignored_history` at 20 (newest-first) while the count tracks all 25. |
| `sw-restart.spec.js` | `StatsManager.save` is a silent no-op when the extension context is invalidated (no `chrome.runtime.id`), and writes normally once it is valid again. |
| `i18n.unit.spec.js` | Per-locale dictionary completeness (every locale carries every `en` key, no extras), `{n}`/`{type}` placeholder integrity across translations, every picker language has a bundle, the `t()` locale→en→raw-key fallback ladder, and the `onLangChange` subscriber contract (fires only on an effective language change; a throwing subscriber doesn't block the rest). |
| `surface.unit.spec.js` | `Surface` helper: `KEY`/hotkey label, `isSteamClientUA`, `resolve` (popup only when stored **and** not the Steam client), `isEscapeHotkey`. |
| `gate.unit.spec.js` | `IgnoreGate` rate governor: `nextSlot` pacing math; `reserve()` STOPS (no slot) on master-off and on a missing sessionid; a granted reservation advances the shared slot monotonically by ≥ `MIN_GAP`. Plus the 429 backoff: `nextPenalty` escalation math (doubling while warm, decay reset, `Retry-After` honoured up to the cap, corrupt far-future penalty treated as absent), `reportRateLimited()` escalating the shared penalty, and `reserve()` folding an active penalty into the granted slot (waited out, not clamped). |
| `sanitize-name.unit.spec.js` | Game-name sanitization at the storage boundary (strips markup/control chars before a name is ever persisted). |
| `name-resolve.unit.spec.js` | `resolveGameName` async resolution: a DOM-extracted name wins without any fetch; a nameless capsule (bare `<a href="/app/ID?…"><img></a>` — no alt/title/slug, e.g. the front-page release-calendar carousel) falls back to the store's `appdetails` endpoint (sanitized); `success:false` / non-ok / network failure all keep the `AppID N` fallback; `getGameName` keeps its synchronous contract. |
| `ignore-log.unit.spec.js` | `IgnoreLog` (`ilap_ignore_log`, the undo data source): pure selectors — `snapshotLastN`/`snapshotSince` (newest-first, unique appids, undone skipped), `undoableCount`, `reIgnoredAfter` (only a LIVE newer entry counts), `lastIgnoredAt` (newest LIVE ignore ts — the drainer's userdata-lag guard; undone/skipped entries ignored), `lastUndoneForCurator` (re-stage warning window), cap trim — plus the serialized-RMW storage half (20 concurrent `append`s all land, entries without an appid dropped, name tag-stripped at the boundary, `markUndone` persistence). `skipped:'unavailable'` entries (region-locked appids a curator drain stepped over) are inert for every undo selector — not undoable, no re-ignore veto, untouched by `markedUndone` — and the marker survives `append`. |
| `stats-race.unit.spec.js` | `StatsManager.save`'s per-context serialized read-modify-write chain preserves every increment under rapid concurrent saves within one context. |
| `fetch-timeout.unit.spec.js` | `fetchWithTimeout` deadline covers the WHOLE request: a hung request aborts at the deadline, a stalled body (headers arrived, `json()` hangs) aborts too, a fast response passes through, and `fetchIgnoredApps` folds either abort into its empty-Set contract. |
| `migrate.unit.spec.js` | `src/migrate.js` onInstalled: install → `'widget'` + intro glow; update with the key absent → `'popup'` + one-shot update glow (never re-armed); present key untouched; a transient storage error (`lastError`) writes nothing; other reasons no-op. onStartup re-assert: absent key → `'widget'` (no glow), present key untouched (also under a failing get), and it yields to an install/update event fired in the same lifetime (the update-while-browser-closed race). |
| `background.unit.spec.js` | The Phase-3 SW drain host (`src/background.js`) with the REAL `gate`/`store`/`drainer`/`ignore-log`/`migrate` modules loaded through a stubbed `importScripts` into a worker-shaped sandbox (`self`, no DOM; `chrome.storage`/`chrome.alarms`/`fetch` faked): a queued job drains on the cached `ilap_sw_sid` alone (POSTs paced by the real gate, ignores logged, retry alarm cleared when the queue empties); no cached sid → no POST (gate `no-session` stop) with the alarm armed; two consecutive failed POSTs set `ilap_sw_halt` BEFORE the drainer's `MAX_FAILS` skip can burn an appid, and a fresh sid write (the content script's page-boot cache) revives the drain to completion; a 400 classified as a region-locked appid (appdetails `success:false`) is skipped in one attempt, counted + logged, never charges the halt counter (two ADJACENT locks don't kill the route) and the per-job skip key is cleaned up with the finished job; a long 429 penalty is never slept through (no slot claimed, alarm lands at the penalty's end); the alarm handler kicks a drain pass; a live foreign lease is respected (no steal, no POST). |

## Architecture notes for tests

- `tests/_extension.js` — helpers to read/write `chrome.storage.local` via the service worker, and to derive the extension ID.
- `tests/_cleanup.js` + `tests/global-setup.js` + `tests/global-teardown.js` — the snapshot/diff cleanup (see *Test account cleanup*), wired via `globalSetup`/`globalTeardown` in `playwright.config.js`.
- Auth state: `~/.playwright-states/steam.json` (under the user's home, **outside the repo** — the project tree may be cloud-synced where `.gitignore` won't protect it). Canonical path is defined in `tests/_fixtures.js`.
- Tests run sequentially (`fullyParallel: false`) to avoid conflicting session state.
- `clearExtensionStorage` runs in `beforeEach`/`afterEach` for suites that touch storage.

### Test-flavor build (`dist/chromium-test/`)

The production manifest (`platform/chromium/manifest.json`) has no `background` key — there is no service worker in prod. Without a service worker, `context.serviceWorkers()` in Playwright returns an empty array, which means there is no way to resolve the extension ID needed to open `chrome-extension://<id>/ui/popup.html` or to call `chrome.storage.local` from tests.

`node build.js --test` produces `dist/chromium-test/` which is identical to the production build except for one patched field:

```json
"background": { "service_worker": "src/background-test.js" }
```

`src/background-test.js` is an empty placeholder written by the build script at build time. It registers a service worker so Playwright can call `context.serviceWorkers()`, get the `chrome-extension://` URL, and extract the ID.

**No permissions are added.** The test build has the exact same `permissions` array as production (`["storage"]`). `dist/chromium-test/` is excluded from git via the top-level `dist/` entry in `.gitignore`.
