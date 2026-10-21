import { useMemo } from 'react';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow } from '@xyflow/react';
import { compilePatch, parsePatch } from '@flow-patcher/engine';
import { nodeRegistry } from '@flow-patcher/nodes';
import example from '../../../examples/clock-blips.flowpatch?raw';
import { patchToGraph } from './patch-graph';
import { PatchNode } from './PatchNode';
import { CableEdge } from './CableEdge';

const nodeTypes = { patch: PatchNode };
const edgeTypes = { cable: CableEdge };

export function App() {
  const { graph, status } = useMemo(() => {
    const parsed = parsePatch(JSON.parse(example));
    if (!parsed.ok) return { graph: { nodes: [], edges: [] }, status: parsed.errors.join('; ') };
    const compiled = compilePatch(parsed.patch, nodeRegistry);
    return {
      graph: patchToGraph(parsed.patch, nodeRegistry),
      status: compiled.ok ? `${compiled.plan.order.length} nodes compiled` : compiled.errors.join('; '),
    };
  }, []);

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
      </main>
    </div>
  );
}
