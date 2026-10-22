// Graph compiler (M1) and the bootstrap runtime.
//
// `compilePatch` is the M1 graph compiler: it checks every cable against the
// port and fan-in rules, marks delay edges (cables into a Delay Edge node, and
// Field → Signal reads), sorts the nodes over the other cables and rejects any
// cycle without a delay edge, naming its nodes and cables (ADR 0010). The plan
// is plain data, so the scheduler can swap it.
//
// `Runtime` evaluates a plan: window queries, frames, audio setup, and the
// rewind and re-query of live events (ADR 0019). It keeps no clock; the
// Scheduler (scheduler.ts) decides which windows to query and when. Hot
// patching and runtime limits are still to come.
import type { AudioContextLike } from './audio/types';
import { createNodeContext, type BoundContext, type NodeWiring } from './context';
import {
  isModulatable,
  portsOf,
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
import { clonePlain, restoreState } from './state';

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

/** How one call hands events to audio nodes. The scheduler fills it in. */
export interface DeliveryTiming {
  /** The audio clock now. An event before it is handed over at `now` and counted late. */
  now: number;
  /** A late wake's missed stretch (ADR 0017): events before `until` move `shift`
   *  seconds later, so they keep their spacing and play late instead of stacking. */
  catchUp?: { until: number; shift: number };
  /** The path the events took, for the late counters. Default 'scheduled'. */
  path?: 'scheduled' | 'immediate';
}

/** A rewind's timing: only events at the live event's own time count as immediate (ADR 0020). */
interface RewindTiming extends DeliveryTiming {
  immediateAt?: number;
}

/** Running totals of what the runtime handed to audio nodes. */
export interface RuntimeCounters {
  /** Events handed to audio nodes. */
  delivered: number;
  /** Events a catch-up moved later. */
  caughtUp: number;
  /** Scheduled events that were still before currentTime, moved to it. */
  lateScheduled: number;
  /** Immediate-path events that were before currentTime, moved to it. */
  lateImmediate: number;
  /** Events withdrawn from audio nodes because a rewind replaced them. */
  cancelled: number;
  /** Withdrawals an audio node couldn't make, because it has no cancel(). */
  uncancelled: number;
  /** Events a node returned outside its query window, dropped. */
  outOfWindow: number;
  /** Node queries made, re-runs included. */
  queries: number;
  /** Node states (and delay inputs) copied into window snapshots. Empty states aren't copied. */
  snapshots: number;
  /** Wall-clock milliseconds spent copying them (0 without a wall clock; see keepHistory). */
  snapshotMs: number;
}

/** What one live event's rewind and re-query cost (ADR 0019). */
export interface RewindReport {
  /** The live event's time. */
  time: number;
  /** The window boundary the re-run started from: the latest snapshot at or before `time`. */
  from: number;
  /** The end of the re-run: the scheduler's horizon. */
  to: number;
  /** The nodes re-run: the pushing node and every node downstream of it. */
  affected: ReadonlySet<string>;
  /** Signal and Value sources upstream of the re-run nodes, outside them: queried again
   *  so their state matches each re-run chunk, but nothing they emit is replaced. */
  followed: ReadonlySet<string>;
  /** Node queries made, replay included. */
  queries: number;
  /** Logged events at or after `time` from affected nodes that the re-run replaced. */
  removed: number;
  /** The re-run's logged events at or after `time`. */
  added: LoggedEvent[];
}

export interface RuntimeOptions {
  /** Keep window snapshots so live events can rewind (ADR 0019). The scheduler turns it on. */
  history?: boolean;
}

type PortEvents = Record<string, EngineEvent[]>;

/** One queried window and the state at its start. */
interface WindowRecord {
  t0: number;
  t1: number;
  /** Copies of every query node's state as the window began; a node with empty state has no entry. */
  states: Map<string, NodeState>;
  /** Copies of the inputs each delay node was holding as the window began. */
  delayInputs: Map<string, PortEvents>;
}

/** An event handed to an audio node: as computed, and as sent (maybe moved later). */
interface Sent {
  event: EngineEvent;
  sent: EngineEvent;
}

interface Injected {
  node: string;
  port: string;
  event: EngineEvent;
}

/** Which nodes a re-run chunk queries. */
interface Scope {
  /** Re-run: queried, and what they emit replaces what they emitted before. */
  only: ReadonlySet<string>;
  /** Queried only to keep their state in step; their outputs replay what they emitted the first time. */
  follow: ReadonlySet<string>;
}

/** What a chunk does with its results. Without it the chunk only advances state (a replay). */
interface Emit {
  log: LoggedEvent[];
  timing?: RewindTiming;
  /** A rewind's re-run: diff audio deliveries against what was already sent. */
  rewind?: boolean;
}

export class Runtime {
  readonly plan: Plan;
  readonly counters: RuntimeCounters = { delivered: 0, caughtUp: 0, lateScheduled: 0, lateImmediate: 0, cancelled: 0, uncancelled: 0, outOfWindow: 0, queries: 0, snapshots: 0, snapshotMs: 0 };
  private readonly states = new Map<string, NodeState>();
  private readonly contexts = new Map<string, BoundContext>();
  private readonly audio = new Map<string, AudioInstance>();
  /** Events waiting for visual nodes, per node id and input port. */
  private readonly pendingFrames = new Map<string, Map<string, EngineEvent[]>>();
  /**
   * Inputs each delay node received in the last chunk, per node id and input
   * port; its next query sees them. Runtime state like `states`, so window
   * snapshots include it.
   */
  private readonly delayInputs = new Map<string, PortEvents>();
  /** Plan position per node id, and output port position per node: the log's tie-breaks. */
  private readonly position = new Map<string, number>();
  private readonly outPosition = new Map<string, Map<string, number>>();
  /** Nodes that read each node directly, over Event, Signal, Value and param cables. */
  private readonly readers = new Map<string, Set<string>>();
  /** Live events, in time order, merged into their node's output in the chunk their time falls in. */
  private readonly injected: Injected[] = [];
  /** Retained windows, oldest first; null when rewind is off. */
  private history: WindowRecord[] | null = null;
  /** What each node emitted per output port since the oldest retained window. */
  private readonly emitted = new Map<string, Map<string, EngineEvent[]>>();
  /** What each audio node was handed per input port since the oldest retained window. */
  private readonly sent = new Map<string, Map<string, Sent[]>>();
  private end: number | null = null;
  private wallTime: (() => number) | null = null;
  /** Called once per problem a node causes at run time, such as an audio node with no cancel(). The host logs it. */
  onWarning: ((message: string) => void) | null = null;
  /** Audio nodes already warned about having no cancel(). */
  private readonly warned = new Set<string>();

  constructor(plan: Plan, options: RuntimeOptions = {}) {
    this.plan = plan;
    if (options.history) this.history = [];
    for (const [i, node] of plan.order.entries()) {
      this.states.set(node.id, {});
      this.position.set(node.id, i);
      this.outPosition.set(node.id, new Map(portsOf(node.definition, 'out').map((p, j) => [p.name, j])));
      this.readers.set(node.id, new Set());
    }
    for (const [target, links] of plan.incoming) {
      for (const link of [...links.events, ...links.signals, ...links.values, ...links.params]) this.readers.get(link.from.node)?.add(target);
    }
    for (const node of plan.order) {
      const context = createNodeContext(
        { nodeId: node.id, seed: plan.seed, definition: node.definition, params: node.params, state: this.states.get(node.id)! },
        this.wiring(plan.incoming.get(node.id) ?? emptyLinks()),
      );
      this.contexts.set(node.id, context);
    }
  }

  /** Turns on window snapshots, so `push` can rewind into windows already queried.
   *  `wallTime` (milliseconds) times the snapshots for `counters.snapshotMs`. */
  keepHistory(wallTime?: () => number): void {
    this.history ??= [];
    if (wallTime) this.wallTime = wallTime;
  }

  /** The end of the latest window queried, or null before the first. */
  get horizon(): number | null {
    return this.end;
  }

  /**
   * Runs every Event node over [t0, t1) and returns the events in log order.
   * A window wider than `plan.maxWindow` runs as consecutive chunks no wider
   * than it, so delay nodes see their inputs one chunk late but never late
   * enough to change an event's time. With `timing`, audio nodes get events
   * no earlier than `timing.now`.
   */
  query(t0: number, t1: number, timing?: DeliveryTiming): LoggedEvent[] {
    if (this.history && t1 > t0) {
      const started = this.wallTime?.();
      this.history.push({ t0, t1, states: this.snapshotStates(), delayInputs: this.snapshotDelays() });
      if (started !== undefined) this.counters.snapshotMs += this.wallTime!() - started;
    }
    const log: LoggedEvent[] = [];
    this.forChunks(t0, t1, (a, b) => this.runChunk(a, b, null, { log, timing }));
    if (this.end === null || t1 > this.end) this.end = t1;
    return this.sortLog(log);
  }

  /**
   * A live event: `nodeId` emits `event` on its output `port` at `event.time`.
   * If that time is past the horizon, the next query that covers it picks it
   * up and this returns null. Otherwise the runtime rewinds (ADR 0019): it
   * restores the latest snapshot at or before the event's time for the node
   * and everything downstream of it, replays them up to the event without
   * emitting, re-runs them from the event to the horizon with the event
   * included, and replaces what they had emitted, logged and handed to audio
   * nodes from that time on. Needs history (`keepHistory`). With `timing`, the
   * event may not be earlier than `timing.now`: that would cancel events that
   * may already be sounding.
   */
  push(nodeId: string, port: string, event: EngineEvent, timing?: DeliveryTiming): RewindReport | null {
    const node = this.plan.order.find((n) => n.id === nodeId);
    if (!node) throw new Error(`push: no node "${nodeId}"`);
    const spec = node.definition.ports.find((p) => p.name === port && p.direction === 'out');
    if (!spec || (spec.type !== 'event' && spec.type !== 'note')) throw new Error(`push: node "${nodeId}" has no event output "${port}"`);
    const t = event.time;
    if (!Number.isFinite(t)) throw new RangeError(`push: event time must be finite, got ${t}`);
    if (timing && t < timing.now) throw new RangeError(`push: event time ${t} is before currentTime ${timing.now}`);
    const rewinds = this.end !== null && t < this.end;
    if (rewinds && !this.history) throw new Error('push: rewinding into a queried window needs history (Runtime.keepHistory)');
    const oldest = this.history?.[0];
    if (rewinds && (!oldest || t < oldest.t0)) throw new RangeError(`push: time ${t} is before the oldest retained window (${oldest?.t0 ?? 'none'})`);
    // Time order, after any earlier event at the same time.
    let at = this.injected.length;
    while (at > 0 && this.injected[at - 1]!.event.time > t) at--;
    this.injected.splice(at, 0, { node: nodeId, port, event });
    return rewinds ? this.rewind(nodeId, t, timing) : null;
  }

  /**
   * Forgets windows nobody can rewind into any more: keeps the latest window
   * starting at or before `time` and everything after it. The scheduler calls
   * it with currentTime, since live events are never stamped earlier.
   */
  retain(time: number): void {
    const history = this.history;
    if (!history) return;
    let keep = 0;
    for (let j = 0; j < history.length; j++) if (history[j]!.t0 <= time) keep = j;
    if (keep === 0) return;
    history.splice(0, keep);
    const from = history[0]!.t0;
    for (const ports of this.emitted.values()) for (const [port, events] of ports) ports.set(port, events.filter((e) => e.time >= from));
    for (const ports of this.sent.values()) for (const [port, sent] of ports) ports.set(port, sent.filter((s) => s.event.time >= from));
    let drop = 0;
    while (drop < this.injected.length && this.injected[drop]!.event.time < from) drop++;
    this.injected.splice(0, drop);
  }

  /** Log order: time, channel, then plan order and output port order (stable for the rest). */
  sortLog(log: LoggedEvent[]): LoggedEvent[] {
    return log.sort((a, b) =>
      a.time - b.time
      || a.channel - b.channel
      || (this.position.get(a.node) ?? 0) - (this.position.get(b.node) ?? 0)
      || (this.outPosition.get(a.node)?.get(a.port) ?? Infinity) - (this.outPosition.get(b.node)?.get(b.port) ?? Infinity),
    );
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

  private rewind(origin: string, t: number, timing: DeliveryTiming | undefined): RewindReport {
    const history = this.history!;
    let first = history.length - 1;
    while (first > 0 && history[first]!.t0 > t) first--;
    const start = history[first]!;
    const affected = this.downstreamOf(origin);
    const followed = this.signalSourcesOf(affected);
    const scope: Scope = { only: affected, follow: followed };

    for (const id of [...affected, ...followed]) this.restore(id, start);
    // Forget what the affected nodes emitted and queued for frames from t on; the re-run replaces it.
    let removed = 0;
    for (const id of affected) {
      for (const [port, events] of this.emitted.get(id) ?? []) {
        const kept = events.filter((e) => e.time < t);
        removed += events.length - kept.length;
        this.emitted.get(id)!.set(port, kept);
      }
      for (const [port, events] of this.pendingFrames.get(id) ?? []) this.pendingFrames.get(id)!.set(port, events.filter((e) => e.time < t));
    }

    // Only events at the live event's own time take the immediate path; the rest are scheduled.
    const emit: Emit = { log: [], timing: timing && { now: timing.now, path: 'scheduled', immediateAt: t }, rewind: true };
    let queries = 0;
    for (let j = first; j < history.length; j++) {
      const window = history[j]!;
      // Later windows start after t, so their snapshots must now include the event.
      if (j > first) this.resnapshot(window, affected);
      const split = Math.min(Math.max(t, window.t0), window.t1);
      // Replay up to t to rebuild state; what it emits was already scheduled or played.
      if (split > window.t0) queries += this.forChunks(window.t0, split, (a, b) => this.runChunk(a, b, scope, null));
      if (window.t1 > split) queries += this.forChunks(split, window.t1, (a, b) => this.runChunk(a, b, scope, emit));
    }
    return { time: t, from: start.t0, to: history.at(-1)!.t1, affected, followed, queries, removed, added: this.sortLog(emit.log) };
  }

  /**
   * Nodes outside `nodes` that feed them over Signal, Value or param cables,
   * directly or through each other. Their signal() and value() read their
   * state, so a re-run must step them through each chunk too.
   */
  private signalSourcesOf(nodes: ReadonlySet<string>): Set<string> {
    const found = new Set<string>();
    const stack = [...nodes];
    while (stack.length) {
      const links = this.plan.incoming.get(stack.pop()!);
      for (const link of [...(links?.signals ?? []), ...(links?.values ?? []), ...(links?.params ?? [])]) {
        const source = link.from.node;
        if (nodes.has(source) || found.has(source)) continue;
        found.add(source);
        stack.push(source);
      }
    }
    return found;
  }

  /** The node and every node that reads it, directly or not. */
  private downstreamOf(origin: string): Set<string> {
    const seen = new Set([origin]);
    const stack = [origin];
    while (stack.length) {
      for (const reader of this.readers.get(stack.pop()!) ?? []) {
        if (seen.has(reader)) continue;
        seen.add(reader);
        stack.push(reader);
      }
    }
    return seen;
  }

  /**
   * One chunk in plan order. In a re-run (`scope`), nodes outside `scope.only`
   * replay what they emitted the first time; those in `scope.follow` are also
   * queried, for their state only. Without `emit` the chunk only advances state
   * and delay inputs.
   */
  private runChunk(c0: number, c1: number, scope: Scope | null, emit: Emit | null): number {
    const outputs = new Map<string, PortEvents>();
    let queries = 0;
    for (const node of this.plan.order) {
      const { id, definition } = node;
      if (scope && !scope.only.has(id)) {
        outputs.set(id, this.emittedIn(id, c0, c1));
        if (scope.follow.has(id) && definition.query) {
          queries++;
          this.counters.queries++;
          const inputs = definition.delay ? (this.delayInputs.get(id) ?? {}) : this.gatherInputs(id, outputs);
          definition.query({ ...this.contexts.get(id)!, inputs, t0: c0, t1: c1 });
        }
        continue;
      }
      const inputs = definition.delay ? (this.delayInputs.get(id) ?? {}) : this.gatherInputs(id, outputs);
      const result: PortEvents = {};
      if (definition.query) {
        queries++;
        this.counters.queries++;
        const raw = definition.query({ ...this.contexts.get(id)!, inputs, t0: c0, t1: c1 });
        for (const [port, events] of Object.entries(raw)) {
          if (!events?.length) continue;
          // Only events inside the window: anything else would break rewind and the no-late-events rule.
          const inside = events.filter((e) => e.time >= c0 && e.time < c1);
          this.counters.outOfWindow += events.length - inside.length;
          if (inside.length) result[port] = inside;
        }
      }
      for (const { node: from, port, event } of this.injected) {
        if (from === id && event.time >= c0 && event.time < c1) (result[port] ??= []).push(event);
      }
      for (const events of Object.values(result)) events.sort(compareEvents);
      outputs.set(id, result);
      if (!emit) continue;
      for (const [port, events] of Object.entries(result)) for (const event of events) emit.log.push({ node: id, port, ...event });
      if (this.history) this.record(id, result);
      this.deliver(id, inputs, c0, c1, emit);
      if (definition.frame) this.queueForFrame(id, inputs);
    }
    // Delay nodes get this chunk's inputs in the next chunk (or the next query).
    for (const node of this.plan.order) {
      if (node.definition.delay && (!scope || scope.only.has(node.id) || scope.follow.has(node.id))) this.delayInputs.set(node.id, this.gatherInputs(node.id, outputs));
    }
    return queries;
  }

  /** Index × step, not a running sum, so chunk edges don't drift; the last ends exactly at t1. */
  private forChunks(t0: number, t1: number, run: (a: number, b: number) => number): number {
    // A hair under the shortest delay, so t + delay can't round below the next
    // chunk's start and leave a delayed event a chunk late. Rounding may add a
    // tiny trailing chunk, which is harmless. (One chunk is the whole window:
    // step may be Infinity, and 0 × Infinity is NaN.)
    const width = t1 - t0, step = this.plan.maxWindow * (1 - 1e-6);
    const chunks = width > step ? Math.ceil(width / step) : 1;
    let queries = 0;
    for (let i = 0; i < chunks; i++) queries += run(i === 0 ? t0 : t0 + i * step, i === chunks - 1 ? t1 : t0 + (i + 1) * step);
    return queries;
  }

  private deliver(id: string, inputs: PortEvents, c0: number, c1: number, emit: Emit): void {
    const instance = this.audio.get(id);
    if (!instance?.schedule) return;
    if (!emit.rewind) {
      for (const [port, events] of Object.entries(inputs)) if (events.length) this.send(id, instance, port, events, emit.timing);
      return;
    }
    // A re-run: compare with what this node was already handed in the chunk,
    // withdraw what changed and send only what's new.
    const ports = new Set([...Object.keys(inputs), ...(this.sent.get(id)?.keys() ?? [])]);
    for (const port of ports) {
      const before = this.sent.get(id)?.get(port) ?? [];
      const old: Sent[] = [];
      const kept: Sent[] = [];
      for (const s of before) (s.event.time >= c0 && s.event.time < c1 ? old : kept).push(s);
      const added: EngineEvent[] = [];
      for (const event of inputs[port] ?? []) {
        const match = old.findIndex((s) => sameEvent(s.event, event));
        if (match >= 0) kept.push(...old.splice(match, 1));
        else added.push(event);
      }
      this.sent.get(id)?.set(port, kept);
      const withdrawn = old.map((s) => s.sent);
      if (withdrawn.length) {
        if (instance.cancel) {
          instance.cancel(port, withdrawn);
          this.counters.cancelled += withdrawn.length;
        } else {
          this.counters.uncancelled += withdrawn.length;
          if (!this.warned.has(id)) {
            this.warned.add(id);
            this.onWarning?.(`audio node "${id}" has schedule() but no cancel(): a live event replaced ${withdrawn.length} event(s) it can't withdraw, so they will still play`);
          }
        }
      }
      if (added.length) this.send(id, instance, port, added, emit.timing);
    }
  }

  private send(id: string, instance: AudioInstance, port: string, events: readonly EngineEvent[], timing: RewindTiming | undefined): void {
    const sent = events.map((event) => this.timed(event, timing));
    instance.schedule!(port, sent);
    this.counters.delivered += sent.length;
    if (!this.history) return;
    let ports = this.sent.get(id);
    if (!ports) this.sent.set(id, (ports = new Map()));
    const list = ports.get(port) ?? [];
    for (const [i, event] of events.entries()) list.push({ event, sent: sent[i]! });
    ports.set(port, list);
  }

  /** The time an audio node gets: moved by a catch-up, never before currentTime. */
  private timed(event: EngineEvent, timing: RewindTiming | undefined): EngineEvent {
    if (!timing) return event;
    let time = event.time;
    if (timing.catchUp && time < timing.catchUp.until) {
      time += timing.catchUp.shift;
      this.counters.caughtUp++;
    }
    if (!(time >= timing.now)) {
      time = timing.now;
      if (timing.path === 'immediate' || event.time === timing.immediateAt) this.counters.lateImmediate++;
      else this.counters.lateScheduled++;
    }
    return time === event.time ? event : { ...event, time };
  }

  private record(id: string, result: PortEvents): void {
    let ports = this.emitted.get(id);
    if (!ports) this.emitted.set(id, (ports = new Map()));
    for (const [port, events] of Object.entries(result)) ports.set(port, [...(ports.get(port) ?? []), ...events]);
  }

  /** What a node emitted the first time in [c0, c1), for re-runs that don't query it. */
  private emittedIn(id: string, c0: number, c1: number): PortEvents {
    const out: PortEvents = {};
    for (const [port, events] of this.emitted.get(id) ?? []) {
      const inside = events.filter((e) => e.time >= c0 && e.time < c1);
      if (inside.length) out[port] = inside;
    }
    return out;
  }

  private snapshotStates(): Map<string, NodeState> {
    const states = new Map<string, NodeState>();
    for (const node of this.plan.order) {
      const state = this.snapshotOf(node.id);
      if (state) states.set(node.id, state);
    }
    return states;
  }

  /** A copy of a query node's state, or null when it has none (or is empty: restoring then empties it). */
  private snapshotOf(id: string): NodeState | null {
    if (!this.plan.order[this.position.get(id)!]!.definition.query) return null;
    const state = this.states.get(id)!;
    for (const _ in state) {
      this.counters.snapshots++;
      return clonePlain(state, `node "${id}" state`);
    }
    return null;
  }

  private snapshotDelays(): Map<string, PortEvents> {
    const delays = new Map<string, PortEvents>();
    for (const [id, inputs] of this.delayInputs) {
      if (!Object.values(inputs).some((events) => events.length)) continue;
      this.counters.snapshots++;
      delays.set(id, clonePlain(inputs, `node "${id}" delay inputs`));
    }
    return delays;
  }

  private restore(id: string, window: WindowRecord): void {
    if (this.plan.order[this.position.get(id)!]!.definition.query) restoreState(this.states.get(id)!, window.states.get(id) ?? {});
    const held = window.delayInputs.get(id);
    if (held) this.delayInputs.set(id, clonePlain(held));
    else this.delayInputs.delete(id);
  }

  private resnapshot(window: WindowRecord, affected: ReadonlySet<string>): void {
    for (const id of affected) {
      const state = this.snapshotOf(id);
      if (state) window.states.set(id, state);
      else window.states.delete(id);
      const held = this.delayInputs.get(id);
      if (held && Object.values(held).some((events) => events.length)) window.delayInputs.set(id, clonePlain(held));
      else window.delayInputs.delete(id);
    }
  }

  private gatherInputs(id: string, outputs: Map<string, PortEvents>): PortEvents {
    const inputs: PortEvents = {};
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

  private queueForFrame(id: string, inputs: PortEvents): void {
    let pending = this.pendingFrames.get(id);
    if (!pending) this.pendingFrames.set(id, (pending = new Map()));
    for (const [port, events] of Object.entries(inputs)) pending.set(port, [...(pending.get(port) ?? []), ...events]);
  }
}

/** Same time, channel and fields, whatever their order. NaN equals NaN; nothing else is coerced. */
function sameEvent(a: EngineEvent, b: EngineEvent): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (!Object.hasOwn(b, key) || !Object.is(a[key], b[key])) return false;
  return true;
}
