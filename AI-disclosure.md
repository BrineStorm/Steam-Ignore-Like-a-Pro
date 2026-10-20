# AI Disclosure

This document describes the use of AI tools in the development of this project.

## What this project contains

This is a browser extension consisting of **source code**, **icons**, **UI assets** (images, GIF demo clips), and **store/promotional graphics** (screenshots, marquee, tile). There is no AI-generated content delivered to the end user as part of the extension's runtime behavior.

## AI tool usage by asset type

| Asset type        | AI used | Contribution and Scope                                      |AI Tools used |
|-------------------|---------|-------------------------------------------------------------|---------- |
| Code and UI       | Yes     | AI-assisted. All logic described, reviewed and tested by dev|Gemini, Claude|
| Translations      | Yes     | Interface and store listings AI-translated from English into 18 languages. The interface was then rechecked with AI and non-AI translation tools |Gemini, Claude|
| Extension icon    | Yes     | AI-generated base, manually processed and refined           |Imagen 4   |
| Demo GIFs         | Yes     | Recorded with Claude, edited manually                       | Claude    |
| Store / promo art | Yes     | The first edition was made by hand and reimagined later in Claude Design | Claude (Design) |

## SOLID assessment (Claude AI review)

Evaluated against the source as of October 20, 2026 (release 1.3.2). The scores are unchanged since the 1.3.0 assessment.

| Criterion | Score | Key note |
|-----------|-------|----------|
| **S** — Single Responsibility | 9/10 | Pure logic, DOM reading and I/O stay apart (`StatsLogic` vs `StatsManager`, `BadgeFactory`/`BadgeRenderer`). The widget is split into single-key controllers, and the latest splits follow the same line with `game-name.js`, `lease.js` and the Manual Ignore helpers. The lone outlier is `curator/main.js`, which still mixes CSS, DOM, menu positioning and wiring. |
| **O** — Open/Closed | 9/10 | New behaviour plugs in as a new record, as in `DecisionEngine.strategies` and the drainer's policy table, where each job type is one entry. A Steam repaint is a data edit in `steam-palette.js`. The exception is `ContainerStrategyProvider`, whose strategy list is fixed in its constructor. |
| **L** — Liskov Substitution | 8.5/10 | Strategies and adapters are interchangeable through a shared signature. One unmodified `CuratorQueueDrainer` runs in a tab and in the service worker with two entirely different adapter sets and behaves identically. Formal interfaces would need TypeScript. |
| **I** — Interface Segregation | 9/10 | Adapters stay minimal, such as `{ignore}`, `{save}`, `{reserve}` and `{check}`. The Classic Discovery Queue automator gets its settings in its own terms through `QueueSettings`, and the Discovery Queue gets a userdata reader in place of an API adapter. |
| **D** — Dependency Inversion | 8.5/10 | Each `main.js` and the service worker assemble the object graph and hand collaborators in as adapters, and settings come from one schema. A few places still reach for defaults of their own, such as the gate's session check, the fixed container list, the popup's queue and undo panels and the two small page-load scripts new in 1.3.2. It is documented debt, contained within one world. |

**Overall: 8.8 / 10** for SOLID structure. The scores reflect architecture only.

One tradeoff is deliberate. The extension runs in three isolated script worlds (content script, popup, service worker) that cannot share modules, so a few dozen lines of storage plumbing and the ignore request's `fetch` exist in more than one copy, well under 1% of the source code. Everything that can live in one shared file already does. Further restructuring would be over-engineering for an extension of this size.
