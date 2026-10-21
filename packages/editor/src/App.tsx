import { useMemo } from 'react';
import { Background, Controls, MiniMap, ReactFlow } from '@xyflow/react';
import { compilePatch, parsePatch } from '@flow-patcher/engine';
import { nodeRegistry } from '@flow-patcher/nodes';
import example from '../../../examples/clock-blips.flowpatch?raw';
import { patchToGraph } from './patch-graph';
import { PatchNode } from './PatchNode';

const nodeTypes = { patch: PatchNode };

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
        <strong>Flow Patcher</strong>
        <span data-testid="compile-status">{status}</span>
      </header>
      <main className="app__graph">
        <ReactFlow defaultNodes={graph.nodes} defaultEdges={graph.edges} nodeTypes={nodeTypes} fitView colorMode="dark">
          <Background />
          <MiniMap />
          <Controls />
        </ReactFlow>
      </main>
    </div>
  );
}
