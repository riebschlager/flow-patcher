// Bootstrap runtime: just enough evaluation for the headless runner and tests.
//
// It compiles a patch into a sorted plan and runs window queries, frames and
// audio setup. It is NOT the M1 engine: no delay edges (every cycle is
// rejected), no signal or parameter modulation, no hot patching, no runtime
// limits and no scheduler. The M1 graph compiler and scheduler replace this
// file; keep its public shape (compile → query/frame/attachAudio) where it fits.
import type { AudioContextLike } from './audio/types';
import {
  resolveParams,
  type AudioInstance,
  type NodeDefinition,
  type NodeImage,
  type NodeState,
  type ParamValues,
  type PortSpec,
} from './definition';
import { compareEvents, type EngineEvent, type EventField } from './events';
import type { Patch, PortRef } from './patch';

export interface PlanNode {
  id: string;
  definition: NodeDefinition;
  params: ParamValues;
}

interface Link {
  from: PortRef;
  toPort: string;
}

export interface Plan {
  seed: number;
  /** Nodes in topological order over Event/Note cables. */
  order: PlanNode[];
  /** Incoming Event/Note cables per node id. */
  incoming: Map<string, Link[]>;
  /** Audio cables, in patch order. */
  audioCables: { from: PortRef; to: PortRef }[];
}

export type CompileResult = { ok: true; plan: Plan } | { ok: false; errors: string[] };

export type DefinitionLookup = ReadonlyMap<string, NodeDefinition>;

const isEventLike = (port: PortSpec) => port.type === 'event' || port.type === 'note';

/** Note is an Event subtype: a Note output can feed an Event input, not the reverse. */
export function portsCompatible(from: PortSpec, to: PortSpec): boolean {
  return from.type === to.type || (from.type === 'note' && to.type === 'event');
}

export function compilePatch(patch: Patch, definitions: DefinitionLookup): CompileResult {
  const errors: string[] = [];
  const nodes = new Map<string, PlanNode>();
  for (const node of patch.nodes) {
    const definition = definitions.get(node.type);
    if (!definition) {
      errors.push(`node "${node.id}": unknown type "${node.type}"`);
      continue;
    }
    nodes.set(node.id, { id: node.id, definition, params: resolveParams(definition, node.params) });
  }

  const incoming = new Map<string, Link[]>([...nodes.keys()].map((id) => [id, []]));
  const audioCables: Plan['audioCables'] = [];
  for (const [i, cable] of patch.cables.entries()) {
    const where = `cables[${i}] ${cable.from.node}.${cable.from.port} → ${cable.to.node}.${cable.to.port}`;
    const source = nodes.get(cable.from.node), target = nodes.get(cable.to.node);
    if (!source || !target) {
      errors.push(`${where}: unknown node`);
      continue;
    }
    const out = source.definition.ports.find((p) => p.name === cable.from.port && p.direction === 'out');
    const into = target.definition.ports.find((p) => p.name === cable.to.port && p.direction === 'in');
    if (!out || !into) {
      errors.push(`${where}: unknown port`);
      continue;
    }
    if (!portsCompatible(out, into)) {
      errors.push(`${where}: cannot connect ${out.type} to ${into.type}`);
      continue;
    }
    if (isEventLike(out)) incoming.get(target.id)!.push({ from: cable.from, toPort: cable.to.port });
    else if (out.type === 'audio') audioCables.push({ from: cable.from, to: cable.to });
    else errors.push(`${where}: ${out.type} cables are not supported by the bootstrap runtime yet`);
  }
  if (errors.length) return { ok: false, errors };

  // Kahn's algorithm, stable in patch order.
  const remaining = new Map([...nodes.keys()].map((id) => [id, new Set(incoming.get(id)!.map((l) => l.from.node))]));
  const order: PlanNode[] = [];
  while (remaining.size) {
    const ready = [...remaining].find(([, deps]) => deps.size === 0);
    if (!ready) {
      return { ok: false, errors: [`cycle without a delay edge through: ${[...remaining.keys()].join(', ')}`] };
    }
    const [id] = ready;
    remaining.delete(id);
    for (const deps of remaining.values()) deps.delete(id);
    order.push(nodes.get(id)!);
  }
  return { ok: true, plan: { seed: patch.seed, order, incoming, audioCables } };
}

/** One event as it appears in a run's log. */
export interface LoggedEvent {
  node: string;
  port: string;
  time: number;
  channel: number;
  [field: string]: EventField;
}

export class Runtime {
  readonly plan: Plan;
  private readonly states = new Map<string, NodeState>();
  private readonly audio = new Map<string, AudioInstance>();
  /** Events waiting for visual nodes, per node id and input port. */
  private readonly pendingFrames = new Map<string, Map<string, EngineEvent[]>>();

  constructor(plan: Plan) {
    this.plan = plan;
    for (const node of plan.order) this.states.set(node.id, {});
  }

  /** Runs every Event node over [t0, t1) and returns the events in time order. */
  query(t0: number, t1: number): LoggedEvent[] {
    const outputs = new Map<string, Record<string, EngineEvent[]>>();
    const log: LoggedEvent[] = [];
    for (const node of this.plan.order) {
      const inputs = this.gatherInputs(node.id, outputs);
      const { definition } = node;
      const result: Record<string, EngineEvent[]> = {};
      if (definition.query) {
        const raw = definition.query({ nodeId: node.id, seed: this.plan.seed, params: node.params, state: this.states.get(node.id)!, inputs, t0, t1 });
        for (const [port, events] of Object.entries(raw)) {
          if (!events?.length) continue;
          result[port] = [...events].sort(compareEvents);
          for (const event of result[port]) log.push({ node: node.id, port, ...event });
        }
      }
      outputs.set(node.id, result);
      const instance = this.audio.get(node.id);
      if (instance?.schedule) for (const [port, events] of Object.entries(inputs)) if (events.length) instance.schedule(port, events);
      if (definition.frame) this.queueForFrame(node.id, inputs);
    }
    // Time order (stable, so plan order breaks ties): concatenated windows then
    // give the same log however time was split.
    return log.sort(compareEvents);
  }

  /** Steps every visual node with the events whose time is before t1. */
  frame(t0: number, t1: number, dt: number): void {
    for (const node of this.plan.order) {
      if (!node.definition.frame) continue;
      const pending = this.pendingFrames.get(node.id) ?? new Map<string, EngineEvent[]>();
      const inputs: Record<string, EngineEvent[]> = {};
      for (const [port, events] of pending) {
        inputs[port] = events.filter((e) => e.time < t1);
        pending.set(port, events.filter((e) => e.time >= t1));
      }
      node.definition.frame({ nodeId: node.id, seed: this.plan.seed, params: node.params, state: this.states.get(node.id)!, inputs, t0, t1, dt });
    }
  }

  /** Builds every audio node's Web Audio graph and connects the audio cables. */
  attachAudio(context: AudioContextLike): void {
    for (const node of this.plan.order) {
      if (!node.definition.audio) continue;
      this.audio.set(node.id, node.definition.audio({ audio: context, params: node.params, state: this.states.get(node.id)! }));
    }
    for (const cable of this.plan.audioCables) {
      const out = this.audio.get(cable.from.node)?.outputs?.[cable.from.port];
      const into = this.audio.get(cable.to.node)?.inputs?.[cable.to.port];
      if (out && into) out.connect(into);
    }
  }

  images(): { node: string; image: NodeImage }[] {
    const images: { node: string; image: NodeImage }[] = [];
    for (const node of this.plan.order) {
      const image = node.definition.image?.(this.states.get(node.id)!, node.params);
      if (image) images.push({ node: node.id, image });
    }
    return images;
  }

  dispose(): void {
    for (const instance of this.audio.values()) instance.dispose?.();
    this.audio.clear();
  }

  private gatherInputs(id: string, outputs: Map<string, Record<string, EngineEvent[]>>): Record<string, EngineEvent[]> {
    const inputs: Record<string, EngineEvent[]> = {};
    for (const link of this.plan.incoming.get(id) ?? []) {
      const events = outputs.get(link.from.node)?.[link.from.port];
      if (events?.length) (inputs[link.toPort] ??= []).push(...events);
    }
    // Several cables into one Event input merge in time order.
    for (const events of Object.values(inputs)) events.sort(compareEvents);
    return inputs;
  }

  private queueForFrame(id: string, inputs: Record<string, EngineEvent[]>): void {
    let pending = this.pendingFrames.get(id);
    if (!pending) this.pendingFrames.set(id, (pending = new Map()));
    for (const [port, events] of Object.entries(inputs)) pending.set(port, [...(pending.get(port) ?? []), ...events]);
  }
}
