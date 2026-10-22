# packages/nodes
One file per node type. Each one exports a `NodeDefinition` (packages/engine/src/definition.ts), and the palette and inspector are generated from it.

## Adding a node
1. Read docs/nodes/README.md and your family's file in docs/nodes/. Read design.md only for the section the family file points to.
2. Copy a similar node: probability.ts for event filtering, clock.ts for generators, simple-synth.ts for audio, fluid.ts for visual.
3. Create src/<type>.ts with `type` set to the kebab-case file name, then add it to the list in src/index.ts in palette order.
4. Write test/<type>.test.ts with the helpers in test/helpers.ts. Cover windowing independence (`queryTiled` vs `query`), more than one channel, and bad input (NaN, empty, out of range).
5. Use the node in a patch in examples/ (`.flowpatch`), new or existing.
   Audio nodes: if `audio()` returns `schedule()`, it must also return `cancel()`, which withdraws previously scheduled events by identity. Rewinds use it (ADR 0019); without it, replaced events still play and the runtime warns.
6. `pnpm check`. test/catalog.test.ts fails if step 3, 4 or 5 is missing.

## Rules
- `query()` is pure: same inputs and window give the same events. Use `randomAt(seed, nodeId, timeKey(e.time), e.channel)`, never Math.random, and no timers or DOM (lint enforces both).
- Per-channel state is keyed by `channel`. Keep state in `ctx.state`, never in module scope. State in a node with `query()` must be plain data and windowing-independent; the engine snapshots it for rewinds (see `NodeState` in definition.ts). For every node with a `query()` and an Event, Note, Signal or Value output, test/catalog.test.ts queries it over 0–10 s in 25 ms, 100 ms and one-call windows (Event/Note inputs fed a test stream, Signal inputs a test wave, Signal/Value outputs read by a probe), with snapshots on, so state that isn't plain data throws. Nodes with an Event input also get live events pushed in under several wake timings, compared with a run where the events are known in advance. Value inputs and param modulation aren't fed.
- Weird input gives a defined result, never an exception. Don't re-implement the engine's event budgets.
- Changing ports or params means bumping `version` and updating every example patch that uses the node (before M4; migrations from M4 on).
