# Architecture & SOLID Assessment

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
window.ILAP.getGameName       // 5-strategy name extractor (sync)
window.ILAP.resolveGameName   // async: DOM strategies, then appdetails fallback
window.ILAP.SteamAuth         // login gate: header DOM check + live /account/ probe
                              // (hasLiveSession = the ignore-side flavour, shared with IgnoreGate)
window.ILAP.fetchIgnoredApps  // lenient userdata read (empty Set on failure)
window.ILAP.newOwnerId        // collision-resistant lease/slot owner id
window.ILAP.SessionStateService
window.ILAP.ResourceService
window.ILAP.SESSION_IGNORED_KEY
```

The rest of the facade is populated by modules that stand alone because more than
one script world needs them — the popup document and the MV3 service worker never
load `utils.js`:

```js
window.ILAP.Sanitizer         // escape.js   — escapeHTML + sanitizeName (all 3 worlds)
window.ILAP.StatsLogic        // stats.js    — Last-Ignored record shape + the count-only
                              //               transforms, ±1, for curator drains and
                              //               confirmed rollbacks (content + SW)
window.ILAP.SteamNet          // steam-net.js— Steam READS: deadline, userdata, login, appdetails
                              //               + classifyRefusal, the shared 400 verdict (content + SW)
window.ILAP.IgnoreGate        // gate.js     — aggregate ignore-rate governor + stopVerdict
window.ILAP.IgnoreLog         // ignore-log.js — the undo data source
window.ILAP.UndoService       // undo-service.js — undo-job staging
window.ILAP.Curator.*         // curator/    — Store, Enumerator, EnqueueService, CuratorQueueDrainer
window.ILAP.Surface           // surface.js  — surface-mode helper
window.ILAP.showToast         // toast.js    — the shared one-shot push card
window.ILAP.t / .i18n         // i18n.js     — UI strings + live language switch
```

Modules reference this facade **only** through thin adapter objects, never directly inside business logic (DIP).

### Three script worlds

The extension runs in three isolated worlds that cannot share a module graph:
the **content script**, the **popup document** (`ui/popup.html`), and the
**Chromium MV3 service worker** (`src/background.js`). What may be shared is
graded by how many worlds actually need it — pure helpers and the Steam reads
have exactly one definition in a file every relevant world loads (`escape.js`,
`stats.js`, `steam-net.js`), while the `chrome.storage` plumbing and the ignore
POST stay duplicated beside their consumers. The canonical statement of that rule
lives at the top of `src/curator/store.js`; `src/steam-net.js` records the one
call that stays per-world and why.

### Module Pattern

Every file is wrapped in an IIFE to avoid global namespace pollution:

```js
(function() { 'use strict'; /* ... */ })();
```

### DI Assembly

Each module has a dedicated `main.js` that builds the object graph (adapter objects, service instances) and passes them into constructors. Business logic classes never `new` their own dependencies.

See [`claude.storage-keys.md`](./claude.storage-keys.md) for the storage keys reference.

---

## SOLID Assessment

### What is done well

**SRP** — `StatsLogic` (pure computation) is separated from `StatsManager` (I/O). Adapter objects have single methods. `BadgeFactory`, `BadgeRenderer`, and `DuplicateDetector` each have clear, distinct responsibilities.

**OCP** — Name extraction uses `NameExtractionStrategyProvider` with five interchangeable strategy classes; adding a new extraction method requires no existing edits. `ContainerStrategyProvider` follows the same pattern. `DecisionEngine.strategies` is a dictionary-keyed strategy map.

**LSP** — All name-extraction strategies implement the same `extract(appid, contextElement, root)` signature. Container strategies implement `{ match, resolve }`. Adapter duck-typing is validated at construction time via `typeof` checks in `ExploreAutomator` and `DiscoveryQueueAutomator`.

**ISP** — Adapters are minimal: `{ ignore }`, `{ save }`, `{ get }`. Downstream classes never receive more surface area than they need.

**DIP** — All three automators (Manual, Discovery, Explore) receive adapters rather than direct references to `window.ILAP.*`. No concrete class instantiates its own external dependencies.
