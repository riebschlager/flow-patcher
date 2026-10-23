# 0027 · The immediate-path offset covers at least one audio callback

Status: Accepted · 2026-10-22 · Amends [0017](0017-immediate-offset-and-catch-up.md)

## Context
ADR 0017 stamps live input at `ctx.currentTime + 5 ms`. The M1 gate's e2e edit run (#33; macOS, Chromium, 48 kHz, 256-frame callbacks) found that in about one run in two, a tap's own note reached `AudioBufferSourceNode.start()` 0.33 ms after `currentTime`, and once 2.5 ms after. The runtime hands the note over with its full 5 ms lead, but `currentTime` doesn't move smoothly: it advances once per audio callback, here 256 / 48 000 = 5.33 ms, which is more than the offset. One clock step between the stamp and the voice's `start()` call puts the note in the past. If the step comes during the push itself, the late counters catch it (`lateImmediate`). Scheduled events, 120 ms ahead, never come near this.

## Decision
- A push is stamped `currentTime + max(5 ms, one audio callback + 1 ms)` *(tune)*. The 1 ms is `IMMEDIATE_MARGIN`.
- The callback comes from the host as `SchedulerClock.callback()`, in seconds. The editor passes `AudioContext.baseLatency`. It is read at every push, because `baseLatency` can be 0 before the context runs. A value that is 0, negative or not finite counts as 0, so the offset is 5 ms.
- Without `callback` (headless runs, tests) the offset is the configured `immediateOffset` alone, 5 ms by default, as before.
- `Scheduler.offset` reports the offset in force, so tests and e2e can check it.

Why: a `start()` time already in the past plays at the next render quantum, late by however far the clock has moved. The offset exists to keep the note ahead of the clock until Web Audio has it. One callback is the most the clock moves in a single step, and the extra 1 ms covers the hand-over work.

## Consequences
- On desktop at 256 frames, a tap sounds about 1.3 ms later (6.33 ms instead of 5 ms).
- Devices with larger callbacks get a larger offset. Android can report 10 ms or more, which raises tap-to-sound there by that much. 0017's phone figures assumed 5 ms.
- A two-step clock burst (seen once, 2.5 ms late) can still pass a 6.33 ms note. The late counters and the e2e run will show it if it happens.
- The M1 gate's bounds are unchanged: "currentTime + 5 ms ± 2 ms" (6.33 ms is inside it) and "offset + 7 ms" under load.
