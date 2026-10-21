# 0002 · GPL-3.0

Status: Accepted · 2026-10-21

## Context
Flow's code and samples are GPL-3.0, and Flow Patcher borrows both.

## Decision
Flow Patcher is licensed GPL-3.0.

## Consequences
- A GPL-3.0 `LICENSE` file sits at the repo root.
- Vendored assets (WebAudioFont, FluidR3 samples) live in `vendor/` with their original notices.
- New dependencies must be GPL-3.0 compatible. Check the license before adding one.
