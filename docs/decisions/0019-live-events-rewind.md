# 0019 · Live events rewind and re-query

Status: Accepted · 2026-10-21 · Amended by [0024](0024-voice-pool-steals.md) (a withdrawn note doesn't undo the voice it stole); [0026](0026-hidden-push-fallback.md) (hidden pushes over budget apply from the horizon; a live event whose re-run throws is dropped)

## Context
Immediate-path events are stamped `ctx.currentTime + 5 ms` ([ADR 0017](0017-immediate-offset-and-catch-up.md)), while the scheduler has already queried up to 120 ms ahead. A node fed by both a Clock and live input therefore sees time go backwards. Stateless nodes don't care; a stateful one, such as an Arpeggio's position or a Divide's count, has already advanced past the tap's time. [spike-notes.md](../spike-notes.md) (item 3) left the ordering open for M1.

## Decision
- The engine snapshots each stateful node's state at window boundaries.
- When an immediate event lands at time t, the engine restores the latest snapshot before t, replays the affected downstream nodes from that boundary up to t to rebuild their state (discarding what they emit there, which is already scheduled or played), then re-runs them from t to the scheduler's horizon with the event included.
- Events those nodes had already scheduled after t are cancelled and replaced by the re-run's events.
- Results depend only on event times, never on when the scheduler happened to wake.

Implementation note (#19): the snapshot restored is the latest at or before t. Signal, Value and param sources upstream of the affected nodes, outside them, are restored and re-queried in each re-run chunk for their state only, so the affected nodes read them as they were at that time; the events those sources emit are not replaced, logged again or re-delivered.

Rejected:
- **Per-node handling.** Every stateful node would need its own merge logic, each with its own subtle bugs.
- **Separate state per path,** merged by time. The two paths never see each other, so a tap can't move an arpeggio that the Clock is driving.
- **Applying live state changes from the next window.** Simple, but the result depends on wake timing, so a replay can differ from the performance.

## Consequences
- Recordings replay exactly: the same patch, seed and input stream give the same events (M2's input stream format, M4's recordings).
- Node authors write nothing special, but node state must be cloneable plain data: no closures, class instances or handles to audio or GPU objects.
- A re-run costs time on the immediate path and counts against the tap budget. If it breaks that budget, the fallback is to apply live state changes from the next window and accept that replays may differ.
