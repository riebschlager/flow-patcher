# 0017 · A 5 ms immediate-path offset, and catch-up for late scheduler wakes

Status: Accepted · 2026-10-21 · Amends [0008](0008-one-clock-window-queries.md) · Amended by [0027](0027-immediate-notes-within-one-clock-step.md) (a tap's own note may land up to one clock step late)

## Context
ADR 0008 stamps live input at `ctx.currentTime + ~10 ms`, and skips missed windows after any stall. The M0 spike measured both on the reference devices ([spike-notes.md](../spike-notes.md)):
- Android's own input delay was about 6.5 ms median and 11 ms worst. With a 10 ms offset, the phone's worst tap was 21.3 ms. With 5 ms it was 16.2 ms, and quick taps still sounded even.
- The Surface's 25 ms wake timer often ran 10–30 ms past the 120 ms lookahead with nothing blocking the main thread. Each late wake skipped a window and could drop its notes.

## Decision
- Live input is stamped `ctx.currentTime + 5 ms` *(tune)*.
- A scheduler wake up to 100 ms *(tune)* past its horizon queries the stretch it missed. That stretch is moved to start now, so its events keep their spacing and play late rather than stacking. Only longer gaps are stalls that skip their windows.
- The lookahead stays 120 ms, and 1.25 s while the tab is hidden.

## Consequences
- A caught-up note can land within a millisecond or two of an on-time one, a flam, but only after a late wake. In the spike nobody heard one.
- Late events from a catch-up are counted apart from late events on the immediate path.
