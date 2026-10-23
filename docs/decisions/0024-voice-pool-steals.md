# 0024 · The voice pool steals the earliest start, and a steal outlives its cause

Status: Accepted · 2026-10-22 · Amends [0011](0011-runtime-safety-limits.md) and [0019](0019-live-events-rewind.md) · Amended by [0025](0025-voice-steals-warn-and-stay-in-budget.md) (steals warn and are counted; new cost numbers; Simple Synth uses the pool)

## Context
ADR 0011 gives the runtime 64 voices, "oldest stolen first". #25 built that pool (packages/engine/src/audio/voices.ts) and had to settle two things 0011 doesn't say:
- Notes are scheduled up to a lookahead ahead of currentTime, so a voice is an interval that may lie in the future. A note can also arrive with a start earlier than voices already claimed. What does "oldest" mean then?
- ADR 0019 withdraws notes a rewind replaces, and ADR 0023 withdraws a swapped-out instance's notes. What happens to a voice that a withdrawn note had stolen?

## Decision
- **Oldest means earliest start.** At no instant do more than 64 claimed voices sound. A claim, or an end moved later, checks every voice start inside the time it adds. While more than 64 voices sound at such a start, the pool steals the voice with the earliest start, and the first claimed among equal starts. The stolen voice is stopped at that start, with a short fade by the node, and leaves the pool. A note claimed late, with a start earlier than voices already pooled, can be the one stolen.
- **Steals are decided when notes are scheduled, and never undone.** If the note that stole a voice is later withdrawn (ADR 0019 or 0023), its slot frees, but the voice it stole stays cut. Undoing a steal would mean putting the voice back in the pool, which could push a later start over 64 again and start another round of steals. It rarely matters: it takes 64 sounding voices plus a rewind or swap.
- **Instruments keep no voice limits of their own** (docs/nodes/instruments.md). Every instrument claims from the one pool, which is per Runtime and per audio context, so hot-swapped and retiring instances share it.

## Consequences
- ADR 0019 says results depend only on event times, never on when the scheduler woke. Steals are the exception. Which voice is cut can depend on the order notes were claimed and on notes that were later withdrawn, and both depend on how far the scheduler had queried when a tap or swap arrived. A note scheduled late also starts its voice at currentTime, not at its event time. So the audio of a performance and of its replay can differ where the pool is full. The event log and goldens can't, because steals change only audio.
- A note's voice can end earlier than its own envelope says. A node's `idleAt()` must use the pool's end for each voice (`VoiceHandle.end`), plus its own steal fade if the voice was stolen.
- The pool keeps voices sorted by start, plus a sorted array of ends, so counting voices sounding at an instant is two binary searches. 2,048 claims in one window cost about 1 ms. The worst case found, 1,024 short notes and then 1,024 long ones in one window, costs about 9 ms. That is over [0016](0016-main-thread-budget.md)'s ~4 ms budget, once, for a patch already at both event budgets. Accepted for now, and #54 brings it under.
- Steals are silent for now, although ADR 0011 says exceeding a limit is never silent: no warning, counter or readout reports them. #54 adds a warning and a readout.
- Simple Synth doesn't use the pool yet (#52). Until it does, its voices don't count toward the 64.
