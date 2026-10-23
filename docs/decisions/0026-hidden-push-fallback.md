# 0026 · A hidden push over budget applies from the horizon; a live event whose re-run throws is dropped

Status: Accepted · 2026-10-22 · Amends [0019](0019-live-events-rewind.md)

## Context
ADR 0019 rewinds for every live event and leaves a fallback for when the re-run costs too much: "apply live state changes from the next window and accept that replays may differ". #41 built it. Two things shaped it.

What a push's rewind costs (M-series laptop, Node 24, 350 pushes per row on real nodes: Pointer into Probability chains with Clocks feeding them, Make Note into an audio node; `PushCost.ms`):

| Patch | Visible: median / max | Hidden: median / max |
| --- | --- | --- |
| Pointer → 3 nodes | 0.05 / 0.2 ms | 0.05 / 0.4 ms |
| Chain of 20 | 0.13 / 0.8 ms | 0.2 / 0.6 ms |
| 122 nodes | 0.6 / 1.4 ms | 1.25 / 2 ms |
| 132 nodes, 10 ms Delay Edge | 1.15 / 3.5 ms | 8.5 / 22 ms |
| 392 nodes, 10 ms Delay Edge | 3.7 / 6.6 ms | 27 / 60 ms |
| 31 nodes, 8 fast Clocks | 0.5 / 0.95 ms | 3.3 / 8.3 ms |

Every next boundary is later than the tap: the horizon is up to the lookahead away (120 ms visible, 1.25 s hidden), and the first retained boundary at or after now (as swaps use, ADR 0023) up to a wake interval. A visible fallback would therefore break the immediate path (currentTime + 5 ms, ADR 0017) on exactly the heaviest patches, while visible rewinds stay near [0016](0016-main-thread-budget.md)'s ~4 ms except on extreme patches. Hidden rewinds cost far more, since they re-run up to 1.25 s, but a hidden page has no pointer input waiting on the main thread.

Separately, a node whose `query()` threw during a rewind left the live event injected and its re-run half done, so every later rewind through it threw again.

## Decision
- **Visible pushes always rewind** fully, as ADR 0019 says, whatever they cost.
- **Hidden pushes have a budget**, `SchedulerOptions.hiddenPushBudgetMs`, default 16 ms *(tune)*, checked before rewinding so nothing needs undoing. The estimate is `Runtime.rewindCost` (the queries the rewind would make: affected and followed query nodes times the chunks from the restored snapshot to the horizon) times a smoothed ms per query (each rewind's ms / queries, weight 0.2). Hidden and visible keep separate averages: a query costs up to 13× more hidden, where windows are wider. With no hidden rewind measured yet, a push rewinds and seeds the average. Queries alone can't be the budget: their cost ranged from 0.6 to 78 µs across the rows above. Within one mode the estimate was within 0.8–1.3× of the real cost from the 5th to the 95th percentile.
- **Why 16 ms.** Hidden, the estimate stayed under 1.5 ms for the first three rows and under 3.7 ms for the 8-Clock patch, and 8.7 to 11.5 ms for the 132-node Delay Edge fan, so none of them fell back, and a MIDI note into a hidden tab keeps its timing. Only the 392-node fan (estimates of 27 to 64 ms) fell back, on every push. A hidden page has no taps waiting. 16 ms is one frame at 60 Hz, so a pointerdown right after the page comes back waits at most that long for a push in progress. At 4 ms the 132-node fan would fall back on every hidden push, its notes up to 1.25 s late, to save a task nobody is waiting on.
- **Over budget, the push applies from the horizon,** the first unqueried boundary, so it re-queries nothing: the event's time becomes the horizon, and a wake queries the window that covers it at once. It is counted in `SchedulerStats.pushFallbacks`, reported in `PushCost.fallback` (`stamped`, `estimatedMs`), and raised as a `push-fallback` warning on the pushed node through `onWarning` and `warnings()`, its count the pushes applied late.
- **The applied time is the event's time.** `Scheduler.push` returns it, and the log, audio and frames all carry it. A recorded input stream (M2) stores the returned events, so a replay pushes the event at the horizon time and gets the same events.
- **"Same events whatever the wake timing" breaks only for hidden pushes over budget.** The horizon depends on when the scheduler last woke, so the same tap can land at different times. Visible pushes, and hidden pushes under budget, keep 0019's property.
- **A live event whose re-run throws is dropped.** It comes out of the injected events, and the nodes are restored and re-run again without it, so state, cap counts, the log and audio deliveries end up as if it had never been pushed. What the failed re-run had already sent is undone by the usual cancel-and-resend diff. The node that threw gets a `rewind-error` warning with the error's message, `RuntimeCounters.droppedPushes` counts it, and `RewindReport.dropped` (so `PushCost.rewind.dropped`) names the node. The scheduler still updates its stats and calls `onPush`. If the re-run without the event throws too, the node fails whatever the event, and that error propagates as before.

## Consequences
- A replay of a performance with hidden fallbacks matches only if its input stream holds the applied times, not the stamps. M2's format should record what `Scheduler.push` returns.
- Visible rewinds can pass ~4 ms on extreme patches (6.6 ms at worst above). If that ever matters, the next step is a time-sliced rewind: re-run the window holding the tap first, so it sounds on time, and the later windows in follow-up tasks, each finished before its window plays. Results then still depend only on event times.
- The budget assumes hidden pushes are rare (MIDI into a background tab), so the hidden average may be stale. A single misprediction makes one push late or one task long, not a run of them.
- A live event can now vanish. The editor shows the `rewind-error` warning like any other.
