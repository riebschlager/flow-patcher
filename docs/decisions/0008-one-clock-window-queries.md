# 0008 · One audio clock and pure window queries

Status: Accepted · 2026-10-21 · Amended by [0017](0017-immediate-offset-and-catch-up.md) (5 ms offset, catch-up for late wakes)

## Context
Flow's `ArpEngine` and `RhythmEngine` each own a `setInterval` timer and decide and schedule notes in the same loop. That makes timing hard to reason about, hard to test and hard to hot-patch. Every other engine choice depends on this one.

## Decision
- One clock: the Web Audio clock.
- One scheduler wakes every 25 ms and asks the graph for events from `now` to `now + 120 ms` (1.25 s while the tab is hidden). Stalls skip missed windows instead of bursting them.
- Event nodes implement `query(t0, t1, inputs) → events[]`. They're pure: generators compute their events from absolute time.
- Live input takes an immediate path. Events are stamped `ctx.currentTime + ~10 ms` and pushed through the same node code with a zero-width query, without waiting for the scheduler.
- Visual nodes run on the frame clock and read the events whose timestamps fall in each frame.
- All randomness comes from seeded RNGs.

## Consequences
- Nodes never own timers: no `setInterval`, `setTimeout` or `requestAnimationFrame` in node code. No `Math.random` anywhere in engine or nodes.
- The same patch and seed always produce the same events, so a performance recording is just the patch plus its input streams.
- Tests can check window independence: querying in 25 ms steps or all at once gives identical events.
- `ArpEngine` and `RhythmEngine` are rewritten as pure query nodes, not borrowed.
