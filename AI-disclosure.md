# AI Disclosure

This document describes the use of AI tools in the development of this project.

## What this project contains

This is a browser extension consisting of **source code**, **icons**, and **UI assets** (images, MP4 demo clips). There is no AI-generated content delivered to the end user as part of the extension's runtime behavior.

## AI tool usage by asset type

| Asset type        | AI used | Contribution and Scope                                      |AI Tools used |
|-------------------|---------|-------------------------------------------------------------|---------- |
| Code and UI       | Yes     | AI-assisted; all logic described, reviewed and tested by dev|Gemini, Claude (code review only)|
| Extension icon    | Yes     | AI-generated base, manually processed and refined           |Imagen 4   |
| Demo video / MP4  | No      | Recorded and edited manually                                | -         |

## Appendix: SOLID assessment (Claude AI review)

Evaluated against the final source as of [date]

| Criterion | Score | Key note |
|-----------|-------|----------|
| **S** — Single Responsibility | 8/10 | `StatsLogic` / `StatsManager` correctly split into pure functions vs I/O. Each strategy class (`PageTitleStrategy`, `CssClassesStrategy`, etc.) has one job. Minor: `DiscoveryQueueAutomator` still owns both loop control and ignore logic, but the separation is pragmatic for its scope. |
| **O** — Open/Closed | 8.5/10 | `NameExtractionStrategyProvider` and `ContainerStrategyProvider` are genuinely open for extension — new strategies added without touching existing code. `DecisionEngine` replaced if/else with a strategy map, new modes add one line. |
| **L** — Liskov Substitution | 7.5/10 | Adapters (`apiAdapter`, `statsAdapter`, `nameExtractorAdapter`) are thin and interchangeable. No formal interfaces in JS, so substitutability relies on duck typing and constructor `typeof` guards. Sufficient for the runtime environment. |
| **I** — Interface Segregation | 8/10 | All adapters expose only what consumers need (`{ignore}`, `{save}`, `{get}`). `ExploreAutomator` deps object is still somewhat wide (9 keys), but each dependency is used and the grouping is intentional. |
| **D** — Dependency Inversion | 9/10 | Full DI assembly in each `main.js`. `BadgeFactory` no longer calls `chrome.runtime` directly — `iconUrl` is injected via `BadgeRenderer`. `SessionStateService` is shared from root `utils.js` and injected, not duplicated. `ResourceService` injected into UI classes. |

**Overall: 8.7 / 10**

The codebase shows consistent and deliberate application of SOLID principles, with the most mature implementation in the Dependency Inversion and Open/Closed areas. The main remaining trade-off is that `ExploreAutomator` is slightly broad in responsibility, which is a reasonable pragmatic choice given the module's scope.