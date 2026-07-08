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

Evaluated against the source as of July 5, 2026 (HEAD `3065efe`), covering the additions since the June snapshot: the Phase-2 curator ignore queue (`enumerate`/`store`/`enqueue-service`/`drainer`), the aggregate ignore-rate governor (`gate.js`), and the on-page shadow-DOM widget + surface switch.

| Criterion | Score | Key note |
|-----------|-------|----------|
| **S** — Single Responsibility | 9/10 | Pure logic, DOM reading and I/O stay apart (`StatsLogic` vs `StatsManager`; `BadgeFactory`/`BadgeRenderer`/`DuplicateDetector`). New code holds the line: the widget splits into single-key controllers (`createCollapse`/`createPin`/`createSurface`/`createLoginGate`), and headless orchestration (`EnqueueService`) is separated from its DOM/toast layer. Lone outlier: `curator/main.js` still mixes CSS + DOM + toasts + wiring in one IIFE. |
| **O** — Open/Closed | 9/10 | New behaviour plugs in by adding a record to a strategy map (`NameExtractionStrategyProvider`, `ContainerStrategyProvider`, `DecisionEngine.strategies`); the curator filter vocabulary is one ordered list in `filters.js` that drives both the dropdown and the value→key map, so they can't drift. |
| **L** — Liskov Substitution | 8/10 | Strategies and adapters are interchangeable via a shared signature and runtime `typeof` guards in the automators. Formal interfaces would require TypeScript, out of scope for vanilla-JS at this size. |
| **I** — Interface Segregation | 8.5/10 | Adapters stay minimal — `{ignore}`, `{save}`, `{get}`, and now `{reserve}` (rate gate) and the DQ registry lease — each class receives only the surface it uses. |
| **D** — Dependency Inversion | 9/10 | The drainer and `EnqueueService` are assembled with injected `store`/`enumerator`/`gate` deps; the DQ controller binds the registry as an adapter; `window.ILAP.*` / `chrome.*` access lives in thin adapters. Not yet pristine: `curator/main.js` free functions and `popup_queue.js` still reach a couple of singletons directly (a documented, contained debt). |

**Overall: 8.7 / 10** for SOLID structure. The scores reflect architecture only. Further SOLID restructuring would amount to over-engineering for a browser extension of this scope.