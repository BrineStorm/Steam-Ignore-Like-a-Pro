# Testing

Playwright E2E tests running against a live Steam session in a real Chromium instance with the extension loaded.  
Mostly end-to-end, validated against Steam's actual DOM; a few pure-logic checks (`DecisionEngine`, `StatsLogic` history cap, `StatsManager` context guard) run as Node unit tests that load the class via `vm` with a stubbed `window`.

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
```

All scripts run `node build.js --test` first, which produces `dist/chromium-test/` — a test-flavor build with a stub MV3 service worker. Playwright uses it to resolve the extension ID; `dist/chromium/` (production) is not touched.

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
| `containers.spec.js` | Badge renders on three container strategy branches: search results (List), storefront daily deals (Wrapper), React storefront tiles (Direct Image). |
| `shortcut-key.spec.js` | Switch default binding to `ctrlKey`: Ctrl+Click fires, right swipe no longer does. Two click-based shortcuts coexist with distinct reasons. |
| `popup-history.spec.js` | After ignore: `ilap_ignored_count`, `ilap_last_ignored_name`, `ilap_ignored_history` land in storage. Popup shows the game name under *Last Ignored*; hover on the trigger reveals the history dropdown with the correct entry and source label. |
| `persistence.spec.js` | Ignore a game → reload the page → badge re-renders from `ilap_session_map_v2` (session storage) with no second API call. |
| `tag-page.spec.js` | On a `/tags/<lang>/<Tag>` sale page, the content script resolves a container and badges each distinct capsule block (hover-capsule strip, bottom sale grid) by seeding the session map. |

### Discovery Queue (`tests/discovery-queue/`)

| File | What it covers |
|---|---|
| `ui.spec.js` | Panel injects into the queue modal; Start activates loop (running class); Stop returns to idle; Keep High Score checkbox toggles; panel unmounts on modal close; **test #6** — Start ignores ~12 real games across a queue boundary (`Continue`), Stop → idle. |
| `master-off.spec.js` | `ilap_q_master=false` keeps the panel out of the modal; flipping it to false while the modal is open retracts the panel. |

DQ automator clicks Steam's own in-page Ignore button (no API call), but the ignore still lands on the account. Test #6 deliberately ignores ~12 real games to exercise the queue-boundary `Continue` path; these are removed afterward by the automatic cleanup (see *Test account cleanup* above).

### Explore Queue (`tests/explore-queue/`)

| File | What it covers |
|---|---|
| `start-prompt.spec.js` | Toast appears with Run/FF/Disable buttons; mode badge defaults to *Bad Reviews*; Close hides toast without setting intent. |
| `bad-mode-ignore.spec.js` | Run in bad mode scans the queue until a Mixed/Negative game is found and ignored; verifies IGNORE micro-badge appears. |
| `intent-and-reload.spec.js` | Run sets `ACTIVE` + `ACTIVE_APPID` in session storage; reload in ACTIVE state shows no duplicate start prompt; sideways nav to a different appid without a nav token re-shows the prompt; manual Steam Next click while ACTIVE issues a nav token. |
| `fast-forward.spec.js` | Fast Forward sets the FF intent in session storage and makes **no** ignore API call (API intercepted via `context.route`). |
| `decision-matrix.spec.js` | **Unit** — `DecisionEngine.decide`: bad mode ignores only IGNORE (spares SPARE/NO_REVIEWS); all mode ignores everything; unknown mode falls back to bad. |
| `mode-live.spec.js` | Mode badge live-updates when `ilap_q_mode` flips between *bad* and *all* in storage. |
| `disable.spec.js` | Disable button sets `ilap_q_master=false`, removes the toast, and prevents the prompt on reload. |

EQ ignores via the ignore API (`apiIgnoreGame`), so `bad-mode-ignore` performs a **real** ignore on the account; it is removed afterward by the automatic cleanup (see *Test account cleanup* above). `fast-forward` intercepts the API with `context.route` and makes no real change.

### Popup (`tests/popup/`)

| File | What it covers |
|---|---|
| `popup-main.spec.js` | Master toggle persists to storage and dims UI; count/last-game reflect storage; history shows latest 3 entries; XSS escaping in history; live re-render on storage change. |
| `settings.spec.js` | Shortcut selectors persist; queue master toggle; mode toggle (bad vs all); mutual exclusion between default and platform selectors. |
| `language.spec.js` | Selecting a language writes `ilap_lang`, updates the chip code, and relabels the UI; stored `ilap_lang` is applied on open; change from another context re-renders live; switching with settings open relabels the settings panel. |

### Cross-cutting (`tests/cross-cutting/`)

Both are **unit** tests (load the class via `vm` with a stubbed `window`/`chrome`) — the main-world `page.evaluate` can't reach `window.ILAP` in the isolated world.

| File | What it covers |
|---|---|
| `history-cap.spec.js` | Driving `saveStats` 25× caps `ilap_ignored_history` at 20 (newest-first) while the count tracks all 25. |
| `sw-restart.spec.js` | `StatsManager.save` is a silent no-op when the extension context is invalidated (no `chrome.runtime.id`), and writes normally once it is valid again. |

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
