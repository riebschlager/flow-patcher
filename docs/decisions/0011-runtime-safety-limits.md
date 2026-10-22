# 0011 · Safety limits live in the runtime

Status: Accepted · 2026-10-21 · Amended by [0022](0022-event-caps-on-a-fixed-grid.md) (event caps count on a fixed 120 ms grid)

## Context
"Weird is allowed; broken is not." Strange patches should give strange results, never crashes, runaway feedback, clipped output or a frozen tab.

## Decision
The runtime enforces these limits no matter what the patch asks for:

| Resource | Limit |
| --- | --- |
| Voices | 64, oldest stolen first |
| Events per window | 256 per node, 2,048 per patch; excess dropped with a warning on the node |
| Delay feedback | At most 0.42 |
| Output | Peak guard and limiter on the single Output node, which can't be removed |
| Fluid | Grid budget capped by device class |

## Consequences
- Limits are enforced in the engine and Output node, never left to the patch author.
- Exceeding a limit is visible on the node and in the budget readout, never silent.
