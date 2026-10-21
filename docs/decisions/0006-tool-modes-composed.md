# 0006 · Flow's tool modes are composed, not built in

Status: Accepted · 2026-10-21

## Decision
Flow's Paint, Conduct, Space and Orbit modes don't ship as built-in modes, library nodes or library subpatches. People compose them from recognizers, Switch and Modifier Router.

## Consequences
- The M2 gate rebuilds the four modes as example patches in `examples/modes/`. They're there to learn from and copy; they don't appear in the node palette.
- If a mode is hard to build from nodes, fix the recognizers or add a general-purpose node. Don't add a mode-specific one.
