# 0028 · The immediate offset covers the measured clock step, not baseLatency

Status: Accepted · 2026-10-23 · Amends [0027](0027-immediate-offset-covers-a-callback.md)

## Context
ADR 0027 took one audio callback from `AudioContext.baseLatency`, assuming it is the most `currentTime` moves in one step. That holds on macOS (256 frames: 5.33 ms both ways). It doesn't hold in CI: headless Chromium on Linux reports a 10 ms `baseLatency`, while `currentTime` moves in steps of about 2.9 ms (fluid-load log, run 39895441811). The offset came out at 11 ms, outside the M1 gate's `currentTime + 5 ms ± 2 ms`. Android reports 10 ms or more too, which would push its tap-to-sound past M0's 20 ms bar for no reason the clock itself gives.

What makes a note late is how far `currentTime` can jump between the push's read and `start()`: the clock's step, not the output buffer.

## Decision
- A push is stamped `currentTime + max(5 ms, largest clock step + 1 ms)` *(tune)*. `SchedulerClock.callback()` is renamed `step()` and returns that step.
- The editor measures it (`packages/editor/src/clock-step.ts`). Once an animation frame, while the context runs, it reads `currentTime` in a tight loop for at most 1 ms, until the value changes; that change is one step. It keeps the largest.
- Until 32 steps are seen, the step is `baseLatency` (the safe side on every platform measured so far). Then the measurement takes over, is fixed, and reading stops. It is final before it is used because macOS mixes 2.67 and 5.33 ms steps: an early switch could see only short ones and then raise the offset after taps were already stamped with less. A 1 ms slice sees a step in about one frame in three to five, so this takes 2–3 s after audio starts, at most 1 ms a frame.
- The gate wording is unchanged. e2e specs wait until the step is measured before timing taps, and pointer.spec asserts the gate as written: note − push's read within 5 ± 2 ms.

## Consequences
- macOS: 6.33 ms, as under 0027. Linux CI: 5 ms. Devices whose clock steps by 6 ms or more still get a larger offset, as 0027 intended.
- Taps in the first 2–3 s after audio starts use the `baseLatency`-based offset (11 ms in CI). The editor records each tap's offset (`Tap.offset`), and the e2e specs wait for the measurement before timing taps.
- A step larger than any of the 32 sampled (a rare two-callback burst) can still pass a note; the late counters and the e2e edit run would show it.
- An output-device change isn't re-measured. Nothing in M1 changes the sink; revisit when something does.
