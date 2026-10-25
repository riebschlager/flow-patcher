# 0027 · A tap's own note may reach Web Audio up to one clock step late

Status: Accepted · 2026-10-23 · Amends [0017](0017-immediate-offset-and-catch-up.md) · Amended by [0033](0033-first-wake-catches-up-from-zero.md) (caught-up events behind the clock count in `lateCaughtUp`, at most one step, not in `lateScheduled`) · Amended 2026-10-25 for #97 (how the e2e specs measure one step)

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
- The e2e edit run checks that `lateScheduled` is 0 and that `lateImmediateMaxMs` is at most one step. It also checks that no `start()` call lands more than a step behind after hand-over.
- **One step** (#97), in every spec that bounds by it (first-note, pointer, live-edit-run, fluid-load), is the largest of three measurements, all logged:
  - `baseLatency`, which Chromium reports as the callback buffer;
  - the largest move of `currentTime` in a 200 ms sample taken after the checked part of the run;
  - the burst step: a test-only AudioWorklet (e2e/audio-burst.ts, never in the editor's graph) counts the most render quanta the audio thread runs back to back, from before the first tap to the end of the test, and the step is that × 128 / sampleRate. Bursts are told apart by `Date.now()` between `process()` calls (the worklet scope has no `performance` in Chromium): calls in one burst read 0–1 ms apart, calls a quantum apart 2 ms or more, at up to 48 kHz.

  On the Linux CI runner (44.1 kHz), `baseLatency` read 10.00 ms and the sample 2.90 ms (one 128-frame quantum), but `currentTime` jumped 11.61 ms, a 512-frame burst, around the resume: the t=0 note of PR #120's first-note run started 11.61 ms after its `when`, against a step of 10.00 ms. The sample, taken after the run, can't see a burst at the resume, and `baseLatency` isn't the burst. The probe sees it; locally (macOS, 48 kHz) it reads 2 quanta (5.33 ms, equal to `baseLatency`) in steady play and 4 (10.67 ms) at the resume.

  None of the three is circular: they are measured on the audio thread or from the platform, not from the clock reads of the pushes and wakes being checked, so a slow push can't widen the bound it is checked against. The largest step the editor's own reads met over the run (`LivePatch.clock.largestStep`) is logged too, but not used, since it is. The pointer spec's 5 ± 2 ms bound doesn't use one step and is unchanged.
- The pointer and fluid-load specs keep 0017's fixed 5 ms and their gate bounds (5 ± 2 ms; 12 ms under load).
