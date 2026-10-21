@AGENTS.md

## Claude Code
- Load the flow-patcher-design skill for any editor UI work.
- Plan and delegate. Subagents in .claude/agents/:
  - node-builder: one node type end to end.
  - engine: graph compiler, scheduler, frame loop, fluid passes.
  - porter: brings a Flow module in with its tests.
  - reviewer: read-only check of a diff before it becomes a PR.
- Run the reviewer on every diff before opening a PR. It reports; the agent that wrote the code fixes it.

## Hooks and tools (.claude/settings.json)
- Every .ts/.tsx edit is typechecked; errors come back to you. Fix them before moving on.
- You can't finish a turn with code changes while `pnpm check` fails.
- Edits to golden/, vendor/ and ../flow are blocked. To lift it for golden/ or vendor/, a human starts the session with `FP_ALLOW_PROTECTED=golden` (or `vendor`).
- Playwright MCP (.mcp.json) opens the editor: start `pnpm dev`, go to http://localhost:5173, wire nodes, take screenshots. Use it to check UI changes.
