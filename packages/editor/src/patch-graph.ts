import type { Edge, Node } from '@xyflow/react';
import { portsOf, type NodeDefinition, type Patch } from '@flow-patcher/engine';
import type { CableEdgeData } from './CableEdge';

export interface PatchNodeData extends Record<string, unknown> {
  definition: NodeDefinition | null;
  type: string;
  params: Record<string, unknown>;
}

/** Converts a patch document into React Flow nodes and edges. */
export function patchToGraph(patch: Patch, registry: ReadonlyMap<string, NodeDefinition>): { nodes: Node<PatchNodeData>[]; edges: Edge<CableEdgeData>[] } {
  const nodes = patch.nodes.map((node) => ({
    id: node.id,
    type: 'patch',
    position: node.position,
    data: { definition: registry.get(node.type) ?? null, type: node.type, params: node.params },
  }));
  const typeOf = new Map(patch.nodes.map((node) => [node.id, node.type]));
  const edges = patch.cables.map((cable, i) => {
    const definition = registry.get(typeOf.get(cable.from.node) ?? '');
    const port = definition && portsOf(definition, 'out').find((p) => p.name === cable.from.port);
    return {
      id: `cable-${i}`,
      type: 'cable',
      source: cable.from.node,
      sourceHandle: cable.from.port,
      target: cable.to.node,
      targetHandle: cable.to.port,
      data: { portType: port?.type ?? 'signal' },
    };
  });
  return { nodes, edges };
}
