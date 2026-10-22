# 0021 · Transport tempo changes keep Phase continuous

Status: Accepted · 2026-10-22 · Amends [0018](0018-transport-on-a-cable.md)

## Context
ADR 0018 puts the transport on a cable and has it re-anchor where a new plan takes effect. Building it in #20 raised details 0018 left open: what a division or swing change does to Phase, when a knob change counts as taking effect, and how a modulated tempo stays independent of windowing.

## Decision
- A division change mid-beat re-anchors like a tempo change. Phase stays continuous, so from then on the ticks run off the beat grid: a switch from 1/4 to 1/16 at beat 2.2 ticks at 2.4, 2.65, 2.9, and so on.
- Phase is the even, unswung ramp through each step. Swing delays odd ticks, so a swung tick doesn't land at phase 0.
- A knob change takes effect at t0 of the first window run under the new plan.
- A modulated tempo is sampled at each tick and held until the next tick, so tick times don't depend on the windowing.
- A node's state needs to be only observably equal across window splits: every event and every read it allows must match, and state nothing can observe may differ. The transport uses this to drop anchors older than `TRANSPORT_HISTORY`, which would otherwise grow by one per tick under a modulated tempo.

Rejected: snapping a new division back to the beat grid (Phase would jump), and a Phase that resets on every swung tick (an uneven ramp for modulation).

## Consequences
- Hot patching (#22) must keep "a knob change takes effect at the new plan's first t0" true, including when a rewind replays across a plan swap.
- A tempo swept by a Signal moves in steps, one per tick, rather than continuously.
- Tests compare events and reads across window splits, not raw node state (the NodeState rule in `packages/engine/src/definition.ts`).
