# 0024 · The voice pool steals the earliest start, and a steal outlives its cause

Status: Accepted · 2026-10-22 · Amends [0011](0011-runtime-safety-limits.md) and [0019](0019-live-events-rewind.md)

## Context
ADR 0011 gives the runtime 64 voices, "oldest stolen first". #25 built that pool (packages/engine/src/audio/voices.ts) and had to settle two things 0011 doesn't say:
- Notes are scheduled up to a lookahead ahead of currentTime, so a voice is an interval that may lie in the future. A note can also arrive with a start earlier than voices already claimed. What does "oldest" mean then?
- ADR 0019 withdraws notes a rewind replaces, and ADR 0023 withdraws a swapped-out instance's notes. What happens to a voice that a withdrawn note had stolen?

## Decision
- **Oldest means earliest start.** At no instant do more than 64 claimed voices sound. A claim, or an end moved later, checks every voice start inside the time it adds. While more than 64 voices sound at such a start, the pool steals the voice with the earliest start, and the first claimed among equal starts. The stolen voice is stopped at that start, with a short fade by the node, and leaves the pool. A note claimed late, with a start earlier than voices already pooled, can be the one stolen.
- **Steals are decided when notes are scheduled, and never undone.** If the note that stole a voice is later withdrawn (ADR 0019 or 0023), its slot frees, but the voice it stole stays cut. Web Audio can't cheaply take back a scheduled stop. It also takes 64 sounding voices plus a rewind or swap for this to happen, and the cut is usually still in the future when it does.
- **Instruments keep no voice limits of their own** (docs/nodes/instruments.md). Every instrument claims from the one pool, which is per Runtime and per audio context, so hot-swapped and retiring instances share it.

## Consequences
- ADR 0019 says results depend only on event times. Steals are the exception: which voice is cut can depend on the order notes were scheduled (ties go to claim order) and on notes that were later withdrawn. The event log and goldens are unaffected, because steals change only audio.
- A note's voice can end earlier than its own envelope says. A node's `idleAt()` must use the pool's end for each voice (`VoiceHandle.end`), not its own.
- The pool keeps voices sorted by start, plus a sorted array of ends, so counting voices sounding at an instant is two binary searches. 2,048 claims in one window cost about 1 ms. The comment above `VoicePool` records the worst case found against [0016](0016-main-thread-budget.md).
- Simple Synth doesn't use the pool yet (#52). Until it does, its voices don't count toward the 64.
