import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow } from '@xyflow/react';
import { compilePatch, parsePatch } from '@flow-patcher/engine';
import { nodeRegistry } from '@flow-patcher/nodes';
import { patchToGraph } from './patch-graph';
import { PatchNode } from './PatchNode';
import { CableEdge } from './CableEdge';
import { LivePatch } from './live';
import { PreviewPane } from './PreviewPane';

const nodeTypes = { patch: PatchNode };
const edgeTypes = { cable: CableEdge };

const examples = import.meta.glob<string>('../../../examples/*.flowpatch', { query: '?raw', import: 'default', eager: true });

declare global {
  interface Window {
    /** The running patch, for e2e and the console. */
    flowPatcher?: LivePatch;
  }
}

/** `?patch=<name>` opens examples/<name>.flowpatch; clock-blips by default. Read once per page load. */
function load(): { graph: ReturnType<typeof patchToGraph>; status: string; live: LivePatch | null } {
  const empty = { graph: { nodes: [], edges: [] }, live: null };
  const name = new URLSearchParams(location.search).get('patch') ?? 'clock-blips';
  const source = examples[`../../../examples/${name}.flowpatch`];
  if (source === undefined) return { ...empty, status: `No example named "${name}"` };
  const parsed = parsePatch(JSON.parse(source));
  if (!parsed.ok) return { ...empty, status: parsed.errors.join('; ') };
  const compiled = compilePatch(parsed.patch, nodeRegistry);
  const graph = patchToGraph(parsed.patch, nodeRegistry);
  if (!compiled.ok) return { graph, status: compiled.errors.join('; '), live: null };
  return { graph, status: `${compiled.plan.order.length} nodes compiled`, live: new LivePatch(parsed.patch) };
}

// One running patch per page until live editing (#30) gives the editor a patch store.
const { graph, status, live } = load();
if (live) window.flowPatcher = live;
import.meta.hot?.dispose(() => live?.dispose());

export function App() {
  return (
    <div className="app">
      <header className="app__bar">
        <span className="app__name">Flow Patcher</span>
        <span className="app__status" data-testid="compile-status">{status}</span>
      </header>
      <main className="app__graph">
        <ReactFlow defaultNodes={graph.nodes} defaultEdges={graph.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} snapToGrid snapGrid={[20, 20]} fitView colorMode="dark">
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <MiniMap pannable zoomable nodeBorderRadius={8} />
          <Controls />
        </ReactFlow>
        <PreviewPane live={live} />
      </main>
    </div>
  );
}
