# 0013 · Framework-free engine, separate editor

Status: Accepted · 2026-10-21

## Decision
- `packages/engine` is plain TypeScript that runs without the editor. It has no React and no DOM access: no `document`, `window`, elements or DOM events.
- Platform resources the engine needs (an `AudioContext`, a WebGL2 context, canvas input events) are passed in by the host, not looked up by the engine.
- `packages/editor` is React + React Flow with a small store (e.g. Zustand). It edits a patch document and sends diffs to the engine.
- `packages/nodes` has one file per node type: ports, parameters (range, unit, default), `query()` or `frame()`. The palette, inspector and (later) server validation are generated from these files.

## Consequences
- Playback, Play view, export and the headless runner all run the same engine code that the editor drives.
- A lint rule or test fails the build on DOM or React imports in `packages/engine`.
- How the headless runner provides the audio and GL contexts (headless browser or a Node implementation) is decided in M1.
