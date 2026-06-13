# AI Disclosure

This document describes the use of AI tools in the development of this project.

## What this project contains

This is a browser extension consisting of **source code**, **icons**, and **UI assets** (images, MP4 demo clips). There is no AI-generated content delivered to the end user as part of the extension's runtime behavior.

## AI tool usage by asset type

| Asset type        | AI used | Contribution and Scope                                      |AI Tools used |
|-------------------|---------|-------------------------------------------------------------|---------- |
| Code and UI       | Yes     | AI-assisted; all logic described, reviewed and tested by dev|Gemini, Claude|
| Extension icon    | Yes     | AI-generated base, manually processed and refined           |Imagen 4   |
| Demo video / MP4  | No      | Recorded and edited manually                                | -         |

## Appendix: SOLID assessment (Claude AI review)

Evaluated against the source as of June 9, 2026 (HEAD `3a105eb`)

| Criterion | Score | Key note |
|-----------|-------|----------|
| **S** — Single Responsibility | 9/10 | Classes own one concern each — pure logic, DOM reading and I/O are kept apart (`StatsLogic` vs `StatsManager`; `BadgeFactory`/`BadgeRenderer`/`DuplicateDetector`). Larger orchestrators deliberately group adjacent steps for readability. |
| **O** — Open/Closed | 9/10 | New behaviour plugs in by adding a record to a strategy map (`NameExtractionStrategyProvider`, `ContainerStrategyProvider`, `DecisionEngine.strategies`) — no edits to existing code. |
| **L** — Liskov Substitution | 8/10 | Strategies and adapters are interchangeable via a shared signature and runtime `typeof` guards in the automators. Formal interfaces would require TypeScript, which is out of scope for vanilla-JS at this size. |
| **I** — Interface Segregation | 8.5/10 | Adapters stay minimal (`{ignore}`, `{save}`, `{get}`); each class receives just the surface it actually uses. |
| **D** — Dependency Inversion | 9.5/10 | Business classes receive their collaborators through DI; direct `window.ILAP.*` / `chrome.*` access is contained in thin adapters, never inside business logic. |

**Overall: 8.8 / 10** for SOLID structure. The scores reflect architecture only. Further SOLID restructuring would amount to over-engineering for a browser extension of this scope.