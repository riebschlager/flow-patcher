# Flow Patcher
Browser node editor for music + visuals. Design: docs/design.md (read the section you need, not the whole file). Decisions: docs/decisions/. Node catalog: docs/nodes/<category>.md. Milestones and gates: docs/milestones.md — work only on the current milestone.

This file is the shared instructions for every coding agent. CLAUDE.md files import it; edit AGENTS.md, not the CLAUDE.md beside it.

## Layout
- packages/engine — runtime, no DOM/React/Node.
- packages/nodes — one file per node type, listed in index.ts.
- packages/editor — React + React Flow.
- tools/ (headless runner), examples/, golden/, e2e/.
- spike/ — M0 throwaway code. Nothing in packages/ imports from it.
- Each package has its own AGENTS.md with local rules.
- .claude/skills/flow-patcher-design/ — the design system (tokens, components, UI kit). Read its readme.md before any editor UI work.
- ../flow — the Flow repo, a sibling checkout. Read it to borrow code; never edit it.

## Commands
pnpm check   # typecheck, lint, unit tests — run before finishing
pnpm e2e     # Playwright
pnpm run-patch <file.json>  # headless engine run, output in out/
pnpm golden:update          # only when output is meant to change
pnpm spike                  # M0 spike dev server on :5174, reachable on the LAN

## Rules
- engine/ has no DOM or React imports.
- Generators are pure window queries: query(t0, t1). No Math.random; use the seeded RNG.
- Every cycle needs a delay edge; Field reads return the previous frame.
- One file per node type in nodes/. Palette and inspector are generated from it.
- From M4 on, changing a node's params needs a migration function and a test. Before M4, update the example patches instead.
- Code borrowed from Flow is ours: adapt it freely, but bring its tests along. No compatibility with Flow is required.
- Don't change golden files without saying why. Never edit them by hand; `pnpm golden:update` regenerates them. golden/example-events.json holds every example patch's expected event log.
- vendor/ holds third-party files copied verbatim with their notices. Don't edit them.
- Budgets: 64 voices, 256 events per node per window, 2,048 per patch.
- Editor UI follows the design system: use its `--fp-*` tokens (imported in packages/editor/src/styles.css), not ad-hoc colors or sizes. Port shapes, cable styles and family glyphs live in packages/editor/src/ports.ts.
- Don't edit files under .claude/skills/flow-patcher-design/ while doing editor work; it's the reference. Its uploads/design.md is a symlink to docs/design.md.

## M0 spike
While docs/milestones.md says the current milestone is M0, these rules relax the ones above for spike work. The rest still apply: ../flow, golden/ and vendor/ stay untouched, nothing in packages/ imports spike/, and the design skill isn't edited.
- All work goes in spike/. Don't change packages/, examples/, golden/ or e2e/ for a spike task.
- Throwaway code: no unit tests, example patches or goldens, and node types need not be one file each. Copying Flow modules from ../flow/public raw is fine; clean porting happens in M3.
- The main session builds the spike itself. node-builder, porter and engine target packages/ and don't run in M0; the reviewer still checks spike diffs.
- Log the gate's measurements in the spike (tap-to-sound latency, skipped windows) so they can go into docs/spike-notes.md.
- `pnpm check` must stay green, but it doesn't cover spike/.

## Done means
Tests pass, a new node has a unit test and an example patch, and the PR says what you checked. In M0: the spike runs with `pnpm spike` and the PR says what you tried in it.
