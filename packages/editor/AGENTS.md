# packages/editor
React + React Flow editor (Vite). `pnpm dev` serves it at http://localhost:5173, and e2e/ runs Playwright against it.

## Rules
- Read the design system (.claude/skills/flow-patcher-design/readme.md; Claude Code: load the flow-patcher-design skill) before any UI work. Colors, sizes, type and spacing come from its `--fp-*` tokens, imported in src/styles.css. No hex values or ad-hoc pixel sizes.
- Port colors, cable styles, port shapes and family glyphs live in src/ports.ts. Change them there, never per component.
- Node UI is generated from the `NodeDefinition` (ports, params). Don't special-case node types in components; if a node needs something new, extend the definition in the engine.
- Patch ⇄ graph conversion lives in src/patch-graph.ts. The patch document is the source of truth, and React Flow state is derived from it.
- The editor may import engine and nodes. Neither may import the editor.
- Check UI changes in the running app (Playwright screenshot), not only through typecheck.
