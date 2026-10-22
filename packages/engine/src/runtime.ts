// Graph compiler (M1) and the bootstrap runtime.
//
// `compilePatch` is the M1 graph compiler: it checks every cable against the
// port and fan-in rules, marks delay edges (cables into a Delay Edge node, and
// Field → Signal reads), sorts the nodes over the other cables and rejects any
// cycle without a delay edge, naming its nodes and cables (ADR 0010). The plan
// is plain data, so the scheduler can swap it.
//
// `Runtime` is still the bootstrap runtime until the scheduler lands (#19):
// window queries, frames and audio setup, but no hot patching, rewind, runtime
// limits or scheduling. Keep its public shape (compile → query/frame/attachAudio)
// where it fits.
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
  /** A delay edge: it doesn't order the plan, so it may close a cycle. */
  delay?: true;
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
  /** Nodes in topological order over every non-Audio cable that isn't a delay edge. */
  order: PlanNode[];
  /** Incoming non-Audio cables per node id. */
  incoming: Map<string, NodeLinks>;
  /** Audio cables, in patch order. */
  audioCables: { from: PortRef; to: PortRef }[];
  /** Indices into `patch.cables` of the delay edges, ascending. */
  delayEdges: number[];
  /** Widest window the runtime may query at once: the smallest delay of the
   *  plan's delay nodes, or Infinity when it has none. */
  maxWindow: number;
}

/** One cycle without a delay edge: its nodes in cable order, and the indices into
 *  `patch.cables` of the cables that close it (`cables[i]` runs from `nodes[i]`
 *  to `nodes[i + 1]`, wrapping around). */
export interface Cycle {
  nodes: string[];
  cables: number[];
}

export type CompileResult = { ok: true; plan: Plan } | { ok: false; errors: string[]; cycles?: Cycle[] };

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
  /** Non-Audio cables that order the plan; delay edges are left out. */
  const edges: Edge[] = [];
  const delayEdges: number[] = [];
  /** Delay nodes with a delay edge into them; only these limit the window. */
  const delaying = new Set<string>();
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
      else {
        links.params.push({ ...link, depth: cable.depth ?? 1 });
        edges.push({ from: source.id, to: target.id, cable: i });
      }
      continue;
    }
    if (!portsCompatible(out, into)) {
      errors.push(`${where}: cannot connect ${describePort(out)} to ${describePort(into)}`);
      continue;
    }
    if (out.type !== 'audio') {
      if (isDelayEdge(out, target.definition)) {
        link.delay = true;
        delayEdges.push(i);
        if (target.definition.delay) delaying.add(target.id);
      } else edges.push({ from: source.id, to: target.id, cable: i });
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

  // Kahn's algorithm over the ordering edges, stable in patch order.
  const remaining = new Map([...nodes.keys()].map((id) => [id, new Set<string>()]));
  for (const edge of edges) remaining.get(edge.to)!.add(edge.from);
  const order: PlanNode[] = [];
  while (remaining.size) {
    const ready = [...remaining].find(([, deps]) => deps.size === 0);
    if (!ready) {
      const cycles = findCycles([...remaining.keys()], edges);
      return {
        ok: false,
        errors: cycles.map((c) => `cycle without a delay edge through: ${[...c.nodes, c.nodes[0]].join(' → ')}`),
        cycles,
      };
    }
    const [id] = ready;
    remaining.delete(id);
    for (const deps of remaining.values()) deps.delete(id);
    order.push(nodes.get(id)!);
  }

  // Delay nodes see the previous chunk's inputs, so a chunk must be no wider
  // than the shortest delay for the output to depend only on event times.
  let maxWindow = Infinity;
  for (const node of order) {
    if (!node.definition.delay) continue;
    const delay = node.definition.delay(node.params);
    // NaN, zero or a negative delay can't close a cycle without making the
    // output depend on the windowing; +Infinity just imposes no limit.
    if (!(delay > 0)) errors.push(`node "${node.id}": delay must be a positive number of seconds, got ${delay}`);
    // An unwired delay node has nothing to delay, so it doesn't shrink every window.
    else if (delaying.has(node.id)) maxWindow = Math.min(maxWindow, delay);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, plan: { seed: patch.seed, order, incoming, audioCables, delayEdges, maxWindow } };
}

interface Edge {
  from: string;
  to: string;
  /** Index into `patch.cables`. */
  cable: number;
}

/** True when the node has a Signal output port. */
const hasSignalOutput = (definition: NodeDefinition) => definition.ports.some((p) => p.direction === 'out' && p.type === 'signal');

/**
 * Delay edges (ADR 0010): Event/Note cables into a delay node (Delay Edge),
 * and Field cables into a node with a Signal output (a Field → Signal read,
 * which returns the previous frame). Signal and Value cables into a delay node
 * still order the plan: they are sampled lazily, so a cycle through them would
 * recurse instead of waiting a window.
 */
function isDelayEdge(out: PortSpec, target: NodeDefinition): boolean {
  if (out.type === 'event' || out.type === 'note') return target.delay !== undefined;
  if (out.type === 'field') return hasSignalOutput(target);
  return false;
}

/**
 * One simple cycle per strongly connected component that has one (Tarjan's
 * algorithm), over the nodes the sort got stuck on. Deterministic: nodes are
 * visited in patch order and edges in cable order.
 */
function findCycles(stuck: string[], edges: Edge[]): Cycle[] {
  const inStuck = new Set(stuck);
  const out = new Map<string, Edge[]>(stuck.map((id) => [id, []]));
  for (const edge of [...edges].sort((a, b) => a.cable - b.cable)) {
    if (inStuck.has(edge.from) && inStuck.has(edge.to)) out.get(edge.from)!.push(edge);
  }

  const index = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], onStack = new Set<string>();
  const components: string[][] = [];
  const connect = (v: string) => {
    index.set(v, index.size);
    low.set(v, index.get(v)!);
    stack.push(v);
    onStack.add(v);
    for (const { to } of out.get(v)!) {
      if (!index.has(to)) {
        connect(to);
        low.set(v, Math.min(low.get(v)!, low.get(to)!));
      } else if (onStack.has(to)) low.set(v, Math.min(low.get(v)!, index.get(to)!));
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  };
  for (const id of stuck) if (!index.has(id)) connect(id);

  const order = new Map(stuck.map((id, i) => [id, i]));
  const cycles: Cycle[] = [];
  for (const component of components) {
    const members = new Set(component);
    const start = component.reduce((a, b) => (order.get(a)! < order.get(b)! ? a : b));
    if (component.length === 1 && !out.get(start)!.some((e) => e.to === start)) continue;
    // DFS from the first node in patch order until an edge leads back to it:
    // the path on the stack is then a simple cycle.
    const nodes: string[] = [], cables: number[] = [], seen = new Set<string>();
    const walk = (v: string): boolean => {
      seen.add(v);
      nodes.push(v);
      for (const edge of out.get(v)!) {
        if (!members.has(edge.to)) continue;
        cables.push(edge.cable);
        if (edge.to === start || (!seen.has(edge.to) && walk(edge.to))) return true;
        cables.pop();
      }
      nodes.pop();
      return false;
    };
    walk(start);
    cycles.push({ nodes, cables });
  }
  return cycles.sort((a, b) => order.get(a.nodes[0]!)! - order.get(b.nodes[0]!)!);
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
  /**
   * Inputs each delay node received in the last chunk, per node id and input
   * port; its next query sees them. This is runtime state like `states`: the
   * scheduler's rewind snapshots (#19) must include this map.
   */
  private readonly delayInputs = new Map<string, Record<string, EngineEvent[]>>();

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

  /**
   * Runs every Event node over [t0, t1) and returns the events in time order.
   * A window wider than `plan.maxWindow` runs as consecutive chunks no wider
   * than it, so delay nodes see their inputs one chunk late but never late
   * enough to change an event's time.
   */
  query(t0: number, t1: number): LoggedEvent[] {
    const log: LoggedEvent[] = [];
    // A hair under the shortest delay, so t + delay can't round below the next
    // chunk's start and leave a delayed event a chunk late. Rounding may add a
    // tiny trailing chunk, which is harmless.
    const width = t1 - t0, step = this.plan.maxWindow * (1 - 1e-6);
    const chunks = width > step ? Math.ceil(width / step) : 1;
    // Index × step, not a running sum, so chunk edges don't drift; the last ends exactly at t1.
    // (One chunk is the whole window: step may be Infinity, and 0 × Infinity is NaN.)
    for (let i = 0; i < chunks; i++) {
      this.queryChunk(i === 0 ? t0 : t0 + i * step, i === chunks - 1 ? t1 : t0 + (i + 1) * step, log);
    }
    // Time order (stable, so chunk then plan order breaks ties): concatenated
    // windows then give the same log however time was split.
    return log.sort(compareEvents);
  }

  private queryChunk(t0: number, t1: number, log: LoggedEvent[]): void {
    const outputs = new Map<string, Record<string, EngineEvent[]>>();
    for (const node of this.plan.order) {
      const { definition } = node;
      const inputs = definition.delay ? (this.delayInputs.get(node.id) ?? {}) : this.gatherInputs(node.id, outputs);
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
    // Delay nodes get this chunk's inputs in the next chunk (or the next query).
    for (const node of this.plan.order) {
      if (node.definition.delay) this.delayInputs.set(node.id, this.gatherInputs(node.id, outputs));
    }
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
