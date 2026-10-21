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

## Adding a decision
Copy the shape of an existing file: number, title, `Status: Accepted · <date>`, then Context (if needed), Decision and Consequences. Keep it under a page. If it replaces an older record, set the old one's status to `Superseded by NNNN`.
