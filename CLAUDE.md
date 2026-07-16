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

## Reference Documentation

The detailed developer reference is decomposed under [`docs/claude/`](./docs/claude/):

- [`claude.tech-stack.md`](./docs/claude/claude.tech-stack.md) — language, build, tests, storage, API.
- [`claude.structure.md`](./docs/claude/claude.structure.md) — full directory structure + manifest script load order.
- [`claude.architecture.md`](./docs/claude/claude.architecture.md) — global facade, module pattern, DI assembly, SOLID assessment.
- [`claude.storage-keys.md`](./docs/claude/claude.storage-keys.md) — every `ilap_*` storage key and its semantics.
