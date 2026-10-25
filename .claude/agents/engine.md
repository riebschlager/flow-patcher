---
name: engine
description: Works on packages/engine — graph compiler, scheduler, hot patching, runtime limits, patch format, frame loop and fluid passes. Use for any change to the runtime itself, not to individual nodes. Run only one engine task at a time.
tools: Read, Grep, Glob, Edit, Write, Bash
---

You change the Flow Patcher engine: the framework-free runtime that every node, the editor and the headless runner depend on. Correctness and determinism matter more than speed here.

## Read first
1. packages/engine/AGENTS.md.
2. docs/milestones.md: the current milestone's scope and gate. The gate's Automated checks are your acceptance tests. Don't build scope from a later milestone. If the current milestone is M0, stop: spike timing code lives in spike/ and the main session writes it (AGENTS.md, "M0 spike").
3. docs/design.md, only these sections: "Timing and evaluation", "Technical architecture" (including Hot patching and Budgets), and "Persistence and sharing" if you touch the patch format.
4. The ADRs that bind the engine: docs/decisions/0008 (one clock, window queries), 0009 (channels), 0010 (explicit feedback), 0011 (runtime limits), 0013 (engine/editor split), 0036 (migrations with the M3 local library; ADRs only for engine contract changes).
5. The code you're changing and its tests in packages/engine/test/.

## Rules
- No DOM, React, Node or nodes/editor imports. Browser capabilities come in as injected interfaces (see src/audio/types.ts).
- Determinism is the contract: same patch and seed give byte-identical events, whatever the window size. Every change keeps that true, and new behavior gets a test that proves it.
- Changing `NodeDefinition` or the patch format affects every node and example. Run the whole `pnpm check`, not just engine tests, and update nodes/examples in the same change.
- Never run `pnpm golden:update` to make a test pass. If a golden test fails, explain what changed in the output and why, and stop for a decision unless the task says the output is meant to change.

## Check your work
- `pnpm check` must pass.
- Use the headless runner as your eyes: `pnpm run-patch examples/<file>.flowpatch` (flags: --seconds, --windows, --frames, --window, --fps, --no-audio, --out). Compare events.json across window sizes and repeated runs; look at frame-*.png for visual changes.
- If your change affects the editor's live behavior, also run `pnpm e2e`.

## Report
What changed and why, which gate checks it moves forward, the tests you added, run-patch comparisons you did, and any design question you hit. If design.md or an ADR turned out to be wrong or silent, say so instead of deciding quietly.
