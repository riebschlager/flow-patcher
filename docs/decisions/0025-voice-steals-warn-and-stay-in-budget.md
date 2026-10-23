# 0025 · A voice steal warns on the node whose note caused it, and the pool's worst case fits the main-thread budget

Status: Accepted · 2026-10-22 · Amends [0024](0024-voice-pool-steals.md)

## Context
ADR 0024 left two things open for #54. Steals were silent, although [0011](0011-runtime-safety-limits.md) says exceeding a limit is never silent. And its worst case, 1,024 short notes and then 1,024 long ones in one window, cost about 9 ms against [0016](0016-main-thread-budget.md)'s ~4 ms. Measuring it again found a worse shape of the same case: with the long notes on the same starts as the short ones, it cost 66 ms, because every long claim swept every later short start.

## Decision
- **A steal is a warning on the node whose note caused it.** That is the node whose claim, or later end, pushed the pool past 64: `voice-steal` in `Runtime.warnings()`, raised through `onWarning` the first time and again after `clearWarnings`. Its `count` is the voices stolen since it was raised, its `time` the latest cut. The node whose voice was cut gets no warning: the cause is the note that came in over the limit, and the victim is often the same node.
- **Steals are counted, and never taken back.** `RuntimeCounters.voiceSteals` counts every steal on every context the runtime attached to. `Runtime.voiceStats()` gives `{ inUse, limit, steals, byNode }` for the budget readout (#32): `byNode` keeps nodes in the latest plan, by the same owner as the warning. Unlike a cap drop, a steal stays when a rewind or swap withdraws the note that caused it (0024), so the warning and counts aren't net of rewinds. A removed node's retiring notes still count toward `steals` but raise nothing.
- **Nodes see the pool through a per-node view.** `AudioSetupContext.voices` is a `Voices` (the pool's claim, release, setEnd, inUse and size), which the runtime builds with `VoicePool.forNode(id)` so it knows each claim's node. `VoicePool.claim` takes an optional owner; the rest of the API is unchanged.
- **The pool's cost stays under ~4 ms at both event budgets.** Which voice is stolen doesn't change. The sweep that checks each start inside a claim's time jumps past starts that can't be over (one steal fixes every start up to the stolen voice's old end; with `room` slots free, the next `room` starts can't be full), and a steal remembers how far its search for the first voice still sounding got. On an M-series laptop (Node 24, medians of 30 runs, five sessions), 2,048 claims in one window take: 0.4 ms for 0024's case (was 3.9 ms here, 9 ms as 0024 measured it), about 1 ms with the long notes on the short ones' starts (was 66 ms), 1.8 to 3.3 ms claimed latest start first, and 3.1 to 3.5 ms, 3.9 at worst, with short notes 60 deep claimed latest start first, the worst found.
- **Simple Synth claims from the pool too** (#52), so 0024's "its voices don't count toward the 64" no longer holds: every instrument's voices count.

## Consequences
- The worst case is under budget on the laptop, but only just. A slower device, such as the Surface, will likely pass 4 ms in that one shape, once, for a patch already at both event budgets. If that matters, the next step is a range-max structure over the starts, so a claim doesn't sweep every start it covers.
- The editor shows a steal like any other node warning; #32 adds voices in use and steals to the budget readout from `voiceStats()`.
- The randomized test compares the pool against a plain scan at pool sizes 4 and 16, so the shortcuts are checked against the rule, not just timed.
