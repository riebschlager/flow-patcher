# 0036 · After M2, Flow Patcher becomes an evolving generative instrument

Status: Accepted · 2026-10-25 · Supersedes [0007](0007-community-after-v1.md), [0014](0014-phones-play-view-only.md) and [0015](0015-migrations-in-m4.md); amends [0001](0001-independent-from-flow.md), [0003](0003-gpu-fluid-one-node.md), [0016](0016-main-thread-budget.md) and [0029](0029-input-stream-format.md)

## Context
M2 passed with Flow's four tool modes rebuilt from nodes. They play, but they feel flat: the visuals look the same whatever you do, and the music doesn't develop over time. The next milestone, M3 "Flow as a patch", would have spent a milestone proving the vocabulary further by rebuilding the rest of Flow, porting its visual nodes and moving the fluid to the GPU. None of that addresses the flatness. Meanwhile the timing engine (hot patching, window queries, determinism) has proven to be the strongest part of the project.

## Decision
- **Who it's for:** Chris, as a personal instrument for jamming alone and for building generative systems that evolve while Chris nudges them. Sharing patches with players is not a goal for now.
- **Diverge from Flow.** Flow stays a source of code to borrow (ADR 0001). Rebuilding Flow is no longer the acceptance test (this amends 0001's M3 consequence), and nothing is built just because Flow had it.
- **Priorities, in order:** music that evolves over time (slow modulation, scenes that advance by time and rules, subpatches and macro knobs); then sound texture (drones and pads, modulated effects, granular); visual variety last and cheap.
- **Desktop only.** Desktop Chrome with a MIDI controller is the one reference setup. MIDI learn on any knob is the main hardware control.
- **Local save only.** A local library with download and upload. Patch migrations start when the library lands in M3, because saved patches must survive node changes from then on.
- **Lighter process.** Gates are feature checklists with tests, not device sessions. An ADR is needed only when an engine contract changes; other decisions get a line in design.md. Timing e2e checks that flake at the millisecond level are loosened or quarantined; the headless determinism, hot-swap and offline-audio tests stay.
- **New milestones:** M3 · Jam basics, M4 · Scenes, M5 · Texture, M6 · Look ([milestones.md](../milestones.md)).

## Consequences
- ADR 0014 no longer applies: there is no phone target and no Play view in the roadmap.
- ADR 0015 is replaced: migrations and unknown-node placeholders arrive with the local library in M3, not with sharing in M4.
- The GPU fluid (ADR 0003's solver port) is parked. The CPU solver in a Worker (ADR 0016) is the fluid on desktop, not a stopgap. A patch still has at most one Fluid node.
- Input recordings and Play view are parked, so ADR 0029's input stream format serves replay tests for now; its notes on M4 recordings wait for them.
- Community (ADR 0007) is parked, not scheduled in M5.
- "v1" in older records means the catalog and features the old roadmap planned; it no longer marks a release.
- The unbuilt ★ nodes are scheduled only where the new milestones need them; the rest are parked in the catalog.
