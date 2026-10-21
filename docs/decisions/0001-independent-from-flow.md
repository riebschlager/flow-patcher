# 0001 · Independent from Flow

Status: Accepted · 2026-10-21

## Context
Flow is an existing app with a lot of reusable code: music theory, rhythm, voices, effects, the fluid solver and renderers. Flow Patcher is a hobby project with no users yet, so there is nothing to stay compatible with.

## Decision
Flow Patcher is a separate project. It doesn't read or write `.flow` files, and nothing has to match Flow's output. Flow is a source of code to borrow. Borrowed code becomes this project's code, and we change it as much as we need to.

## Consequences
- Borrow any Flow module that saves work, and bring its tests along. Golden files are generated in this repo and change with the code.
- No test compares against Flow's files, sessions or renders.
- Don't add shims, adapters or file importers for Flow compatibility. Keeping a Flow module's API unchanged is not a goal.
- M3 ("Flow as a patch") checks whether the node set can express Flow. It's judged by feel, not by output parity.
