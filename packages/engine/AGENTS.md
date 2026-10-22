# packages/engine
Framework-free runtime: patch format, node definition types, seeded RNG, CPU fluid solver, renderer, Output stage. Must run in the browser and headless.

## Rules
- No DOM, React, editor, nodes or Node imports or globals; ESLint enforces it and test/boundary.test.ts proves the rule fires. If you need a browser API, take it as an injected interface (see audio/types.ts).
- tsconfig has no DOM lib on purpose. Don't add it.
- Randomness: `randomAt(seed, ...keys)` in window queries (independent of windowing), `createRng(seed)` only for one-time setup.
- runtime.ts holds the graph compiler and the Runtime (window queries, frames, audio, rewind and re-query); scheduler.ts decides which windows to query and when. The event caps and per-node warnings are in limits.ts and runtime.ts. Hot patching is still to come; keep the compile → query/frame/attachAudio shape.
- Public API goes through src/index.ts. Changing `NodeDefinition` in definition.ts affects every node, so check packages/nodes too.
- Patch format changes need the example patches to keep round-tripping byte for byte (packages/nodes/test/catalog.test.ts).

## Tests
- test/<module>.test.ts. Golden checks use test-support/golden.ts: `expectGolden` for bit-exact output (fluid frames, palette renders), `expectGoldenClose` for output that may vary by platform (audio loudness).
- A failing golden test means the output changed. Find out why before you consider `pnpm golden:update`.
- Engine changes run one at a time, not in parallel worktrees.
