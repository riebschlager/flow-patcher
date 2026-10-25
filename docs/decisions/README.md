# Decisions

Short records of settled calls. Read the relevant ones before changing anything they cover. To change one, write a new record that supersedes it; don't quietly edit the old one.

| # | Decision |
| --- | --- |
| [0001](0001-independent-from-flow.md) | Independent from Flow: borrow code freely, no compatibility |
| [0002](0002-license-gpl-3.0.md) | GPL-3.0 |
| [0003](0003-gpu-fluid-one-node.md) | GPU fluid solver, one Fluid node per patch |
| [0004](0004-web-midi-in-v1.md) | Web MIDI in v1 |
| [0005](0005-single-canvas.md) | One canvas per patch |
| [0006](0006-tool-modes-composed.md) | Flow's tool modes are composed from nodes, not built in |
| [0007](0007-community-after-v1.md) | Community comes after v1 |
| [0008](0008-one-clock-window-queries.md) | One audio clock and pure window queries |
| [0009](0009-channels-from-day-one.md) | Channels from day one |
| [0010](0010-explicit-feedback.md) | Feedback needs a delay edge |
| [0011](0011-runtime-safety-limits.md) | Safety limits live in the runtime |
| [0012](0012-fixed-visual-vocabulary.md) | A fixed visual vocabulary; Shader node post-v1 |
| [0013](0013-engine-editor-split.md) | Framework-free engine, separate editor |
| [0014](0014-phones-play-view-only.md) | Phones get Play view only in v1 |
| [0015](0015-migrations-in-m4.md) | Patch migrations start in M4 |
| [0016](0016-main-thread-budget.md) | Keep the main thread free while a patch plays; fluid work in a Worker until the GPU solver |
| [0017](0017-immediate-offset-and-catch-up.md) | A 5 ms immediate-path offset, and catch-up for late scheduler wakes (amends 0008) |
| [0018](0018-transport-on-a-cable.md) | The transport travels on a cable from Clock; a reader with no cable stays at beat 0 |
| [0019](0019-live-events-rewind.md) | Live events rewind state and re-query, so results depend only on event times |
| [0020](0020-tap-splash-skips-latency-shift.md) | A tap's own splash skips the output-latency shift |
| [0021](0021-transport-tempo-changes.md) | Transport tempo, division and swing changes keep Phase continuous; state need only be observably equal (amends 0018) |
| [0022](0022-event-caps-on-a-fixed-grid.md) | Event caps count on a fixed 120 ms grid of the audio clock; the per-node cap is window-independent, the patch cap isn't once it binds (amends 0011) |
| [0023](0023-hot-swap-reruns-from-next-boundary.md) | A hot swap takes effect at the first window boundary at least 15 ms past currentTime and re-runs the lookahead from there; each window replays under its own plan |
| [0024](0024-voice-pool-steals.md) | The voice pool steals the earliest start; a steal stays when the note that caused it is withdrawn (amends 0011, 0019) |
| [0025](0025-voice-steals-warn-and-stay-in-budget.md) | A voice steal warns on the node whose note caused it, and the pool's worst case fits the main-thread budget (amends 0024) |
| [0026](0026-hidden-push-fallback.md) | While the page is hidden, a push whose rewind is over budget applies from the horizon; a live event whose re-run throws is dropped with a warning (amends 0019) |
| [0027](0027-immediate-notes-within-one-clock-step.md) | A tap's own note may reach Web Audio up to one audio clock step late; scheduled events never (amends 0017) |
| [0028](0028-recognizers-pass-claim-cancel.md) | Recognizers chain on one phase-tagged stream; a claim is one Cancel on Pass, decided in query() |
| [0029](0029-input-stream-format.md) | Input streams record canvas events by type and replay through any patch |
| [0030](0030-overlays-draw-into-the-renderer.md) | Overlays draw into the Renderer's picture in pure TS through an Overlay field kind; reduced motion is a host service |
| [0031](0031-audio-automation-and-in-place-edits.md) | Audio instances automate per chunk on a 60 Hz grid, idempotently across re-runs, and take knob edits in `liveParams` in place (amends 0023) |
| [0032](0032-log-knobs-depth-in-octaves.md) | A number param can be log-scaled: its knob reads the range by ratio, values stay in natural units, and cable depth into it is in octaves |
| [0033](0033-first-wake-catches-up-from-zero.md) | The first wake catches up from 0 within the catch-up limit, and starts at now past it, never a stall; caught-up events behind the clock count apart from scheduled ones (amends 0017, 0027) |
| [0034](0034-transport-carries-the-tempo.md) | The Transport cable carries a transport reading, the beat and the tempo in effect, read through `transportBeat` and `transportTempo` (amends 0018) |
| [0035](0035-retired-audio-chains-ring-out-together.md) | A retired audio instance stays while a retired one upstream feeds it, and its tail counts from that one's disposal; an audio cycle retires together (amends 0023) |
| [0036](0036-refocus-after-m2.md) | After M2, an evolving generative instrument for Chris on desktop: new milestones, lighter process (supersedes 0014, 0015; parks the GPU solver of 0003 and 0007) |

## Adding a decision
Copy the shape of an existing file: number, title, `Status: Accepted · <date>`, then Context (if needed), Decision and Consequences. Keep it under a page. If it replaces an older record, set the old one's status to `Superseded by NNNN`. If it changes only part of an older record, set the old one's status to `Amended by NNNN` and leave its text as written; the new record says what changed.
