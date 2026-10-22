// Bootstrap runtime: just enough evaluation for the headless runner and tests.
//
// It compiles a patch into a sorted plan and runs window queries, frames and
// audio setup, with the fan-in rules for all six port types. It is NOT the M1
// engine: no delay edges (every cycle is rejected), no hot patching, no runtime
// limits and no scheduler. The M1 graph compiler and scheduler replace this
// file; keep its public shape (compile → query/frame/attachAudio) where it fits.
import type { AudioContextLike } from './audio/types';
import { createNodeContext, type BoundContext, type NodeWiring } from './context';
import {
  isModulatable,
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

export interface Link {
  from: PortRef;
  /** Input port, or param name for `params` links. */
  toPort: string;
}

/** The cables into one node, grouped by how they fan in. */
export interface NodeLinks {
  /** Event/Note: merged in time order. */
  events: Link[];
  /** Signal: summed. */
  signals: Link[];
  /** Value: one per input. */
  values: Link[];
  /** Field: every cable's object, in patch order. */
  fields: Link[];
  /** Signal cables into a number param: base + depth × cable. */
  params: (Link & { depth: number })[];
}

export interface Plan {
  seed: number;
  /** Nodes in topological order over every non-Audio cable. */
  order: PlanNode[];
  /** Incoming non-Audio cables per node id. */
  incoming: Map<string, NodeLinks>;
  /** Audio cables, in patch order. */
  audioCables: { from: PortRef; to: PortRef }[];
}

export type CompileResult = { ok: true; plan: Plan } | { ok: false; errors: string[] };

export type DefinitionLookup = ReadonlyMap<string, NodeDefinition>;

const fieldKind = (port: PortSpec) => port.fieldKind ?? 'fluid';
const describePort = (port: PortSpec) => (port.type === 'field' ? `field (${fieldKind(port)})` : port.type);

/** Note is an Event subtype: a Note output can feed an Event input, not the reverse. Field kinds must match. */
export function portsCompatible(from: PortSpec, to: PortSpec): boolean {
  if (from.type === 'field' || to.type === 'field') return from.type === to.type && fieldKind(from) === fieldKind(to);
  return from.type === to.type || (from.type === 'note' && to.type === 'event');
}

const emptyLinks = (): NodeLinks => ({ events: [], signals: [], values: [], fields: [], params: [] });

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

  const incoming = new Map<string, NodeLinks>([...nodes.keys()].map((id) => [id, emptyLinks()]));
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
    const param = into ? undefined : target.definition.params.find((p) => p.name === cable.to.port);
    if (!out || (!into && !param)) {
      errors.push(`${where}: unknown port`);
      continue;
    }
    const links = incoming.get(target.id)!;
    const link: Link = { from: cable.from, toPort: cable.to.port };
    if (!into) {
      // A cable into a parameter: a Signal added to the knob, scaled by depth.
      if (param!.kind !== 'number') errors.push(`${where}: parameter "${param!.name}" is not a number`);
      else if (!isModulatable(param)) errors.push(`${where}: parameter "${param!.name}" cannot be modulated`);
      else if (out.type !== 'signal') errors.push(`${where}: only signal cables can feed a parameter, not ${out.type}`);
      else links.params.push({ ...link, depth: cable.depth ?? 1 });
      continue;
    }
    if (!portsCompatible(out, into)) {
      errors.push(`${where}: cannot connect ${describePort(out)} to ${describePort(into)}`);
      continue;
    }
    switch (out.type) {
      case 'event':
      case 'note':
        links.events.push(link);
        break;
      case 'signal':
        links.signals.push(link);
        break;
      case 'value':
        if (links.values.some((l) => l.toPort === link.toPort)) errors.push(`${where}: value input "${link.toPort}" already has a cable`);
        else links.values.push(link);
        break;
      case 'field':
        links.fields.push(link);
        break;
      case 'audio':
        audioCables.push({ from: cable.from, to: cable.to });
        break;
    }
  }
  if (errors.length) return { ok: false, errors };

  // Kahn's algorithm, stable in patch order.
  const sourcesOf = (links: NodeLinks) => Object.values(links).flatMap((group: Link[]) => group.map((l) => l.from.node));
  const remaining = new Map([...nodes.keys()].map((id) => [id, new Set(sourcesOf(incoming.get(id)!))]));
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
  private readonly contexts = new Map<string, BoundContext>();
  private readonly audio = new Map<string, AudioInstance>();
  /** Events waiting for visual nodes, per node id and input port. */
  private readonly pendingFrames = new Map<string, Map<string, EngineEvent[]>>();

  constructor(plan: Plan) {
    this.plan = plan;
    for (const node of plan.order) this.states.set(node.id, {});
    for (const node of plan.order) {
      const context = createNodeContext(
        { nodeId: node.id, seed: plan.seed, definition: node.definition, params: node.params, state: this.states.get(node.id)! },
        this.wiring(plan.incoming.get(node.id) ?? emptyLinks()),
      );
      this.contexts.set(node.id, context);
    }
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
        const raw = definition.query({ ...this.contexts.get(node.id)!, inputs, t0, t1 });
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
      node.definition.frame({ ...this.contexts.get(node.id)!, inputs, t0, t1, dt });
    }
  }

  /** Builds every audio node's Web Audio graph and connects the audio cables. */
  attachAudio(context: AudioContextLike): void {
    for (const node of this.plan.order) {
      if (!node.definition.audio) continue;
      const { param } = this.contexts.get(node.id)!;
      this.audio.set(node.id, node.definition.audio({ audio: context, params: node.params, state: this.states.get(node.id)!, param }));
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
    for (const link of this.plan.incoming.get(id)?.events ?? []) {
      const events = outputs.get(link.from.node)?.[link.from.port];
      if (events?.length) (inputs[link.toPort] ??= []).push(...events);
    }
    // Several cables into one Event input merge in time order.
    for (const events of Object.values(inputs)) events.sort(compareEvents);
    return inputs;
  }

  /** Source accessors for a node's cables. Sources are looked up per call, so build order doesn't matter. */
  private wiring(links: NodeLinks): NodeWiring {
    const source = (link: Link) => ({ node: this.plan.order.find((n) => n.id === link.from.node)!, port: link.from.port });
    const signal = (link: Link) => {
      const { node, port } = source(link);
      return (t: number, channel: number) => node.definition.signal?.(this.contexts.get(node.id)!, port, t, channel) ?? 0;
    };
    const group = <L extends Link, T>(list: L[], make: (link: L) => T): Record<string, T[]> => {
      const out: Record<string, T[]> = {};
      for (const link of list) (out[link.toPort] ??= []).push(make(link));
      return out;
    };
    return {
      events: [...new Set(links.events.map((l) => l.toPort))],
      signals: group(links.signals, signal),
      values: Object.fromEntries(links.values.map((link) => {
        const { node, port } = source(link);
        return [link.toPort, (t: number) => node.definition.value?.(this.contexts.get(node.id)!, port, t)];
      })),
      fields: group(links.fields, (link) => {
        const { node, port } = source(link);
        return () => node.definition.field?.(this.contexts.get(node.id)!, port);
      }),
      mods: group(links.params, (link) => ({ depth: link.depth, signal: signal(link) })),
    };
  }

  private queueForFrame(id: string, inputs: Record<string, EngineEvent[]>): void {
    let pending = this.pendingFrames.get(id);
    if (!pending) this.pendingFrames.set(id, (pending = new Map()));
    for (const [port, events] of Object.entries(inputs)) pending.set(port, [...(pending.get(port) ?? []), ...events]);
  }
}
