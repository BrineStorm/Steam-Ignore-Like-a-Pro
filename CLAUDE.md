# Steam Ignore Like a Pro — Developer Reference

## Project Overview

Browser extension (Chrome/Edge/Firefox, Manifest V3) that lets users ignore Steam Store games via gestures, hotkeys, or automated queue processing. Vanilla JS with no framework. Built with explicit SOLID / Dependency Injection discipline.

---

# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

*Rules 1–4 above are adapted from [andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) by Forrest Chang (MIT License), derived from Andrej Karpathy's observations on common LLM coding pitfalls.*

---

## Tech Stack

| Concern | Tool |
|---------|------|
| Language | Vanilla JS (ES2020+) |
| Build | `node build.js` → copies assets to `dist/chromium` and `dist/firefox` |
| Tests | Playwright E2E (`npm test`, `npm run test:e2e`, `npm run test:auth`) |
| Storage | `chrome.storage.local` (persistent), `sessionStorage` (per-tab) |
| API | Steam `POST /recommended/ignorerecommendation/` |

---

## Directory Structure

```
Steam-Ignore-Like-a-Pro/
├── platform/
│   ├── chromium/manifest.json   # MV3 manifest for Chrome/Edge
│   └── firefox/manifest.json    # MV3 manifest for Firefox
├── src/
│   ├── utils.js                 # Shared infrastructure (loaded first)
│   ├── manual-ignore/
│   │   ├── utils.js             # ConfigService, ContainerStrategyProvider, gesture detectors
│   │   ├── ui.js                # BadgeFactory, BadgeRenderer, DuplicateDetector
│   │   └── main.js              # App bootstrap + IgnoreManager
│   ├── discovery-queue/
│   │   ├── logic.js             # SlideScanner, DiscoveryQueueAutomator
│   │   ├── ui.js                # Queue UI controls
│   │   └── main.js              # DiscoveryQueueController bootstrap
│   └── explore-queue/
│       ├── utils.js             # QueueContext, ReviewAnalyzer, DecisionEngine, NavigationGuard
│       ├── ui.js                # ActionUI (toast, visuals, badges)
│       ├── automator.js         # ExploreAutomator (state machine)
│       └── main.js              # DI wiring + MutationObserver bootstrap
├── ui/
│   ├── popup.html
│   ├── popup_main.js            # Stats + history display
│   └── popup_settings.js        # Settings UI
├── styles/styles.css
├── build.js
└── tests/
    ├── auth.setup.spec.js       # Manual Steam login, saves cookies to playwright/.auth/
    ├── _extension.js            # Shared helpers: getExtensionId, storage read/write/clear, popupUrl
    ├── cross-cutting/
    │   ├── history-cap.spec.js       # ilap_ignored_history capped at 20
    │   └── sw-restart.spec.js        # Survives chrome.runtime.reload + page reload
    ├── explore-queue/
    │   ├── _helpers.js
    │   ├── start-prompt.spec.js      # Toast, mode badge, Close button
    │   ├── intent-and-reload.spec.js # ACTIVE persistence, reload regression, nav token
    │   ├── bad-mode-ignore.spec.js   # End-to-end: finds and ignores a Mixed/Negative game
    │   ├── disable.spec.js           # Disable button → ilap_q_master=false
    │   ├── fast-forward.spec.js      # FF intent set, no ignore API call
    │   ├── decision-matrix.spec.js   # DecisionEngine bad/all × SPARE/IGNORE/NO_REVIEWS
    │   └── mode-live.spec.js         # Mode badge live-updates on ilap_q_mode change
    ├── discovery-queue/
    │   ├── ui.spec.js                # Panel injection, Start/Stop cycle, checkbox, modal close
    │   └── master-off.spec.js        # ilap_q_master=false → panel not mounted / retracted
    ├── manual-ignore/
    │   ├── _helpers.js
    │   ├── swipe-gesture.spec.js     # Right/left swipe, threshold, master toggle, dedup
    │   ├── shortcut-key.spec.js      # Ctrl+Click, dual shortcuts coexist
    │   ├── containers.spec.js        # ContainerStrategyProvider: search/storefront/React/tag/app detail
    │   ├── persistence.spec.js       # Reload restores badge from ilap_session_map_v2
    │   └── popup-history.spec.js     # Stats reach popup; source label per reason
    └── popup/
        ├── popup-main.spec.js        # Master toggle, counters, history, XSS, live update
        └── settings.spec.js          # Queue toggles, mode, shortcut selects, mutual exclusion
```

### Script Load Order (manifest content_scripts)

```
1. src/utils.js                → window.ILAP global + shared services
2. src/manual-ignore/utils.js  → window.ILAP.ManualIgnore.*
3. src/manual-ignore/ui.js
4. src/manual-ignore/main.js
5. src/discovery-queue/logic.js → window.ILAP.Discovery.*
6. src/discovery-queue/ui.js
7. src/discovery-queue/main.js
8. src/explore-queue/utils.js   → window.ILAP.Explore.*
9. src/explore-queue/ui.js
10. src/explore-queue/automator.js
11. src/explore-queue/main.js
12. styles/styles.css
```

---

## Architecture

### Global Facade (`window.ILAP`)

`src/utils.js` initialises the shared namespace and exports:

```js
window.ILAP.getSessionID      // Steam session cookie
window.ILAP.apiIgnoreGame     // POST to Steam ignore endpoint
window.ILAP.saveStats         // Write to chrome.storage.local
window.ILAP.getGameName       // 5-strategy name extractor
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

### Storage Keys Reference

| Key | Storage | Purpose |
|-----|---------|---------|
| `ilap_ignored_count` | local | Total games ignored |
| `ilap_ignored_history` | local | Last 20 ignored games |
| `ilap_last_ignored_name` | local | Most recent game |
| `ilap_shortcut_key` | local | Default ignore shortcut |
| `ilap_platform_key` | local | Alternative shortcut |
| `ilap_master_enabled` | local | Global on/off |
| `ilap_q_master` | local | Queue automator enable |
| `ilap_q_next` | local | Auto-advance after ignore |
| `ilap_q_mode` | local | `"bad"` or `"all"` |
| `ilap_session_map_v2` | session | appid → reason map |
| `ilap_queue_active` | session | Explore queue ACTIVE intent |
| `ilap_queue_ff` | session | Explore queue fast-forward intent |
| `ilap_queue_nav_token` | session | 15 s navigation authorization token |

---

## SOLID Assessment

### What is done well

**SRP** — `StatsLogic` (pure computation) is separated from `StatsManager` (I/O). Adapter objects have single methods. `BadgeFactory`, `BadgeRenderer`, and `DuplicateDetector` each have clear, distinct responsibilities.

**OCP** — Name extraction uses `NameExtractionStrategyProvider` with five interchangeable strategy classes; adding a new extraction method requires no existing edits. `ContainerStrategyProvider` follows the same pattern. `DecisionEngine.strategies` is a dictionary-keyed strategy map.

**LSP** — All name-extraction strategies implement the same `extract(appid, contextElement, root)` signature. Container strategies implement `{ match, resolve }`. Adapter duck-typing is validated at construction time via `typeof` checks in `ExploreAutomator` and `DiscoveryQueueAutomator`.

**ISP** — Adapters are minimal: `{ ignore }`, `{ save }`, `{ get }`. Downstream classes never receive more surface area than they need.

**DIP** — All three automators (Manual, Discovery, Explore) receive adapters rather than direct references to `window.ILAP.*`. No concrete class instantiates its own external dependencies.
