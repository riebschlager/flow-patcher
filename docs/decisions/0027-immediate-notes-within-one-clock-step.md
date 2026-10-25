# 0027 · A tap's own note may reach Web Audio up to one clock step late

Status: Accepted · 2026-10-23 · Amends [0017](0017-immediate-offset-and-catch-up.md) · Amended by [0032](0032-first-wake-catches-up-from-zero.md) (caught-up events behind the clock count in `lateCaughtUp`, not `lateScheduled`)

## Context
ADR 0017 stamps live input at `ctx.currentTime + 5 ms`. The M1 gate's e2e edit run (#33) found that on macOS (Chromium, 48 kHz) about one run in two had a tap's own note reach `start()` behind `currentTime`: usually by 0.33 ms, once by 2.5 ms. `currentTime` doesn't move smoothly. It jumps once per audio callback, and a jump between the push's clock read and `start()` can be larger than the 5 ms lead. Scheduled events, 120 ms ahead, never come near this.

Two fixes were tried on #33 and dropped:
- An offset of `baseLatency` + 1 ms. Linux CI reports a 10 ms `baseLatency`, and Android reports 10 ms or more, so taps there would sound about 11 ms after the clock read instead of 5. That fails the gate's 5 ± 2 ms and pushes Android past M0's 20 ms tap-to-sound bar.
- Measuring the clock's largest step in the page. On the CI runner the largest step varied from 2.9 to 11.6 ms between runs, so the offset depended on which runner hiccups the sampling caught.

## Decision
- The offset stays 5 ms everywhere (0017).
- A tap's own note may reach Web Audio up to one audio clock step behind `currentTime`. The runtime moves an event that is behind the clock at hand-over to that clock reading, counts it (`lateImmediate`) and records the most it moved one (`lateImmediateMaxMs`). Web Audio plays a `start()` time in the past at the next render quantum.
- That lateness is the clock's step plus the time the push's re-run takes, so a slow re-run can exceed one step. The runtime doesn't prevent that; the gate measures it. `lateImmediate` covers the push's whole re-run, so Clock-driven events it re-delivers count too.
- Scheduled events must never be late (`lateScheduled` stays 0).
- The M1 gate's **No late events** box is reworded to say this.

## Consequences
- Tap-to-sound stays at 0017's figures on every platform.
- The e2e edit run checks that `lateScheduled` is 0 and that `lateImmediateMaxMs` is at most one step. One step there is the larger of `baseLatency` and the largest step the spec measures. It also checks that no `start()` call lands more than a step behind after hand-over.
- The pointer and fluid-load specs keep 0017's fixed 5 ms and their gate bounds (5 ± 2 ms; 12 ms under load).
