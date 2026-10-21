@AGENTS.md

## Claude Code
- Load the flow-patcher-design skill for any editor UI work.
- Plan and delegate. Subagents in .claude/agents/:
  - node-builder: one node type end to end.
  - engine: graph compiler, scheduler, frame loop, fluid passes.
  - porter: brings a Flow module in with its tests.
  - reviewer: read-only check of a diff before it becomes a PR.
- Run the reviewer on every diff before opening a PR. It reports; the agent that wrote the code fixes it.
