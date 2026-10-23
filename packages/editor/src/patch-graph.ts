import type { Connection, Edge, Node } from '@xyflow/react';
import { compilePatch, isModulatable, portsCompatible, portsOf, type NodeDefinition, type NumberParamSpec, type ParamValue, type Patch, type PatchCable, type PortSpec, type PortType } from '@flow-patcher/engine';
/** What a cable edge draws from. */
export type CableEdgeData = {
  portType: PortType;
  /** The cable in the document; absent on a refused cable. */
  cable?: PatchCable;
  /** The number param a cable modulates, when it ends on one. */
  param?: NumberParamSpec;
  /** A cable the editor refused, drawn in red with this reason until it fades. */
  refused?: string;
};

export interface PatchNodeData extends Record<string, unknown> {
  definition: NodeDefinition | null;
  type: string;
  params: Record<string, ParamValue>;
  /** Params with a cable in. */
  modulated: string[];
  /** What the node's unwired inputs say about it (`PortSpec.unwiredHint`), in port order. */
  hints: string[];
  /** In a loop with no delay edge: the document doesn't compile, and the last plan that did keeps playing. */
  inCycle?: boolean;
}

type Registry = ReadonlyMap<string, NodeDefinition>;

/** React Flow z-index above every node, selected ones included. */
export const ABOVE_NODES = 2000;

/** A param's handle id. Port names are identifiers, so the colon keeps it from colliding with one. */
export const paramHandle = (name: string) => `param:${name}`;
/** The param a handle id stands for, or undefined for a port handle. */
export const handleParam = (handle: string | null | undefined) => (handle?.startsWith('param:') ? handle.slice(6) : undefined);

/** A cable's edge id: its two ends, so it stays the same as other cables come and go. */
export const cableId = (cable: Pick<PatchCable, 'from' | 'to'>) => `${cable.from.node}.${cable.from.port}→${cable.to.node}.${cable.to.port}`;

/** Converts a patch document into React Flow nodes and edges. `selected` holds node and edge ids. */
export function patchToGraph(patch: Patch, registry: Registry, selected: ReadonlySet<string> = new Set()): { nodes: Node<PatchNodeData>[]; edges: Edge<CableEdgeData>[] } {
  const nodes = patch.nodes.map((node) => ({
    id: node.id,
    type: 'patch',
    position: node.position,
    selected: selected.has(node.id),
    data: {
      definition: registry.get(node.type) ?? null,
      type: node.type,
      params: node.params,
      modulated: [...new Set(patch.cables.filter((c) => c.to.node === node.id && !portOf(registry, node.type, 'in', c.to.port) && modulatableParam(registry, node.type, c.to.port)).map((c) => c.to.port))],
      hints: unwiredHints(patch, registry.get(node.type), node.id),
    },
  }));
  const typeOf = new Map(patch.nodes.map((node) => [node.id, node.type]));
  const edges = patch.cables.flatMap((cable): Edge<CableEdgeData>[] => {
    const type = typeOf.get(cable.to.node);
    // A cable ends on the port of that name, or on the handle of a param that takes a cable.
    const param = portOf(registry, type, 'in', cable.to.port) ? undefined : modulatableParam(registry, type, cable.to.port);
    if (!param && !portOf(registry, type, 'in', cable.to.port)) return [];
    const id = cableId(cable);
    const isSelected = selected.has(id);
    return [{
      id,
      type: 'cable',
      source: cable.from.node,
      sourceHandle: cable.from.port,
      target: cable.to.node,
      targetHandle: param ? paramHandle(param.name) : cable.to.port,
      selected: isSelected,
      // A selected cable is drawn above the nodes, so its whole path and remove control can be reached.
      ...(isSelected ? { zIndex: ABOVE_NODES } : {}),
      data: {
        portType: portOf(registry, typeOf.get(cable.from.node), 'out', cable.from.port)?.type ?? 'signal',
        cable,
        ...(param ? { param } : {}),
      },
    }];
  });
  return { nodes, edges };
}

function unwiredHints(patch: Patch, definition: NodeDefinition | undefined, id: string): string[] {
  if (!definition) return [];
  return portsOf(definition, 'in')
    .filter((p) => p.unwiredHint && !patch.cables.some((c) => c.to.node === id && c.to.port === p.name))
    .map((p) => p.unwiredHint!);
}

/** A number param on `type` that takes a cable. */
function modulatableParam(registry: Registry, type: string | undefined, name: string | undefined): NumberParamSpec | undefined {
  const spec = type === undefined ? undefined : registry.get(type)?.params.find((p) => p.name === name);
  return isModulatable(spec) ? spec : undefined;
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
 *  A param handle takes a Signal cable when the param is a number that can be modulated.
 *  A cycle without a delay edge is left to the compiler, so the editor can show it. */
export function cableFor(patch: Patch, registry: Registry, connection: Connection | Edge): PatchCable | null {
  const typeOf = (id: string) => patch.nodes.find((node) => node.id === id)?.type;
  const out = portOf(registry, typeOf(connection.source), 'out', connection.sourceHandle);
  const into = handlePort(patch, registry, connection.target, connection.targetHandle ?? null, 'in');
  if (!out || !into || !portsCompatible(out, into)) return null;
  const cable = { from: { node: connection.source, port: out.name }, to: { node: connection.target, port: handleParam(into.name) ?? into.name } };
  const id = cableId(cable);
  if (patch.cables.some((c) => cableId(c) === id)) return null;
  if (into.type === 'value' && patch.cables.some((c) => c.to.node === cable.to.node && c.to.port === cable.to.port)) return null;
  return cable;
}

/** Why a document can't be opened into the editor: it doesn't compile, or two cables share both ends
 *  (each cable's edge id is its ends). Empty when it can. A loop with no delay edge is no reason: the
 *  editor opens it and shows the loop on its nodes, so it can be fixed there. */
export function loadErrors(patch: Patch, registry: Registry): string[] {
  const seen = new Set<string>();
  const duplicates = patch.cables.flatMap((cable, i) => {
    const id = cableId(cable);
    if (seen.has(id)) return [`cables[${i}]: a second cable ${id.replace('→', ' → ')}`];
    seen.add(id);
    return [];
  });
  const compiled = compilePatch(patch, registry);
  // The compiler reports loops only once everything else checks out, and then nothing but the loops.
  return [...duplicates, ...(compiled.ok || compiled.cycles?.length ? [] : compiled.errors)];
}

/** A node type that converts between port types (`NodeDefinition.adapter`), offered for a cable that can't connect. */
export interface AdapterOffer {
  definition: NodeDefinition;
  input: PortSpec;
  output: PortSpec;
}

/** The adapters that fit between an output and an input whose types can't connect, in registry order.
 *  Empty when the two can connect already, or nothing converts one into the other. */
export function adaptersBetween(registry: Registry, from: PortSpec, to: PortSpec): AdapterOffer[] {
  if (portsCompatible(from, to)) return [];
  return [...registry.values()].flatMap((definition) => {
    const adapter = definition.adapter;
    const input = adapter && portsOf(definition, 'in').find((p) => p.name === adapter.input);
    const output = adapter && portsOf(definition, 'out').find((p) => p.name === adapter.output);
    return input && output && portsCompatible(from, input) && portsCompatible(output, to) ? [{ definition, input, output }] : [];
  });
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

/** The port a handle stands for. A param handle stands for a Signal input named by its handle id. */
export function handlePort(patch: Patch, registry: Registry, node: string, handle: string | null, direction: 'in' | 'out'): PortSpec | undefined {
  const type = patch.nodes.find((n) => n.id === node)?.type;
  const param = direction === 'in' ? handleParam(handle) : undefined;
  if (param === undefined) return portOf(registry, type, direction, handle);
  const spec = modulatableParam(registry, type, param);
  return spec && { name: paramHandle(spec.name), type: 'signal', direction: 'in', label: spec.label ?? spec.name };
}
