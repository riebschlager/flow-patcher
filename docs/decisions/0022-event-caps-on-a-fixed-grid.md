# 0022 · Event caps count on a fixed 120 ms grid

Status: Accepted · 2026-10-22 · Amends [0011](0011-runtime-safety-limits.md)

## Context
ADR 0011 caps events at 256 per node and 2,048 per patch "per window", without saying what a window is. The scheduler's windows vary: wakes run late, catch up, stall, and look ahead 1.25 s while the tab is hidden, and a live event rewinds and re-queries (ADR 0019). Counting per queried window would make which events drop depend on wake timing.

## Decision
- The caps count per limit window: a fixed grid of 120 ms slices of the audio clock, `[k × 0.12, (k + 1) × 0.12)`. 120 ms is the scheduler's lookahead.
- A node keeps its first 256 events per slice (all output ports together, in log order) and drops the rest. Of those, the patch keeps at most 2,048 per slice, taken in the order nodes run. Dropped events never reach downstream nodes, the log, frames or audio, and the node shows a warning.
- Caps apply to an event's computed time, before a catch-up shifts it.
- The runtime enforces the caps (`packages/engine/src/limits.ts`), not the scheduler.

## Consequences
- The node cap is window-independent: it depends only on the node's own event times, and a rewind restores each node's count with its state.
- The patch cap is not window-independent once it binds: which node loses events then depends on where chunks fall. It is still deterministic for one sequence of queries and pushes, and it can't bind with 8 or fewer emitting nodes. Making it independent would need a second pass over every slice; not worth it for a safety limit.
- The caps bound events per slice of computed time, not per stretch of audio time. A 120 ms stretch that isn't aligned to the grid can hold two slices' worth, and a catch-up (up to 100 ms, ADR 0017) moves earlier events into it too, so audio may see up to three slices' worth in 120 ms: 768 events from one node, 6,144 from the patch. Tune the limits against that peak.
- A stall's skipped windows count nothing, so the rest of a slice a stall cut into may keep events a full run would have dropped.
- 256 per 120 ms is about 2,100 events a second per node and about 17,000 per patch. Whether that's tight enough to protect Web Audio hasn't been measured; the limits stay *(tune)*.
