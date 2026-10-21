# Flow Patcher

A browser node editor for music and visuals: canvas input events, musical generators, synths, effects and a live fluid simulation, wired into an instrument of your own. Design: [docs/design.md](docs/design.md). Decisions: [docs/decisions/](docs/decisions/). Milestones: [docs/milestones.md](docs/milestones.md).

GPL-3.0-only. Parts are borrowed from Flow; see [ADR 0001](docs/decisions/0001-independent-from-flow.md).

## Layout

| Path | What lives there |
| --- | --- |
| `packages/engine` | Framework-free runtime: patch format, node definition types, seeded RNG, CPU fluid solver, renderer, Output stage, bootstrap runtime. No DOM, React or Node imports. |
| `packages/nodes` | One file per node type, plus `index.ts` listing them all. |
| `packages/editor` | React + React Flow editor (Vite). |
| `tools/` | Headless runner (`run-patch`) and its helpers: offline audio, WAV and PNG encoders. |
| `examples/` | Example patches. Every node type appears in at least one. |
| `golden/` | Golden files for regression tests, generated in this repo. |
| `e2e/` | Playwright tests against the dev server. |

## Commands

```sh
pnpm install
pnpm dev                    # editor at http://localhost:5173
pnpm check                  # typecheck, lint, unit tests
pnpm e2e                    # Playwright (first time: pnpm exec playwright install chromium)
pnpm run-patch <file>       # headless run; writes events.json, summary.json, audio.wav, frame-*.png to out/<name>/
pnpm golden:update          # regenerate golden/ (only when output is meant to change; say why in the PR)
```

`pnpm run-patch` takes `--seconds S`, `--windows N` or `--frames N`, plus `--window 0.025`, `--fps 60`, `--no-audio` and `--out DIR`.

## Checks that guard the design

- **Engine boundary.** `packages/engine` compiles without the DOM lib, and ESLint rejects React, editor, Node and DOM imports and globals there. `packages/engine/test/boundary.test.ts` proves the rules fire.
- **Seeded randomness, no timers.** Lint bans `Math.random` in engine and node code, and timers in node code.
- **Golden files.** The fluid frames are bit-exact (SHA-256 per frame over every field), the palette renders byte-exact, and the Output stage loudness matches within a tolerance on a native `OfflineAudioContext`.
- **Catalog rules.** Every node type is well formed, has `packages/nodes/test/<type>.test.ts`, and appears in an example patch. Every example compiles, uses current type versions, and round-trips byte for byte.
- **Runner determinism.** Two runs give byte-identical event logs, and window sizes of 25 ms, 100 ms and 17.3 ms, or the whole run as one window, give the same events.
