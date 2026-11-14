# AI Disclosure

This document describes the use of AI tools in the development of this project.

## What this project contains

This is a browser extension consisting of **source code**, **icons**, **UI assets** (images, GIF demo clips), and **store/promotional graphics** (screenshots, marquee, tile). There is no AI-generated content delivered to the end user as part of the extension's runtime behavior.

## AI tool usage by asset type

| Asset type        | AI used | Contribution and Scope                                      |AI Tools used |
|-------------------|---------|-------------------------------------------------------------|---------- |
| Code and UI       | Yes     | AI-assisted. All logic described, reviewed and tested by dev|Gemini, Claude|
| Translations      | Yes     | Interface and store listings AI-translated from English into 23 languages. The interface was then rechecked with AI and non-AI translation tools |Gemini, Claude|
| Extension icon    | Yes     | AI-generated base, manually processed and refined           |Imagen 4   |
| Demo GIFs         | Yes     | Recorded with Claude, edited manually                       | Claude    |
| Store / promo art | Yes     | The first edition was made by hand and reimagined later in Claude Design | Claude (Design) |

## SOLID assessment (Claude AI review)

Evaluated against the source as of November 8, 2026 (release 1.4.0).

| Criterion | Score | Key note |
|-----------|-------|----------|
| **S** — Single Responsibility | 8.5/10 | Pure logic, DOM reading and I/O stay apart (`StatsLogic` vs `StatsManager`, `QueueRows` vs the queue drawer). Hosts sit in files of their own, apart from what they host (`drainer-host.js`, `ignore-manager.js`, the curator button's `menu.js` and `button-style.js`), and `BadgeRenderer` draws the badge alone, next to `AiMarks` and `SteamFlagTint`. The largest remaining piece is `_drainJob`, one loop of about 140 lines with its branches pinned by unit tests. |
| **O** — Open/Closed | 9/10 | New behaviour plugs in as a new record. Each job type is one entry in the drainer's policy table, one row in the queue panel and one in the recent history, and the container strategies, the decision strategies and the Steam palette are data too. |
| **L** — Liskov Substitution | 9/10 | Strategies and adapters are interchangeable through a shared signature, and collaborators are checked by name at construction. One unmodified `CuratorQueueDrainer` runs in a tab and in the service worker with two entirely different adapter sets and behaves identically. Formal interfaces would need TypeScript. |
| **I** — Interface Segregation | 8.5/10 | Adapters stay minimal, such as `{ignore}`, `{save}`, `{reserve}` and `{check}`, and the composition root hands each popup panel only the members it names. The Classic Discovery Queue automator gets its settings in its own terms through `QueueSettings`. The drainer takes the whole queue store, since a narrower port would only restate about fifteen members. |
| **D** — Dependency Inversion | 9/10 | Each `main.js`, `popup_main.js`, `drainer-host.js` and the service worker assemble the object graph and hand collaborators in as adapters, and settings come from one schema. The exceptions are documented, such as the gate's session check, two thin Steam read helpers and the small page-load scripts, each contained within one world. |

**Overall: 8.8 / 10** for SOLID structure. The scores reflect architecture only.

One tradeoff is deliberate. The extension runs in three isolated script worlds (content script, popup, service worker) that cannot share modules, so a few dozen lines of storage plumbing and the ignore request's `fetch` exist in more than one copy, well under 1% of the source code. Everything that can live in one shared file already does. Further restructuring would be over-engineering for an extension of this size.
