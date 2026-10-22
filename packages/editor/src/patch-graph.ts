import type { Connection, Edge, Node } from '@xyflow/react';
import { portsCompatible, portsOf, type NodeDefinition, type Patch, type PatchCable, type PortSpec } from '@flow-patcher/engine';
import type { CableEdgeData } from './CableEdge';

export interface PatchNodeData extends Record<string, unknown> {
  definition: NodeDefinition | null;
  type: string;
  params: Record<string, unknown>;
}

type Registry = ReadonlyMap<string, NodeDefinition>;

/** A cable's edge id: its two ends, so it stays the same as other cables come and go. */
export const cableId = (cable: Pick<PatchCable, 'from' | 'to'>) => `${cable.from.node}.${cable.from.port}→${cable.to.node}.${cable.to.port}`;

/** Converts a patch document into React Flow nodes and edges. `selected` holds node and edge ids. */
export function patchToGraph(patch: Patch, registry: Registry, selected: ReadonlySet<string> = new Set()): { nodes: Node<PatchNodeData>[]; edges: Edge<CableEdgeData>[] } {
  const nodes = patch.nodes.map((node) => ({
    id: node.id,
    type: 'patch',
    position: node.position,
    selected: selected.has(node.id),
    data: { definition: registry.get(node.type) ?? null, type: node.type, params: node.params },
  }));
  const typeOf = new Map(patch.nodes.map((node) => [node.id, node.type]));
  const edges = patch.cables.map((cable) => {
    const id = cableId(cable);
    return {
      id,
      type: 'cable',
      source: cable.from.node,
      sourceHandle: cable.from.port,
      target: cable.to.node,
      targetHandle: cable.to.port,
      selected: selected.has(id),
      data: { portType: portOf(registry, typeOf.get(cable.from.node), 'out', cable.from.port)?.type ?? 'signal' },
    };
  });
  return { nodes, edges };
}

function portOf(registry: Registry, type: string | undefined, direction: 'in' | 'out', name: string | null | undefined): PortSpec | undefined {
  const definition = type === undefined ? undefined : registry.get(type);
  return definition && portsOf(definition, direction).find((p) => p.name === name);
}

/** A node id not yet in the patch: the type, then a number from 1. */
export function nextNodeId(patch: Patch, type: string): string {
  const ids = new Set(patch.nodes.map((node) => node.id));
  for (let n = 1; ; n++) if (!ids.has(`${type}-${n}`)) return `${type}-${n}`;
}

/** The cable a React Flow connection makes, or null when the editor refuses it: an unknown port,
 *  types that can't connect, a cable that's already there, or a second cable into a Value input.
 *  A cycle without a delay edge is left to the compiler, so the editor can show it. */
export function cableFor(patch: Patch, registry: Registry, connection: Connection | Edge): PatchCable | null {
  const typeOf = (id: string) => patch.nodes.find((node) => node.id === id)?.type;
  const out = portOf(registry, typeOf(connection.source), 'out', connection.sourceHandle);
  const into = portOf(registry, typeOf(connection.target), 'in', connection.targetHandle);
  if (!out || !into || !portsCompatible(out, into)) return null;
  const cable = { from: { node: connection.source, port: out.name }, to: { node: connection.target, port: into.name } };
  const id = cableId(cable);
  if (patch.cables.some((c) => cableId(c) === id)) return null;
  if (into.type === 'value' && patch.cables.some((c) => c.to.node === cable.to.node && c.to.port === cable.to.port)) return null;
  return cable;
}

/** A port a cable was dragged from, on its way to the palette. */
export interface CableEnd {
  node: string;
  port: PortSpec;
}

/** The port on `definition` a cable from `end` would connect to: the first compatible one facing it. */
export function matchingPort(definition: NodeDefinition, end: CableEnd): PortSpec | undefined {
  const from = end.port.direction === 'out';
  return portsOf(definition, from ? 'in' : 'out').find((p) => (from ? portsCompatible(end.port, p) : portsCompatible(p, end.port)));
}

/** The port a handle stands for. */
export function handlePort(patch: Patch, registry: Registry, node: string, handle: string | null, direction: 'in' | 'out'): PortSpec | undefined {
  return portOf(registry, patch.nodes.find((n) => n.id === node)?.type, direction, handle);
}
