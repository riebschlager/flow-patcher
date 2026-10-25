# 0032 · The first wake starts the patch at 0, catching up to now

Status: Accepted · 2026-10-25 · Amends [0017](0017-immediate-offset-and-catch-up.md), [0027](0027-immediate-notes-within-one-clock-step.md)

## Context
In the editor the AudioContext stays suspended until the first tap, so the scheduler queries nothing before it. By the first running wake after the resume, `currentTime` has already moved a few ms past 0, and that wake started its window at `now`. An event at exactly t=0, such as a Clock's first tick, was never queried and never played (#105). Headless runs wake at exactly 0, so they never showed it.

The fix catches up [0, now) with 0017's mechanism. In the e2e that checks it, the catch-up then ran into 0027's rule that scheduled events are never late. A catch-up moves its stretch to start at the wake's `now`, with no lead. Before, only rare late wakes did that, but now every cold start does it for the t=0 event. The first wake's query is the slowest of a session, because it builds the audio instances, so `currentTime` often steps during it. In 30 Chromium runs on macOS the step left the t=0 note behind the clock at hand-over in about one run in ten, and behind it at `start()` in a few more, by at most one step (5.3 ms).

## Decision
- The first running wake, the one before any window has been queried, starts at 0. Whatever of [0, now) it has missed is caught up: moved to start at `now`, keeping its spacing, as 0017 does. So a t=0 event sounds at the resume.
- This holds however far `now` is past 0, beyond the 100 ms catch-up limit too, and it never counts as a stall. Nothing in [0, now) has been heard, so catching it up doesn't play anything twice, and a stall count there would report a slow startup as a dropped window. In the editor `now` at that wake is the time between the clock starting and the next wake (the `statechange` handler or the 25 ms timer). That is a few ms unless the main thread is blocked.
- A resume after a suspend or `halt`, once a window has been queried, is unchanged: it carries on from the horizon, or from `now` if the clock has passed the horizon, and doesn't catch up.
- Held pushes, such as the first tap, are replayed after that wake's catch-up and stamped `currentTime + 5 ms`. The t=0 note goes first, and the tap's note follows at least 5 ms later.
- A caught-up event that is still behind the clock at hand-over is moved to the clock, like any other late event. It is counted in `lateCaughtUp`, not in `lateScheduled`, and this applies to every catch-up, not just the first. 0027's rule now covers events queried ahead: `lateScheduled` stays 0. A caught-up event is late by design, and `caughtUp` counts it.

## Consequences
- The first note of a patch sounds at the first tap instead of one period later. The event log keeps the patch's own times, the same as a clock that started at 0. Headless runs and the golden logs don't change.
- If startup is slow, [0, now) overlaps [now, 2·now): for that long the patch plays about twice as many events, once. A host that starts the scheduler against a clock that has run for a long time would catch all of it up. The editor creates the AudioContext and the scheduler together, and a suspended context's clock stays at 0.
- Visual nodes see caught-up events at their own times (design.md, Lifetimes), so a slow first wake can show [0, now) in one frame.
- Signal automation in the first chunk moves by the shift, like any catch-up chunk (0031).
- `RuntimeCounters.lateCaughtUp` is new. The first-note e2e allows the t=0 note up to one clock step behind `currentTime` at `start()`, the same bound 0027 sets for a tap's note.
