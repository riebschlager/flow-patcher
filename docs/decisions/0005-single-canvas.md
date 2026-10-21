# 0005 · One canvas per patch

Status: Accepted · 2026-10-21

## Decision
A patch has exactly one performance canvas. It's the only place canvas input comes from and the only visual output.

## Consequences
- Source nodes need no canvas selector. `x` and `y` are always normalized to this canvas (0–1, y = 0 at the top).
- One Renderer per patch.
- No multi-window or multi-canvas outputs in v1.
