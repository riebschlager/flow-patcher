# 0023 · A hot swap re-runs the lookahead from the next window boundary

Status: Accepted · 2026-10-22

## Context
design.md (Hot patching) says the scheduler swaps plans "at the next window boundary", that state survives by node id, and that future events from removed or changed nodes are cancelled. It doesn't say which boundary: the scheduler has already queried up to 120 ms ahead (1.25 s hidden), so the next unqueried boundary is the horizon, and a swap there would have nothing future to cancel and up to a lookahead of edit latency. ADR 0021 adds that a knob change takes effect at t0 of the first window under the new plan, including when a rewind (ADR 0019) replays across the swap. #22 had to settle these.

## Decision
- **When.** A swap takes effect at the first retained window boundary at or after currentTime: the start of the earliest window already queried that hasn't begun to play. With nothing queried past now, it takes effect at the horizon. Every window from the swap time to the horizon runs again under the new plan, the way a rewind re-runs them: the nodes the edit added or changed and everything downstream of them re-run; the rest keep what they emitted; audio deliveries are diffed, so only what changed is cancelled and re-sent. Edit latency is at most one wake interval (25 ms while the page is visible; a hidden tab wakes less often).
- **Each window remembers its plan.** A rewind replays every window under the plan it ran under, so the old plan runs up to the swap and the new one from it. Crossing into the new plan's first window applies the swap's own state changes (nodes started fresh, removed nodes' held delay inputs dropped). When a swap takes effect at the same time as the plan before it (two swaps to one boundary, or two at the horizon before a query), that plan never ran a window of its own, so the new plan takes over its state changes too. Clock compares knobs in its state and so re-anchors exactly at the swap.
- **Log order.** Events at one time and channel order by plan position in the plan in force at that time, so a swap that reorders the plan reorders only what comes after it, and a rewind never changes the order.
- **State.** Nodes match by id. A surviving node keeps its state object unless its type or version changed, or its definition's optional `keepState(before, after)` returns false; then it starts empty at the swap. Added nodes start empty; a removed node's state is dropped. Event-cap counts stay with the id.
- **Removed and changed nodes.** Their logged events from the swap on are replaced; live events pushed onto a removed or retyped node from the swap on are dropped.
- **Audio.** An audio node whose type, params, seed or param cables changed gets a new instance; a removed node's goes too. The old instance has what it was handed from the swap on cancelled (`cancel()`, as in ADR 0019) and is disposed once currentTime passes both the swap and its optional `idleAt()`, so sounding notes finish their release. Audio cables are rewired when the swap is made, at currentTime, not at the swap time: Web Audio can't schedule connect() or disconnect(). An output that loses a cable is disconnected and reconnected; one that only gains cables is just connected.
- **Edits.** The runtime takes a whole compiled plan (`Runtime.swap`, `Scheduler.swap`) and works out the diff itself. `PatchEdit` / `applyPatchEdits` (engine/src/edit.ts) build the next document for scripted edits (`<name>.edits.json` in tools/); it isn't a wire format.

Rejected:
- **Swap at the horizon.** Simplest, but a knob turn is heard up to 120 ms late (1.25 s hidden), and there is never anything future to cancel, which design.md expects.
- **Swap at the edit's exact time** (splitting a window there). Edits would be window-independent, but it needs a mid-window snapshot and design.md asks for a boundary.
- **One plan for the whole history.** A rewind restoring a snapshot from before a swap would run the new params early and re-anchor Clock at the replay's start.

## Consequences
- A run with edits is deterministic for one wake schedule, but not window-independent: the swap time depends on where boundaries fall. A recording of a performance with edits (M4) must record each swap's time, not the edit's.
- A swap costs a re-run of up to the lookahead for the edited nodes and those downstream, and a recompile; a knob drag pays it per change.
- Changing Output's level rebuilds the Output stage and disposes the old one at once (it has no `idleAt`), restarting the limiter. An in-place `update` hook for audio instances may be worth adding once a real glitch shows up.
- A live event stamped before a swap, on a node the swap adds, is lost: the node doesn't exist yet at that time.
- Audio cables switch at the edit, up to one wake interval before the swap time, so a note the old plan already scheduled in that gap plays through the new wiring (or not at all, on a removed cable). Sounding notes on a removed cable stop when it is disconnected; there is no fade.
