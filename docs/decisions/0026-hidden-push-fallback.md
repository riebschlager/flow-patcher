# 0026 · A hidden push over budget applies from the horizon; a live event whose re-run throws is dropped

Status: Accepted · 2026-10-22 · Amends [0019](0019-live-events-rewind.md)

## Context
ADR 0019 rewinds for every live event and leaves a fallback for when the re-run costs too much: "apply live state changes from the next window and accept that replays may differ". #41 built it. Two things shaped it.

What a push's rewind costs (M-series laptop, Node 24, 350 pushes per row on real nodes: Pointer into Probability chains with Clocks feeding them, Make Note into an audio node; `PushCost.ms`, over three runs). `pnpm exec tsx tools/bench-push.ts` reproduces it, with the estimate the hidden budget compares:

| Patch | Visible: median / max | Hidden: median / max | Hidden estimate |
| --- | --- | --- | --- |
| Pointer → 3 nodes | 0.05 / 0.2 ms | 0.05 / 0.4 ms | ≤ 0.11 ms |
| Chain of 20 | 0.13 / 0.8 ms | 0.2 / 0.6 ms | ≤ 0.3 ms |
| 122 nodes | 0.6 / 1.4 ms | 1.25 / 2 ms | ≤ 1.45 ms |
| 132 nodes, 10 ms Delay Edge | 1.15 / 3.5 ms | 8.5 / 22 ms | 6.9–11.5 ms |
| 392 nodes, 10 ms Delay Edge | 3.7 / 6.6 ms | 27 / 60 ms | 22–64 ms |
| 31 nodes, 8 fast Clocks | 0.5 / 1 ms | 3.3 / 8.6 ms | ≤ 4.5 ms |

Every next boundary is later than the tap: the horizon is up to the lookahead away (120 ms visible, 1.25 s hidden), and the first retained boundary at or after now (as swaps use, ADR 0023) up to a wake interval. A visible fallback would therefore break the immediate path (currentTime + 5 ms, ADR 0017) on exactly the heaviest patches, while visible rewinds stay near [0016](0016-main-thread-budget.md)'s ~4 ms except on extreme patches. Hidden rewinds cost far more, since they re-run up to 1.25 s, but a hidden page has no pointer input waiting on the main thread.

Separately, a node whose `query()` threw during a rewind left the live event injected and its re-run half done, so every later rewind through it threw again.

## Decision
- **Visible pushes always rewind** fully, as ADR 0019 says, whatever they cost.
- **Hidden pushes have a budget**, `SchedulerOptions.hiddenPushBudgetMs`, default 16 ms *(tune)*, checked before rewinding so nothing needs undoing. The estimate is `Runtime.rewindCost` (the queries the rewind would make: affected and followed query nodes times the chunks from the restored snapshot to the horizon) times a smoothed ms per query (each rewind's ms / queries, weight 0.2). Hidden and visible keep separate averages: a query costs up to 13× more hidden, where windows are wider. With no hidden rewind measured yet, a push rewinds and seeds the average. Queries alone can't be the budget: their cost ranged from 0.6 to 78 µs across the rows above. Within one mode the estimate was within 0.8–1.3× of the real cost from the 5th to the 95th percentile.
- **Why 16 ms.** Every row but the 392-node fan stays under it, so none of them fall back, and a MIDI note into a hidden tab keeps its timing. The 392-node fan falls back on every hidden push. A hidden page has no taps waiting, so a long hidden task delays nobody's input. The budget bounds the estimate, not the task: the 132-node fan, estimated at 6.9 to 11.5 ms, still ran up to 22 ms once (a GC pause or a burst of events), so a pointerdown right after the page comes back can wait longer than 16 ms. At 4 ms the 132-node fan would fall back on every hidden push, and the 8-Clock patch on some, their notes up to 1.25 s late, to save tasks nobody is waiting on.
- **Over budget, the push applies from the horizon,** the first unqueried boundary, so it re-queries nothing: the event's time becomes the horizon, and `push` wakes the scheduler. That wake queries the window covering the event only if the clock has moved since the horizon was set. When it hasn't, nothing is queried, and the next timer wake (about a second later while hidden) queries and delivers it, still ahead of its time. That happens for a second hidden push before the clock moves, and for pushes held while the audio clock was suspended: the resume wake queries to now + 1.25 s and then replays them, so with a hidden average over budget they all land at that horizon, 1.25 s after the resume. It is counted in `SchedulerStats.pushFallbacks`, reported in `PushCost.fallback` (`stamped`, `estimatedMs`), and raised as a `push-fallback` warning on the pushed node through `onWarning` and `warnings()`, its count the pushes applied late.
- **The applied time is the event's time.** `Scheduler.push` returns it, and the log, audio and frames all carry it. A recorded input stream (M2) stores the returned events, so a replay pushes the event at the horizon time and gets the same events. Whether a push falls back also depends on the wall-clock cost measured on the machine that ran it, so a slower machine, or the same one under load, can apply the same live input at a different time. Only the recorded applied times replay exactly.
- **"Same events whatever the wake timing" breaks only for hidden pushes over budget.** The horizon depends on when the scheduler last woke, so the same tap can land at different times. Visible pushes, and hidden pushes under budget, keep 0019's property.
- **A live event whose re-run throws is dropped.** It comes out of the injected events, and the nodes are restored and re-run again without it. Node state, cap counts and dismissed cap credits, the log, and deliveries to audio nodes with `cancel()` end up as without the event: what the failed re-run had sent is withdrawn by the usual cancel-and-resend diff. Some side effects of the failed re-run can't be taken back; see Consequences. The node that threw gets a `rewind-error` warning with the error's message, or the pushing node when the one that threw is only in an older plan. `RuntimeCounters.droppedPushes` counts it, and `RewindReport.dropped` (so `PushCost.rewind.dropped`) names the node that threw. The scheduler still updates its stats and calls `onPush`. If the re-run without the event throws too, the node fails whatever the event, and that error propagates as before.

## Consequences
- A replay of a performance with hidden fallbacks matches only if its input stream holds the applied times, not the stamps. M2's format should record what `Scheduler.push` returns.
- Visible rewinds can pass ~4 ms on extreme patches (6.6 ms at worst above). If that ever matters, the next step is a time-sliced rewind: re-run the window holding the tap first, so it sounds on time, and the later windows in follow-up tasks, each finished before its window plays. Results then still depend only on event times.
- The budget assumes hidden pushes are rare (MIDI into a background tab), so the hidden average may be stale. A single misprediction makes one push late or one task long, not a run of them.
- A live event can now vanish. The editor shows the `rewind-error` warning like any other.
- What a dropped event's failed re-run leaves behind: an audio node without `cancel()` keeps playing what it was sent, and its withdrawals count twice in `uncancelled` and its `no-cancel` warning; voice steals stay (0024, 0025); a cap warning the failed re-run raised has already reached `onWarning` before the retry settles it away; `delivered` and `cancelled` count both re-runs; and frame-queue entries trimmed at FRAME_QUEUE_LIMIT aren't put back. Each needs a throwing node plus a live event, so they are documented rather than fixed.
