# Flow Patcher — Coding Agent Setup

Oct 21, 2026 · @Chris Riebschlager

Set up the repo so agents can check their own work: tests and golden renders first, a short CLAUDE.md, a few focused subagents, and one milestone at a time. This guide assumes Claude Code and follows the Flow Patcher design doc.

## Step 1 — Put the design in the repo

Agents work from files, not from a doc they can't open. Export the design doc to Markdown and split it so each session loads only what it needs.

- `docs/design.md` — the full design, read on demand, never pasted whole into context.
- `docs/decisions/` — one short ADR per settled call: GPU solver with one Fluid node, Web MIDI in v1, single canvas, tool modes composed from nodes, Community after v1, GPL-3.0.
- `docs/nodes/` — the node catalog tables as one file per category, so a node-building agent reads only its category.
- `docs/milestones.md` — each milestone with its gate written as checks an agent can run.
- `.claude/skills/flow-patcher-design/` — the design system as a skill: tokens, components and a UI kit. Claude Code lists it as `flow-patcher-design` and loads it for editor UI work.

## Step 2 — Scaffold the harness before features

An agent is only as good as its feedback loop, so the first session builds the checks, not the product.

1. Vite + TypeScript monorepo with three packages: `engine` (no DOM, no React), `nodes` (one file per node type) and `editor` (React + React Flow).
2. `pnpm check` runs typecheck, lint and unit tests; `pnpm e2e` runs Playwright against the dev server. Agents run both before saying "done".
3. Bring Flow's regression suites in with the modules they test: bit-exact fluid frames (CPU reference), byte-exact palette renders, offline audio renders. Golden files are generated in this repo and belong to it.
4. Add a headless engine runner: load a patch JSON, run N window queries or frames, write events, audio and a frame PNG to `out/`. Tests and agents both use it.
5. Add a lint rule or test that keeps `engine` free of DOM and React imports, so the boundary in the design can't erode.

## Step 3 — Write a short CLAUDE.md

Claude Code loads `CLAUDE.md` at the start of every session. Keep it under about 150 lines: rules and pointers, not the design. Put a smaller `CLAUDE.md` in each package for its local rules.

```markdown
# Flow Patcher
Browser node editor for music + visuals. Design: docs/design.md. Decisions: docs/decisions/.

## Commands
pnpm check   # typecheck, lint, unit tests — run before finishing
pnpm e2e     # Playwright
pnpm run-patch <file.json>  # headless engine run, output in out/

## Rules
- engine/ has no DOM or React imports.
- Generators are pure window queries: query(t0, t1). No Math.random; use the seeded RNG.
- Every cycle needs a delay edge; Field reads return the previous frame.
- One file per node type in nodes/. Palette and inspector are generated from it.
- From M4 on, changing a node's params needs a migration function and a test. Before M4, update the example patches instead.
- Code borrowed from Flow is ours: adapt it freely, but bring its tests along. No compatibility with Flow is required.
- Don't change golden files without saying why.
- Budgets: 64 voices, 256 events per node per window, 2,048 per patch.
- Editor UI follows the flow-patcher-design skill: use its `--fp-*` tokens, not ad-hoc colors or sizes.

## Done means
Tests pass, a new node has a unit test and an example patch, and the PR says what you checked.
```

When an agent gets something wrong twice, add one line here. That's the main way the setup gets better over time.

## Step 4 — Define a few subagents

Subagents live in `.claude/agents/*.md`, each with its own prompt and tool list. The main session plans and delegates. Each subagent works with a clean context on one area. Start with four and add more only when a gap shows up.

| Subagent | Owns | Reads first | Tools |
| --- | --- | --- | --- |
| node-builder | One node type end to end: definition, `query()`/`frame()`, migration, test, example patch | `docs/nodes/<category>.md`, an existing node as a template | Edit, Bash (`pnpm check`) |
| engine | Graph compiler, scheduler, frame loop, GPU fluid passes | Timing section, `docs/decisions/` | Edit, Bash, headless runner |
| porter | Bringing a Flow module in with its tests, adapted to this project's conventions | Reuse-from-Flow table | Read on the Flow repo, Edit, Bash |
| reviewer | Read-only check of a diff against the rules and the design | `CLAUDE.md`, the diff | Read, Grep, Bash (tests only), no Edit |

The reviewer has no edit rights on purpose: it reports, and the agent that wrote the code fixes it.

## Step 5 — Hooks, permissions and senses

Hooks turn rules into checks that always run. Put them in `.claude/settings.json` and commit it, so every agent and every teammate gets the same setup.

- **After an edit:** run the typecheck on the changed package and return the errors to the agent.
- **Before finishing a task:** run `pnpm check` and don't let the agent stop while it fails.
- **Before an edit:** block writes to `golden/` and `vendor/` unless the task says to update them.
- **Permissions:** allow `pnpm`, `git` and the headless runner. Ask before installing packages or running network commands.

Agents can't hear audio or watch the canvas, so give them other ways to check:

1. **Playwright MCP** to open the editor, wire nodes, play a patch and take screenshots of the canvas and the budget readout.
2. **Headless runner output**: event logs as JSON, offline WAV renders compared by checksum or loudness, and fluid frames saved as PNGs that the agent can look at.
3. **Example patches as tests**: each one-idea example patch ("tap to play chords" and the rest) gets a scripted input stream and an expected event log. Recorded inputs replay deterministically, so these tests are stable.

The GPU solver isn't bit-exact across machines. Test it against the CPU reference within a tolerance instead.

## Step 6 — Slice work by milestone

Work through one milestone at a time, and don't start the next until its gate passes. Within a milestone, write each task as a small issue an agent can finish in one session:

- **Goal:** one sentence, such as "Add the Euclidean node".
- **Read:** the doc files and the existing code to copy from.
- **Done when:** the test or example patch that must pass.
- **Out of scope:** what not to touch.

Start each task in plan mode and approve the plan before any code gets written. M0 is a throwaway spike, so let agents move fast there and skip the harness. Build the harness (Step 2) at the start of M1.

## Step 7 — Run in parallel, review, merge

1. Run independent tasks in separate git worktrees, one Claude Code session each. New node types parallelize well; engine changes should run one at a time.
2. Every task ends with a PR. The reviewer subagent checks it, then CI runs `pnpm check` and `pnpm e2e`.
3. You review anything that touches the engine, the patch format or a golden file. Node additions with green CI can merge after a quick look.
4. Optionally, add the Claude GitHub Action so `@claude` in an issue or PR can pick up small fixes.
5. After each milestone, add a line to `CLAUDE.md` for every mistake that repeated, and update `docs/` if the design changed.

## Open questions

- [ ] Is Claude Code the agent, or will other agents (Cursor, Codex) work in the repo too? If so, mirror `CLAUDE.md` into an `AGENTS.md`.
- [ ] Does the repo live on GitHub, so CI and the Claude GitHub Action can be used?
- [ ] Can agents read the Flow repo directly (as a sibling checkout or a submodule), or do ported files get copied in by hand?
- [ ] Who reviews engine PRs besides you?
