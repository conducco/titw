# Design: Routing Consolidation

**Date:** 2026-04-07
**Status:** Approved

---

## Problem

titw has two routing approaches documented side-by-side:

- **Text-pattern routing** (`SEND TO <agent>: message` regex) — in `docs/tutorial.md` and README runner examples
- **Tool-use routing** (`send_message` tool) — in `docs/tutorial-production.md`

This creates contradictions. New users copy the README examples and build fragile pipelines. The basic tutorial teaches a pattern that is explicitly known to fail with smaller/faster models (tracked in conducco/TITW#1). Text-pattern routing also breaks silently in fan-out scenarios where the auto-reply fallback routes to the wrong destination.

The investigation into `replyTo`/`defaultReplyTo` fields confirmed that `send_message` already solves the problem correctly: the `to` parameter forces the LLM to declare the destination explicitly and structurally. No new framework API is needed.

---

## Decision

Remove text-pattern routing from all docs and examples. Consolidate to one production-level tutorial. Add a standalone routing reference.

---

## Changes

### 1. `docs/tutorial.md` → deleted

The basic tutorial is replaced entirely.

### 2. `docs/tutorial-production.md` → renamed to `docs/tutorial.md`

Becomes the single authoritative tutorial. Internal changes:

- Remove the "What makes this different from the basic tutorial" comparison table (no longer relevant)
- Renumber steps: Step 4b (MCP + Skills) → Step 5, Handle shutdown → Step 6, Run it → Step 7

### 3. `README.md` — runner examples upgraded

Both the Anthropic and OpenAI runner examples replace the `SEND TO x:` regex with a concise `send_message` tool-use pattern. The examples remain illustrative (not full production code). A link to `docs/routing.md` is added at the end of each example.

### 4. `docs/routing.md` — new routing reference

A focused standalone doc covering:

1. **Why tool-use routing** — why text-pattern matching fails and what makes tool-use reliable
2. **The `send_message` tool** — schema, `to`/`content` fields, the `"user"` recipient convention
3. **Full dispatch loop** — complete implementation for Anthropic and OpenAI (tool results fed back to model)
4. **Routing patterns** — linear pipeline, fan-out (lead → multiple workers), fan-in (workers reply to lead)
5. **Common mistakes** — forgetting to return tool results, routing to `"user"` too early, infinite loops

---

## Out of Scope

- No API or interface changes
- No new `replyTo` or `defaultReplyTo` fields (redundant — `send_message.to` already solves this)
- Auto-reply fallback removal from `docs/tutorial.md` runner (already absent from the production tutorial)
- README `"in-process isolation"` language clarification (separate concern, can be a follow-up)
