# Testing

Playwright E2E tests running against a live Steam session in a real Chromium instance with the extension loaded.  
No unit tests — all behavior is end-to-end, validated against Steam's actual DOM.

## Setup

```bash
npm install
npm run test:auth     # one-time: opens a browser, log in manually, saves session to playwright/.auth/user.json
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

## Test suites

### Manual Ignore (`tests/manual-ignore/`)

**Important:** Manual Ignore calls Steam's ignore API directly. Every test stubs `window.ILAP.apiIgnoreGame` before triggering gestures so no real account changes happen.

| File | What it covers |
|---|---|
| `swipe-gesture.spec.js` | Right swipe → reason 0 (default ignore); Left swipe → reason 2 (Already Played); short swipe no-op; master toggle off; gesture isolation (each swipe direction maps to exactly one reason); context menu suppression after gesture; dedup. |
| `containers.spec.js` | Badge renders on three container strategy branches: search results (List), storefront daily deals (Wrapper), React storefront tiles (Direct Image). |
| `shortcut-key.spec.js` | Switch default binding to `ctrlKey`: Ctrl+Click fires, right swipe no longer does. Two click-based shortcuts coexist with distinct reasons. |
| `popup-history.spec.js` | After ignore: `ilap_ignored_count`, `ilap_last_ignored_name`, `ilap_ignored_history` land in storage. Popup shows the game name under *Last Ignored*; hover on the trigger reveals the history dropdown with the correct entry and source label. |

### Discovery Queue (`tests/discovery-queue/`)

| File | What it covers |
|---|---|
| `ui.spec.js` | Panel injects into the queue modal; Start activates loop (running class); Stop returns to idle; checkbox toggles; panel unmounts on modal close. |

DQ automator clicks Steam's own in-page Ignore button (no API call). Running Start/Stop during tests is safe.

### Explore Queue (`tests/explore-queue/`)

| File | What it covers |
|---|---|
| `start-prompt.spec.js` | Toast appears with Run/FF/Disable buttons; mode badge defaults to *Bad Reviews*; Close hides toast without setting intent. |
| `bad-mode-ignore.spec.js` | Run in bad mode scans the queue until a Mixed/Negative game is found and ignored; verifies IGNORE micro-badge appears. |
| `intent-and-reload.spec.js` | ACTIVE intent survives a page reload; no duplicate start prompt. |
| `disable.spec.js` | Disable button sets `ilap_q_master=false` and removes the toast. |

EQ automator clicks Steam's Next button (no direct API call). Real start/run is safe.

### Popup (`tests/popup/`)

| File | What it covers |
|---|---|
| `popup-main.spec.js` | Master toggle persists to storage and dims UI; count/last-game reflect storage; history shows latest 3 entries; XSS escaping in history; live re-render on storage change. |
| `settings.spec.js` | Shortcut selectors persist; queue master toggle; mode toggle (bad vs all); mutual exclusion between default and platform selectors. |

## Architecture notes for tests

- `tests/_extension.js` — helpers to read/write `chrome.storage.local` via the service worker, and to derive the extension ID.
- Auth state: `playwright/.auth/user.json`. It is gitignored; never commit it.
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
