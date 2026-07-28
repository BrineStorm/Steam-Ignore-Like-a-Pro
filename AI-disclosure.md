# AI Disclosure

This document describes the use of AI tools in the development of this project.

## What this project contains

This is a browser extension consisting of **source code**, **icons**, **UI assets** (images, MP4 demo clips), and **store/promotional graphics** (screenshots, marquee, tile). There is no AI-generated content delivered to the end user as part of the extension's runtime behavior.

## AI tool usage by asset type

| Asset type        | AI used | Contribution and Scope                                      |AI Tools used |
|-------------------|---------|-------------------------------------------------------------|---------- |
| Code and UI       | Yes     | AI-assisted; all logic described, reviewed and tested by dev|Gemini, Claude|
| Extension icon    | Yes     | AI-generated base, manually processed and refined           |Imagen 4   |
| Demo video / MP4  | No      | Recorded and edited manually                                | -         |
| Store / promo art | Partly  | The first edition was made in Affinity and reimagined later in Claude Design | Claude (Design) |

## SOLID assessment (Claude AI review)

Evaluated against the source as of July 25, 2026, covering the additions since the July snapshot: the Phase-3 service-worker drain (`background.js` — the queue runs with no Steam tab open), the un-ignore/undo path (`ignore-log.js`, `UndoService`, the popup undo applet), the manual-ignore deferral queue (`type:'mi'` jobs drained through the rate gate), and the shared one-shot toast + storage-boundary sanitizer.

| Criterion | Score | Key note |
|-----------|-------|----------|
| **S** — Single Responsibility | 9/10 | Pure logic, DOM reading and I/O stay apart (`StatsLogic` vs `StatsManager`; `BadgeFactory`/`BadgeRenderer`/`DuplicateDetector`). New code holds the line: the widget splits into single-key controllers (`createCollapse`/`createPin`/`createSurface`/`createLoginGate`), headless orchestration (`EnqueueService`) is separated from its DOM layer, and the one-shot toast is now a presentation module of its own (`toast.js`) rather than a per-feature reimplementation. Lone outlier: `curator/main.js` still mixes CSS + DOM + menu positioning + wiring in one IIFE. |
| **O** — Open/Closed | 9/10 | New behaviour plugs in by adding a record to a strategy map (`NameExtractionStrategyProvider`, `ContainerStrategyProvider`, `DecisionEngine.strategies`); the curator filter vocabulary is one ordered list in `filters.js` that drives both the dropdown and the value→key map, so they can't drift. The queue proved the point twice: un-ignore and deferred manual-ignore arrived as new job *types* the existing drainer dispatches on, not as new drain loops. |
| **L** — Liskov Substitution | 8.5/10 | Strategies and adapters are interchangeable via a shared signature and runtime `typeof` guards in the automators. The Phase-3 worker is the strongest evidence: one unmodified `CuratorQueueDrainer` runs in a tab and in the service worker, handed two entirely different adapter sets (cookie vs cached session id, in-memory standby vs alarm) and behaving identically. Formal interfaces would require TypeScript, out of scope for vanilla-JS at this size. |
| **I** — Interface Segregation | 8.5/10 | Adapters stay minimal — `{ignore}`, `{save}`, `{get}`, and now `{reserve}` (rate gate) and the DQ registry lease — each class receives only the surface it uses. |
| **D** — Dependency Inversion | 8.5/10 | The drainer and `EnqueueService` are assembled with injected `store`/`enumerator`/`gate` deps; the DQ controller binds the registry as an adapter; `window.ILAP.*` / `chrome.*` access lives in thin adapters. Not yet pristine: `curator/main.js` free functions, `popup_queue.js` and `popup_undo.js` still reach a couple of singletons directly, and `gate.js` reads `window.ILAP.getSessionID` from inside `stopVerdict()` — a service-locator lookup the service worker satisfies by assigning that facade name at boot, so the gate works only if some host defined it first. All documented, contained debt. |

**Overall: 8.7 / 10** for SOLID structure. The scores reflect architecture only.

One tradeoff is worth stating plainly, since it is the largest structural cost in the codebase and it is deliberate: the extension runs in three isolated script worlds (content script, popup document, service worker) that cannot share a module graph, so a thin layer of storage plumbing and the ignore POST itself exists in more than one copy — about 1.5% of the source. The rule applied is graded by how many worlds a block actually spans: *pure* helpers have no excuse at all and live in exactly one file every world that needs them loads — `escape.js` for the string boundary (all three) and `stats.js` for the shape of the "Last Ignored" record (the two that write it); the Steam network **reads** span only the two worlds that fetch — the popup never talks to Steam — so they were collapsed into a single `steam-net.js` that both of them load; `chrome.*`-bound storage plumbing stays duplicated beside its consumer with a canonical note pointing at its siblings, and so does the ignore POST, where the worlds genuinely diverge (session id source, cross-origin credentials, the worker's halt counter). The distinction is not academic: every block that was consolidated had carried a "if you change this, visit the sibling" comment, and had drifted anyway. Further SOLID restructuring beyond this would amount to over-engineering for a browser extension of this scope.