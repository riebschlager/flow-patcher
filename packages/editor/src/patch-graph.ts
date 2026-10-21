import type { Edge, Node } from '@xyflow/react';
import type { NodeDefinition, Patch } from '@flow-patcher/engine';

export interface PatchNodeData extends Record<string, unknown> {
  definition: NodeDefinition | null;
  type: string;
  params: Record<string, unknown>;
}

/** Converts a patch document into React Flow nodes and edges. */
export function patchToGraph(patch: Patch, registry: ReadonlyMap<string, NodeDefinition>): { nodes: Node<PatchNodeData>[]; edges: Edge[] } {
  const nodes = patch.nodes.map((node) => ({
    id: node.id,
    type: 'patch',
    position: node.position,
    data: { definition: registry.get(node.type) ?? null, type: node.type, params: node.params },
  }));
  const edges = patch.cables.map((cable, i) => ({
    id: `cable-${i}`,
    source: cable.from.node,
    sourceHandle: cable.from.port,
    target: cable.to.node,
    targetHandle: cable.to.port,
  }));
  return { nodes, edges };
}
