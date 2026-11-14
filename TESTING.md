# Testing

The extension is tested in layers. Pure logic runs as Node unit tests, which CI runs on every push. Everything that depends on Steam runs as Playwright end-to-end tests against the live store, with a real signed-in session and the extension loaded in a real browser. Each spec file opens with a comment that says what it pins, so this page maps the layers and leaves the detail to the specs.

## The layers

| Layer | What it guarantees | Needs | Changes the account | Command |
|---|---|---|---|---|
| Units | Decisions, pacing, the queue store and drainer, the SW drain host, the i18n contract, the manifests' load order | nothing | no | `npm run test:units` (~30 s) |
| Canary | Steam's markup still has every selector the content scripts read | network | no | `npm run test:canary` |
| Panel, offline | The toolbar panel's AI tab, settings, built-in lists, languages and accessibility, with no Steam page | nothing | no | `npm run test:ui-offline` |
| E2E, Chromium | The extension on live store pages, in the toolbar popup and in the on-page widget. Most ignore POSTs are stubbed | a saved session | a few real ignores, rolled back after the run | `npm test` (about half an hour) |
| Live drains | The curator drainer and the shipping service worker against Steam, with no stubs | a saved session | real ignores, rolled back | `npm run test_live`, `npm run test_sw_live` |
| Slow machine | The swipe, the panel, the widget, the AI marks and the queue still work with the CPU slowed six times. Nothing is timed | a saved session | no | `npm run test:slow` (about 3 min) |
| Firefox | The store-page suites in Gecko | a saved session, a free desktop | as the Chromium E2E | `npm run test:ff` (about 40 min) |
| By hand | The native context menu stays shut at press on Linux and macOS | a Linux desktop, WSLg or a Mac | real ignores, roll back by hand | [docs/manual-menu-check.md](docs/manual-menu-check.md) |

CI runs the units and the offline panel specs on every push (`.github/workflows/units.yml`) and the canary weekly (`.github/workflows/canary.yml`). The panel specs are allowed to fail there until their first runs on a Linux runner are seen green, since they were written against Windows fonts. The rest needs a signed-in Steam session and runs locally.

## Quick start

```bash
npm install
npm run test:auth     # once: a browser opens, sign in to Steam by hand, the session is saved to ~/.playwright-states/steam.json
npm run test:units    # the logic, in about 30 s
npm test              # builds both flavors and runs every Chromium suite
```

Run `test:auth` again whenever the saved session expires. The session file lives in your home folder, outside the repo, because the project folder may be synced to a cloud drive where `.gitignore` protects nothing.

One suite at a time:

```bash
npm run test_mi       # Manual Ignore
npm run test_dq       # Discovery Queue
npm run test_eq       # Classic Discovery Queue (Explore Queue)
npm run test_popup    # toolbar popup
npm run test_curator  # curator ignore queue
npm run test_widget   # on-page widget
```

## How a run works

- **Build first.** Every script runs `node build.js --test` first. The E2E tests load `dist/chromium-test/`, so a bare `npx playwright test` runs whatever was built last. The test build is the production build with an empty service worker (`src/background-test.js`, written by the build) in place of `src/background.js`. Playwright needs a worker to learn the extension's id and to reach `chrome.storage.local`, and an empty one never drains a queue behind a test's back. Permissions are the same as in production.
- **No window.** `tests/_fixtures.js` launches Chromium in its new headless mode, which loads extensions, so a run takes neither the screen nor the focus. Set `ILAP_HEADED=1` to watch one (`$env:ILAP_HEADED='1'; npm test` in PowerShell). `test:auth` and Firefox stay headed.
- **One at a time.** One worker, tests in order, a fresh persistent profile per test. The session cookies are injected into each profile.
- **Fixture option.** A spec or project can set `scale` (the device pixel ratio, as Windows display scaling sets it) with `test.use`.
- **The production worker.** `curator/sw-live.spec.js` alone loads `dist/chromium/`, the shipping bytes with the real service worker, because a stub cannot prove the worker works. `npm test` builds both flavors for that reason.

## Keeping the test account clean

A few suites ignore **real** games: the Classic Discovery Queue's bad-mode run (one game) and the Discovery Queue run that crosses a queue boundary (about twelve). Every run wraps itself in a snapshot and a diff, whichever scripts started it:

- `tests/global-setup.js` saves the account's ignored appids (`dynamicstore/userdata` → `rgIgnoredApps`) to `~/.playwright-states/ignored-before.json`.
- `tests/global-teardown.js` reads the list again and un-ignores exactly the games the run added (`remove=1` on the ignore endpoint), then checks with a fresh read.

`tests/_cleanup.js` removes strictly that diff and never one of your own ignores. It refuses a diff over 200 games, and it skips the cleanup when the session is not signed in at either end. A run killed hard skips its teardown. Run `node -e "require('./tests/global-teardown.js')()"` to catch up. The suites that stub the ignore POST change nothing, so they never show in the diff.

## Firefox

```bash
npm run test:ff
```

Firefox runs the store-page suites. Three things shape its harness (`tests/_firefox.js`, `tests/_extension.js`):

- **Loading.** Playwright's Firefox has no `--load-extension`. The harness starts Firefox with its debugger server, installs the add-on over the Remote Debugging Protocol (`installTemporaryAddon`, a small client with no new dependency), and pins the add-on's internal UUID in the profile's `user.js` before launch.
- **Storage.** Firefox exposes no extension worker and blocks a tab from opening a `moz-extension://` page. The Firefox test build drops the background and adds a content script (`src/test-storage-bridge.js`, written by the build) that relays `chrome.storage.local` over `postMessage` from a bridge tab on a static Steam page.
- **Pace.** Each test may take 110 s and is retried twice: a headed launch, the add-on install and synthetic mouse timing all slow down over a long run.

The toolbar popup suite (`tests/popup/`) and `manual-ignore/popup-history.spec.js` are Chromium only, since Firefox cannot open the popup page as a tab. The widget suite covers the same UI on the page. The unit specs run once, in the Chromium project.

Firefox runs headed, and a Firefox window that never gets the focus stalls the run (a mass of timeouts in `beforeEach` is that, not a regression). Keep the desktop free while it runs.

## Motion and scrollbars

Nothing in the popup, the widget or on Steam's page appears, disappears or changes size in one frame, every motion has a reduced-motion fallback, and no scrollbar shows unless content really outgrows its box. Three specs guard this:

- `popup/motion.spec.js` samples elements frame by frame while they change and asserts each change has its motion, and none with reduced motion.
- `widget/reduced-motion.spec.js` walks the widget's states with `prefers-reduced-motion: reduce` and asserts nothing runs longer than a frame. On Steam's page it checks our elements and leaves Steam's alone.
- `widget/scrollbars.spec.js` watches every scroll box of the widget frame by frame, in every interface language, and at 125 % and 150 % display scaling. `popup/popup-height.spec.js` holds the toolbar window to its 600 px.

A new UI change comes with its line in one of these specs.

## The suites

| Folder | What it covers |
|---|---|
| `tests/manual-ignore/` | Gestures, shortcuts and badges on store pages: swipes and their reasons, the deferred MI queue, containers by page type, bundles and creators, the AI tab's browsing level, the master switch, a session that ends in another tab |
| `tests/discovery-queue/` | The panel in Steam's queue modal: Start and Stop, Keep High Score against Steam's review palette, the cross-tab cap, the sale-reward lock |
| `tests/explore-queue/` | The Classic Discovery Queue helper: the start prompt, modes, intent across reloads, the HIGH AI level, the decision matrix |
| `tests/popup/` | The toolbar popup: settings, tabs, the built-in lists, the AI tab, the queue, Undo, languages, the height budget, motion, accessibility |
| `tests/curator/` | Enumerate, stage and drain: the curator-page button, the drainer stubbed and live, the shipping service worker live |
| `tests/widget/` | The on-page widget: login lock, first open, collapse and pin, the surface mode, forged input from page script, the queue window, scrollbars, reduced motion |
| `tests/canary/` | Steam's own markup, with no extension and no login |
| `tests/cross-cutting/` | Units for the shared modules (gate, log, stats, i18n, settings, load order, the SW drain host, builds) and the live check of Steam's own Ignore button |

## Writing a test

- Take `test` and `expect` from `tests/_fixtures.js`, never from `@playwright/test`. Only its persistent context loads the extension.
- Open the spec with a comment that says what it pins and how (live, stubbed, unit).
- A spec that makes the extension POST an ignore stubs it with `context.route` (`tests/_steam-routes.js`). The glob must match the POST's whole path (`**/recommended/ignorerecommendation/**` or a predicate), and the route catches the service worker's fetch too. Stub `dynamicstore/userdata` as well, or the drainer's dedupe may skip a game that is already among the account's real ignores.
- The MI POST goes through the queue and the rate gate, seconds after the gesture. Wait with `DRAIN_TIMEOUT` (`tests/manual-ignore/_helpers.js`). To show a gesture did nothing, check the queue (`miJob()`) rather than the absence of a POST.
- Content scripts live in an isolated world, so `page.evaluate` cannot see `window.ILAP`. Go through the DOM, `sessionStorage` or extension storage (`tests/_extension.js`).
- Clear extension storage in `beforeEach` and `afterEach` when a spec writes to it.
