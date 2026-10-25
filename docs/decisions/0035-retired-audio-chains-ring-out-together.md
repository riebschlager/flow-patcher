# 0035 · A retired audio chain rings out together

Status: Accepted · 2026-10-25 · Amends [0023](0023-hot-swap-reruns-from-next-boundary.md)

## Context
ADR 0023 disposes a retired audio instance once currentTime passes the swap and its own `idleAt()`. Retiring instances keep their connections (so their notes sound out), and an effect's `idleAt` counts its tail from the last chunk it was automated. That works when only the effect is rebuilt: its upstream moves to the new instance. It fails when the upstream retires too (#115). A seed change rebuilds every audio node, Output included, and Output has no `idleAt`, so the old Output was disposed at the swap and took the whole old chain with it: Delay (0.5 s, feedback 0.42) → Reverb (Decay 1) → Output went silent at the swap, mid-echo. Even with Output kept, the old Delay feeds the old Reverb past the Reverb's own `idleAt`, which cuts the echo train about a second later.

## Decision
- **Upstream holds.** A retired instance stays while any retiring instance upstream of it (through retiring connections, transitively, swaps of any age) is still alive. Live instances never hold one: rewiring moves their cables to the new instances.
- **Tails count from the upstream's disposal.** When an instance is disposed at `now`, every retiring instance downstream of it gets `inputsEnd = now` (the latest such time). `AudioInstance.idleAt(inputsEndAt)` takes it: an effect counts its tail from `max(last chunk covered, inputsEndAt)`. A node with no Audio input ignores it. An instance without `idleAt` (Output, Gain, Filter) is idle at `inputsEnd`, so it goes in the same call as the last instance feeding it. Disposal time, not the upstream's computed `idleAt`, is the measure: it is when its connection really ends, and later by at most one wake per link.
- **One hook, an argument.** Rejected: a separate `tail()` duration next to `idleAt()`. The runtime would compute `max(idleAt(), inputsEnd + tail())`, which is the same for Reverb and Delay, but the node is better placed to say how its state turns an input end into silence, and the existing hook stays the only one to implement.
- **Audio cycles go together.** Instances that feed each other (a strongly connected group; audio cycles are legal, ADR 0010 covers events only) don't hold each other. The group is held by what is upstream of it, then disposed in one call once every member is past `idleAt(inputsEnd)`. Disposing one member early would cut the others' path through it. What the loop would add past every member's own tail is cut: with feedback around the loop, the true tail has no bound the runtime can know, and retired instances must not live forever.
- Disposal is checked in `retain` (every wake), upstream groups first, so a chain whose members are idle can end in one call.

## Consequences
- A seed change mid-echo, or any swap that retires a chain, sounds out the old chain sample for sample as if nothing changed until its tail is over (tools/offline-audio.test.ts, "a seed change mid-echo").
- A retired chain costs its Web Audio nodes for as long as its longest path of tails: a Delay (0.5 s, feedback 0.42) into an 8 s Reverb keeps both for up to about 13 s after the last note's release. Each swap that retires a chain adds one; a run of seed changes stacks them.
- The old and new Output both play into the destination while the old one rings out, each with its own limiter, so their sum can pass the Output ceiling while both are loud. A seed change rebuilds Output although it reads no seed; keeping it would avoid this and is a possible follow-up.
- Disposal times depend on wake times (up to one wake per link). They are not part of the event log, so determinism is unaffected.
