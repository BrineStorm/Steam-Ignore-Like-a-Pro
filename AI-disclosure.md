# AI Disclosure

This document describes the use of AI tools in the development of this project.

## What this project contains

This is a browser extension consisting of **source code**, **icons**, **UI assets** (images, GIF demo clips), and **store/promotional graphics** (screenshots, marquee, tile). There is no AI-generated content delivered to the end user as part of the extension's runtime behavior.

## AI tool usage by asset type

| Asset type        | AI used | Contribution and Scope                                      |AI Tools used |
|-------------------|---------|-------------------------------------------------------------|---------- |
| Code and UI       | Yes     | AI-assisted; all logic described, reviewed and tested by dev|Gemini, Claude|
| UI translations   | Yes     | AI-translated from English into 18 languages; partly reviewed by hand |Gemini, Claude|
| Extension icon    | Yes     | AI-generated base, manually processed and refined           |Imagen 4   |
| Demo GIFs         | No      | Recorded and edited manually                                | -         |
| Store / promo art | Partly  | The first edition was made in Affinity and reimagined later in Claude Design | Claude (Design) |

## SOLID assessment (Claude AI review)

Evaluated against the source as of September 30, 2026 (release 1.3.0), covering the changes since the August snapshot: the settings schema shared by all three script worlds (`settings-schema.js`), the name lookup split out of `utils.js` (`game-name.js`), the curator lease split out of the store (`curator/lease.js`), the drainer's per-job-type policy table, the shared master-switch watcher (`master-switch.js`), the single review-colour table (`steam-palette.js`) and the shared UI glyphs (`ui/icons.js`).

| Criterion | Score | Key note |
|-----------|-------|----------|
| **S** — Single Responsibility | 9/10 | Pure logic, DOM reading and I/O stay apart (`StatsLogic` vs `StatsManager`; `BadgeFactory`/`BadgeRenderer`/`DuplicateDetector`). The widget splits into single-key controllers (`createCollapse`/`createPin`/`createSurface`/`createLoginGate`), headless orchestration (`EnqueueService`) is separated from its DOM layer, and the latest splits follow the same line: `utils.js` lost the name lookup to `game-name.js` and is now under half its former size, and the lease lock left the curator store for `lease.js`. Lone outlier: `curator/main.js` still mixes CSS + DOM + menu positioning + wiring in one IIFE. |
| **O** — Open/Closed | 9/10 | New behaviour plugs in by adding a record: `NameExtractionStrategyProvider`, `DecisionEngine.strategies`, and now the drainer's policy table (`policiesFor`), where each job type is one entry and the drain loop is shared by all of them. The curator filter vocabulary is one ordered list in `filters.js`, and each review band in `steam-palette.js` is a set of shades, so a Steam repaint is a data edit. Not everything is open: `ContainerStrategyProvider` shares the strategy shape but fixes its list in its constructor, so a new container strategy is an edit there. |
| **L** — Liskov Substitution | 8.5/10 | Strategies and adapters are interchangeable via a shared signature and runtime `typeof` guards in the automators. The strongest evidence: one unmodified `CuratorQueueDrainer` runs in a tab and in the service worker, handed two entirely different adapter sets (cookie vs cached session id, in-memory standby vs alarm) and behaving identically. Formal interfaces would require TypeScript, out of scope for vanilla JS at this size. |
| **I** — Interface Segregation | 9/10 | Adapters stay minimal — `{ignore}`, `{save}`, `{get}`, `{reserve}` (rate gate) and the DQ registry lease. The Classic Discovery Queue automator now gets its settings through `QueueSettings` in its own terms (`{ globalOn, queueOn, autoNext, mode }`) and names no storage key, and the Discovery Queue, which never sends the ignore itself, gets a userdata reader instead of an API adapter. |
| **D** — Dependency Inversion | 8.5/10 | Each module's `main.js`, the drainer's tab boot and the service worker assemble the object graph and hand collaborators in as adapters; the popup's undo applet is handed its `UndoService` rather than building one. Settings keys and defaults come from one schema instead of being spelled by each reader. Four places still knowingly reach for a default of their own (the gate's session check, the fixed container-strategy list, the Discovery Queue's reading of Steam's modal markup, and the badge refresh querying the page), and `popup_queue.js` / `popup_undo.js` still reach a couple of singletons directly. All of it is documented, contained debt within one world. |

**Overall: 8.8 / 10** for SOLID structure. The scores reflect architecture only.

One tradeoff is worth stating plainly, since it is the largest structural cost in the codebase and it is deliberate: the extension runs in three isolated script worlds (content script, popup document, service worker) that cannot share a module graph, so a thin layer of storage plumbing and the ignore request's `fetch` call exist in more than one copy — a few dozen lines, well under 1% of the source. The rule applied is graded by how many worlds a block actually spans: *pure* code has no excuse at all and lives in exactly one file every world that needs it loads — `escape.js` for the string boundary and the shared write chain, `settings-schema.js` for settings keys and defaults, `stats.js` for the shape of the "Last Ignored" record; the Steam network **reads**, and the ignore request's URL, fields and result shape, live once in `steam-net.js`, loaded by the two worlds that talk to Steam — the popup never does. What stays duplicated is `chrome.*`-bound storage plumbing, beside its consumer with a note pointing at its siblings, and the `fetch` itself, where the worlds genuinely diverge (session id source, cross-origin credentials, the worker's halt counter). The distinction is not academic: every block that was consolidated had carried an "if you change this, visit the sibling" comment, and had drifted anyway. Further SOLID restructuring beyond this would amount to over-engineering for a browser extension of this scope.
