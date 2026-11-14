# Architecture & SOLID Assessment

**Naming:** in code EQ = `src/explore-queue/` = user-facing **Classic Discovery Queue** (the `/app/<id>?queue=1` pages with the Queue Helper prompt); DQ = `src/discovery-queue/` = user-facing **Discovery Queue** (the panel in Steam's queue modal). User-facing text never says "Explore Queue" or the abbreviations.

## Architecture

### Global Facade (`window.ILAP`)

`src/utils.js` initialises the shared namespace and exports what is genuinely
content-script-bound:

```js
window.ILAP.getSessionID      // sessionid cookie (a CSRF token — NOT a login check; anonymous visitors get one too)
window.ILAP.apiIgnoreGame     // POST to Steam ignore endpoint
window.ILAP.apiUnignoreGame   // the same endpoint with remove=1 (undo)
window.ILAP.saveStats         // Write the full Last-Ignored record (count + history + name)
window.ILAP.bumpIgnoredCount  // Count only — the drained curator ignore (no name, batch-sized)
window.ILAP.dropIgnoredCount  // Count only, −1 — a confirmed rollback (history untouched)
window.ILAP.SteamAuth         // login gate: header DOM check + live /account/ probe
                              // (hasLiveSession = the ignore-side flavour, shared with IgnoreGate)
window.ILAP.fetchIgnoredApps  // lenient userdata read (empty Set on failure)
window.ILAP.OwnIgnorePosts    // marks of this page's own ignore POSTs, so steam-activity.js
                              // can tell them from Steam's in the resource timeline (Firefox)
window.ILAP.SessionStateService
window.ILAP.ResourceService
```

`src/game-name.js` adds the name lookup for the same world:

```js
window.ILAP.getGameName       // 5-strategy name extractor (sync)
window.ILAP.resolveGameName   // async: DOM strategies, then SteamNet.fetchAppName
```

The rest of the facade is populated by modules that stand alone because more than
one script world needs them — the popup document and the MV3 service worker never
load `utils.js`:

```js
window.ILAP.Sanitizer         // escape.js   — escapeHTML + sanitizeName (all 3 worlds)
window.ILAP.Settings          // settings-schema.js — settings keys, defaults, normalizers (all 3 worlds)
window.ILAP.newOwnerId        // escape.js   — collision-resistant lease/slot owner id (all 3 worlds)
window.ILAP.serialChain       // escape.js   — the per-context write chain every storage module builds on (all 3 worlds)
window.ILAP.realInput         // escape.js   — the real-input guard for controls in the page's DOM (DQ panel, EQ toast, automation notice)
window.ILAP.loadPresets       // presets.js  — the built-in lists (data/presets.json), read once per context (content + popup)
window.ILAP.aiGames           // presets.js  — the AI games of the lists less the kept kinds: what the AI tab counts
window.ILAP.aiKinds           // presets.js  — the AI use the lists know per game (translation, in game), for the AI flag
window.ILAP.AiDisclosure      // ai-disclosure.js — the disclosure's word rules, the page read (fromPage) and the verdict (counts)
window.ILAP.SteamPalette      // queue-common/steam-palette.js — Steam's review-score bands as ONE table for
                              //               both classifiers (EQ rows + DQ cards); each band a
                              //               SET, current shade first, previous ones behind it
window.ILAP.StatsLogic        // stats.js    — Last-Ignored record shape + the count-only
                              //               transforms, ±1, for curator drains and
                              //               confirmed rollbacks, and the EQ/DQ history
                              //               labels (all 3 worlds; the popup only reads)
window.ILAP.SteamNet          // steam-net.js— Steam READS: deadline, userdata, login, appdetails
                              //               + classifyRefusal, the shared 400 verdict, and the
                              //               ignore POST's URL and result shape (content + SW)
window.ILAP.IgnoreGate        // gate.js     — aggregate ignore-rate governor + stopVerdict
window.ILAP.IgnoreLog         // ignore-log.js — the undo data source (chunked) + the drainer's log hooks
window.ILAP.MasterSwitch      // master-switch.js — the global master read + live follow (content)
window.ILAP.UndoService       // undo-service.js — undo-job staging
window.ILAP.Curator.*         // curator/    — Lease, Store, Cache, DoneMarks, Enumerator, EnqueueService, CuratorQueueDrainer
window.ILAP.Surface           // surface.js  — surface-mode helper
window.ILAP.showToast         // toast.js    — the shared one-shot push card
window.ILAP.t / .i18n         // i18n.js     — UI strings + live language switch
window.ILAP_Icons             // ui/icons.js — SVG glyphs drawn by more than one UI file (content + popup)
```

The composition roots — each module's `main.js`, `curator/drainer-host.js`,
`ui/popup_main.js` and `src/background.js` — read this facade and hand the
automators, the drainer, the controllers and the popup's queue, lists and undo
panels their collaborators as adapter objects (DIP). These places still reach for
something of their own, knowingly:

- `IgnoreGate` (`gate.js`) resolves its session check from the facade
  (`defaultHasSession` → `SteamAuth.hasLiveSession`); the service worker, which
  has no such facade, swaps it through `IgnoreGate.configure({ hasSession })`.
- `DiscoveryQueueAutomator` (`discovery-queue/logic.js`) reads the modal through
  the static `SlideScanner` and finds it with `document.querySelector`: the Steam
  markup itself, and its unit spec fakes the DOM instead.
- `creators.js` and `manual-ignore/bundle.js` read Steam through `IgnoreGate` and
  `SteamNet` on the facade, and `curator/enumerate.js` defaults to them, with
  `opts` for its unit spec. They are thin read helpers, each a few lines around
  one request.
- Shared UI helpers stay module reads: `t`, the escaper, `ILAP_Icons`,
  `ILAP_Tabs`, `PopupSelect`. So do the two small page-load scripts
  (`ignored-total.js`, `steam-activity.js`) and the panes with no logic of
  their own to test (`popup_history.js`, `popup_settings.js`, `popup_ai.js`).
- `IgnoreManager` (`manual-ignore/ignore-manager.js`) finds the links to badge with
  `document.querySelectorAll` in `refreshBadgesForGame` and `refreshAll`: the
  page itself, which its unit spec stubs. Its marks are three injected models
  (`manual-ignore/marks.js`: `BadgeMarks`, `TintMarks`, `BundleMarks`), each with
  its own unit spec, and it keeps only the gesture flows and the in-flight sets.

A dependency whose absence would switch a safety check or a record off is
required and checked at construction — the drainer's every dependency, the
`gate` and every collaborator of both queue automators, the review palette of
the Discovery Queue, the login gate, hooks and collaborators of Manual Ignore's
`IgnoreManager`, the popup's queue, lists and undo panels — so a wiring mistake throws instead of running unguarded. Unit
specs supply inert stand-ins for what a test is not about.

### Three script worlds

The extension runs in three isolated worlds that cannot share a module graph:
the **content script**, the **popup document** (`ui/popup.html`), and the
**Chromium MV3 service worker** (`src/background.js`). What may be shared is
graded by how many worlds actually need it — pure helpers, the settings schema
and the Steam reads have exactly one definition in a file every relevant world
loads (`escape.js`, `settings-schema.js`, `stats.js`, `steam-net.js`,
`queue-common/steam-palette.js`), while the `chrome.storage` plumbing and the ignore POST stay
duplicated beside their consumers. The rule is stated where the storage shim sits
in `src/curator/store.js`; `src/steam-net.js` records the one call that stays
per-world and why.

### Module Pattern

Every file is wrapped in an IIFE to avoid global namespace pollution:

```js
(function() { 'use strict'; /* ... */ })();
```

### DI Assembly

Each module has a dedicated `main.js` that builds the object graph (adapter objects, service instances) and passes them into constructors. Business logic classes never `new` their own dependencies — the undo applet included, which is handed its `UndoService` by `popup_main.js`.

See [`claude.storage-keys.md`](./claude.storage-keys.md) for the storage keys reference.

---

## SOLID Assessment

### What is done well

**SRP** — `StatsLogic` (pure computation) is separated from `StatsManager` (I/O). Adapter objects have single methods. `BadgeFactory`, `BadgeRenderer`, `AiMarks`, `SteamFlagTint`, `FloatTip` and `DuplicateDetector` each have clear, distinct responsibilities, on the `MarkDom` helpers. A host is a file apart from what it hosts (`curator/drainer-host.js`, `manual-ignore/main.js` over `ignore-manager.js`, `curator/main.js` over `menu.js` and `button-style.js`, `popup_queue.js` over `popup_queue_rows.js`).

**OCP** — Name extraction (`game-name.js`) uses `NameExtractionStrategyProvider` with five interchangeable strategy classes; adding a new extraction method requires no existing edits. `DecisionEngine.strategies` is a dictionary-keyed strategy map, and so is the curator drainer's policy table (`policiesFor`): one entry per job type (`satisfied`, `staleRead`, `onDeduped`, `superseded`, `landedReason`, `post`, `onLanded`, `droppedLogEntry`, `onDropped`, `onFinished`, `cancellable`, `accountSkip`, `readsUserdata`, `needsRead`, `freshCursor`, `needsApi`, `reconcile`), with `_drainJob` a loop shared by all of them — `_skipReason` decides an entry that needs no POST, `_handleResult` what a POST's result means. `ContainerStrategyProvider` takes its list (`CONTAINER_STRATEGIES`), so a new container strategy is one more entry. The queue's `jobViews` (`popup_queue_rows.js`: name, glyph, class), the recent history's `SOURCES` and its `JOB_ENTRIES` (`stats.js`) are one row per type as well.

**LSP** — All name-extraction strategies implement the same `extract(appid, contextElement, root)` signature. Container strategies implement `{ match, resolve }`. Adapter duck-typing is validated at construction time via `typeof` checks in `ExploreAutomator` and `DiscoveryQueueAutomator`.

**ISP** — Adapters are minimal: `{ ignore }`, `{ fetchIgnored }`, `{ save }`, `{ get }`. The Explore automator's settings come through `QueueSettings` (`explore-queue/utils.js`) in its own terms — `{ globalOn, queueOn, autoNext, mode }` and switch transitions as `{ was, now }` — so it names no storage key. Downstream classes never receive more surface area than they need — DQ, which never POSTs itself (its click makes Steam's page fire the ignore), gets a userdata reader instead of an api adapter, and `popup_main.js` hands each panel only the members it names (`pick`). The drainer is the exception: it takes the whole `Store`.

**DIP** — All three automators (Manual, Discovery, Explore), the curator drainer, the DQ controller and the popup's queue, lists and undo panels receive adapters rather than direct references to `window.ILAP.*`; the exceptions above are the ones left.
