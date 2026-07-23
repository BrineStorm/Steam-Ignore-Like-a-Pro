# Architecture & SOLID Assessment

## Architecture

### Global Facade (`window.ILAP`)

`src/utils.js` initialises the shared namespace and exports:

```js
window.ILAP.getSessionID      // Steam session cookie
window.ILAP.apiIgnoreGame     // POST to Steam ignore endpoint
window.ILAP.saveStats         // Write to chrome.storage.local
window.ILAP.getGameName       // 5-strategy name extractor (sync)
window.ILAP.resolveGameName   // async: DOM strategies, then appdetails fallback
window.ILAP.SteamAuth         // login gate: header DOM check + live /account/ probe
window.ILAP.SessionStateService
window.ILAP.SESSION_IGNORED_KEY
```

Modules reference this facade **only** through thin adapter objects, never directly inside business logic (DIP).

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
