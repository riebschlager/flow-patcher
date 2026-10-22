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
// Scheduler (scheduler.ts) decides which windows to query and when. It also
// enforces the event caps (limits.ts, ADR 0011) and keeps the per-node
// warnings they raise. Hot patching (`swap`, ADR 0023) replaces the plan at a
// window boundary; each window remembers the plan it ran under.
import type { AudioContextLike, AudioNodeLike } from './audio/types';
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
  type QueryContext,
} from './definition';
import { compareEvents, type EngineEvent, type EventField } from './events';
import { LIMIT_WINDOW, limitWindowOf, NODE_EVENT_LIMIT, PATCH_EVENT_LIMIT, WARNING_KINDS, type NodeWarning, type NodeWarningKind } from './limits';
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
  /** Events dropped because their node passed NODE_EVENT_LIMIT in a limit window.
   *  Net of rewinds: a re-run takes back what it re-runs before counting again. */
  droppedNodeLimit: number;
  /** Events dropped because the patch passed PATCH_EVENT_LIMIT in a limit window. Net of rewinds too. */
  droppedPatchLimit: number;
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
type PushedEvents = QueryContext['pushed'];

/** `pushed` for a node with no live events in the chunk: shared, so the common case allocates nothing. */
const NO_PUSHES: PushedEvents = Object.freeze({});

/** One queried window and the state at its start. */
interface WindowRecord {
  t0: number;
  t1: number;
  /** The plan the window ran under; a swap re-running it moves it to the new one. */
  stage: Stage;
  /** Copies of every query node's state as the window began; a node with empty state has no entry. */
  states: Map<string, NodeState>;
  /** Copies of the inputs each delay node was holding as the window began. */
  delayInputs: Map<string, PortEvents>;
  /** Each node's cap counts in the limit window `t0` falls in, as the window began; zeros left out. */
  counts: Map<string, LimitCount>;
}

/** One node's events in one limit window. */
interface LimitCount {
  /** Within NODE_EVENT_LIMIT: what the node cap let through. */
  admitted: number;
  /** Also within PATCH_EVENT_LIMIT: what the node emitted. */
  kept: number;
}

/** An event a cap dropped, kept with history so a rewind can take it back. */
interface Drop {
  time: number;
  kind: 'node-event-limit' | 'patch-event-limit';
  /** The `seq` of the warning it was counted on; 0 when it was counted on none (a dismissed drop a re-run made again). */
  seq: number;
}

/** A warning as the runtime holds it: `seq` tells it from an earlier, cleared warning of the same kind. */
interface HeldWarning extends NodeWarning {
  seq: number;
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
  timing?: DeliveryTiming;
  /** A rewind's re-run: diff audio deliveries against what was already sent. */
  rewind?: boolean;
}

/** What a hot swap did (`Runtime.swap`, design.md "Hot patching"). */
export interface SwapReport {
  /** When the new plan took effect: the start of the first window run under it.
   *  -Infinity when nothing had been queried yet. */
  time: number;
  /** Windows already queried from `time` on that ran again under the new plan;
   *  0 when it took effect at the horizon. */
  windows: number;
  /** Node ids the new plan adds, removes, and keeps with a different type,
   *  params, seed or incoming cables, in plan order. */
  added: string[];
  removed: string[];
  changed: string[];
  /** Changed nodes whose state started over at `time` (type or version
   *  changed, or `keepState` said no). Every other surviving id kept its state. */
  reset: string[];
  /** Nodes re-run from `time`: the added and changed nodes and everything downstream of them. */
  affected: ReadonlySet<string>;
  /** Signal and Value sources of the affected nodes, re-queried for their state only. */
  followed: ReadonlySet<string>;
  /** Nodes whose logged events from `time` on the swap replaces: the affected and removed ones. */
  replaced: ReadonlySet<string>;
  /** Node queries the re-run made. */
  queries: number;
  /** Logged events at or after `time` from replaced nodes that the swap took back. */
  withdrawn: number;
  /** The re-run's logged events, at or after `time`. */
  events: LoggedEvent[];
  /** Events withdrawn from audio instances the swap removed or rebuilt (cancel-after-time). */
  cancelled: number;
}

/**
 * One plan as the runtime runs it, from the time it took effect. Every queried
 * window runs under one stage and remembers it, so a rewind replays each
 * window under the plan that was active then (ADR 0023).
 */
interface Stage {
  plan: Plan;
  /** When it took effect: the start of its first window. -Infinity for the plan the runtime started with. */
  from: number;
  byId: Map<string, PlanNode>;
  /** Plan position per node id, and output port position per node. */
  position: Map<string, number>;
  outPosition: Map<string, Map<string, number>>;
  /** Nodes that read each node directly, over Event, Signal, Value and param cables. */
  readers: Map<string, Set<string>>;
  /** State per node id. A node whose state a swap keeps shares the object with the stage before. */
  states: Map<string, NodeState>;
  contexts: Map<string, BoundContext>;
  /** Audio instances per node id; one a swap didn't rebuild is shared with the stage before. */
  audio: Map<string, AudioInstance>;
  /** Ids whose state starts empty at `from`: added nodes and nodes whose state the swap didn't keep. */
  fresh: Set<string>;
  /** Ids of the stage before that this one doesn't have. */
  gone: Set<string>;
}

/** An audio instance a swap removed or rebuilt, kept until its notes have finished. */
interface Retiring {
  instance: AudioInstance;
  /** When the swap took effect: deliveries before it may still reach the instance. */
  from: number;
}

export class Runtime {
  readonly counters: RuntimeCounters = { delivered: 0, caughtUp: 0, lateScheduled: 0, lateImmediate: 0, cancelled: 0, uncancelled: 0, outOfWindow: 0, droppedNodeLimit: 0, droppedPatchLimit: 0, queries: 0, snapshots: 0, snapshotMs: 0 };
  /** The latest plan: what the next window runs. */
  private stage: Stage;
  /** The plan the chunk being run belongs to: `stage`, except while a rewind replays older windows. */
  private active: Stage;
  /** Events waiting for visual nodes, per node id and input port. */
  private readonly pendingFrames = new Map<string, Map<string, EngineEvent[]>>();
  /**
   * Inputs each delay node received in the last chunk, per node id and input
   * port; its next query sees them. Runtime state like node state, so window
   * snapshots include it.
   */
  private readonly delayInputs = new Map<string, PortEvents>();
  /** The log's tie-breaks over time: each plan's node and output port positions from the
   *  time it took effect, ascending. Only the positions, so old plans don't stay alive. It grows
   *  by one entry per swap and isn't pruned with history: a recorded log (Scheduler.events)
   *  may still sort events from long before the oldest retained window. */
  private readonly ranks: { from: number; position: Map<string, number>; outPosition: Map<string, Map<string, number>> }[] = [];
  /** Live events, in time order, merged into their node's output in the chunk their time falls in. */
  private injected: Injected[] = [];
  /** Retained windows, oldest first; null when rewind is off. */
  private history: WindowRecord[] | null = null;
  /** What each node emitted per output port since the oldest retained window. */
  private readonly emitted = new Map<string, Map<string, EngineEvent[]>>();
  /** What each audio instance was handed per input port since the oldest retained window. */
  private readonly sent = new Map<AudioInstance, Map<string, Sent[]>>();
  private end: number | null = null;
  private wallTime: (() => number) | null = null;
  /** Each node's cap counts per limit window (by `limitWindowOf`). Only windows
   *  a query or rewind can still reach are held. */
  private readonly counts = new Map<string, Map<number, LimitCount>>();
  /** Events the whole patch kept per limit window: the sum of every node's `kept`. */
  private readonly patchKept = new Map<number, number>();
  /** What the caps dropped per node since the oldest retained window; only with history. */
  private readonly drops = new Map<string, Drop[]>();
  /** Current warnings per node id and kind. */
  private readonly nodeWarnings = new Map<string, Map<NodeWarningKind, HeldWarning>>();
  /** During a rewind: per node and kind, how many undone drops had been dismissed
   *  (`clearWarnings`). The re-run's drops use these up before they raise anything. */
  private readonly dismissed = new Map<string, Map<Drop['kind'], number>>();
  /** The context `attachAudio` was given, for the instances a swap builds. */
  private audioContext: AudioContextLike | null = null;
  /** Audio instances a swap removed or rebuilt, still sounding. */
  private retiring: Retiring[] = [];
  /** What each audio output is connected to, in connection order. */
  private readonly connections = new Map<AudioNodeLike, AudioNodeLike[]>();
  private version = 0;
  private warningSeq = 0;
  /**
   * Called when a node first raises a kind of warning (again after
   * `clearWarnings`), such as passing an event cap or an audio node with no
   * cancel(). The host logs it; the editor reads `warnings()` instead.
   */
  onWarning: ((message: string, warning: NodeWarning) => void) | null = null;

  constructor(plan: Plan, options: RuntimeOptions = {}) {
    if (options.history) this.history = [];
    this.stage = this.active = this.makeStage(plan, -Infinity, null, new Set());
    this.ranks.push({ from: -Infinity, position: this.stage.position, outPosition: this.stage.outPosition });
  }

  /** The latest plan: the one the next window runs. */
  get plan(): Plan {
    return this.stage.plan;
  }

  /** A node's live state in the latest plan, for tests and probes: read it, don't change it. */
  stateOf(nodeId: string): Readonly<NodeState> | undefined {
    return this.stage.states.get(nodeId);
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
   * Current warnings, for the editor to show on each node: every node's, or
   * one node's, in plan order and then kind order. Copies; poll
   * `warningsVersion` to see when they change.
   */
  warnings(nodeId?: string): NodeWarning[] {
    const ids = nodeId === undefined ? this.stage.plan.order.map((n) => n.id) : [nodeId];
    const out: NodeWarning[] = [];
    for (const id of ids) {
      const kinds = this.nodeWarnings.get(id);
      if (!kinds) continue;
      for (const kind of WARNING_KINDS) {
        const warning = kinds.get(kind);
        if (warning) out.push(publicWarning(warning));
      }
    }
    return out;
  }

  /** Goes up whenever a warning is raised, changes or is cleared. */
  get warningsVersion(): number {
    return this.version;
  }

  /** Forgets one node's warnings, or every node's (the editor's dismiss). One that happens again is raised again. */
  clearWarnings(nodeId?: string): void {
    const had = nodeId === undefined ? this.nodeWarnings.size > 0 : this.nodeWarnings.has(nodeId);
    if (nodeId === undefined) this.nodeWarnings.clear();
    else this.nodeWarnings.delete(nodeId);
    if (had) this.version++;
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
      this.history.push({ t0, t1, stage: this.stage, states: this.snapshotStates(), delayInputs: this.snapshotDelays(), counts: this.snapshotCounts(t0) });
      if (started !== undefined) this.counters.snapshotMs += this.wallTime!() - started;
    }
    // Counts in limit windows nothing can query or rewind into any more.
    const reach = limitWindowOf(this.history?.[0]?.t0 ?? t0);
    for (const counts of this.counts.values()) for (const k of counts.keys()) if (k < reach) counts.delete(k);
    for (const k of this.patchKept.keys()) if (k < reach) this.patchKept.delete(k);
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
   * may already be sounding. Each window replays under the plan it first ran
   * under (ADR 0023); an event before a swap on a node the swap added is lost.
   */
  push(nodeId: string, port: string, event: EngineEvent, timing?: DeliveryTiming): RewindReport | null {
    const node = this.stage.byId.get(nodeId);
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
   * Hot patching (design.md, ADR 0023): `plan` replaces the running plan at
   * the next window boundary. With `timing` and history, that is the first
   * retained window starting at or after `timing.now`: every window from
   * there to the horizon runs again under the new plan, the way a rewind
   * re-runs them, and what removed or changed nodes had scheduled from then on
   * is replaced. Otherwise the new plan takes effect at the horizon, where the
   * next query starts.
   *
   * Nodes are matched by id. A surviving node keeps its state unless its type
   * or version changed or its definition's `keepState` says no; a removed
   * node's state is dropped. Only the added and changed nodes and those
   * downstream of them re-run; the rest keep what they emitted. An audio node
   * whose type, params, seed or param cables changed gets a new instance, and
   * the old one, like a removed node's, has its events from the swap on
   * cancelled and is disposed once its sounding notes have finished
   * (`AudioInstance.idleAt`, checked in `retain`). Audio cables are rewired
   * now, not at the swap time: Web Audio can't schedule connect/disconnect.
   */
  swap(plan: Plan, timing?: DeliveryTiming): SwapReport {
    const prev = this.stage;
    const seedChanged = plan.seed !== prev.plan.seed;
    const added: string[] = [], changed: string[] = [], reset: string[] = [];
    const kept = new Set<string>(), rebuild = new Set<string>(), retyped = new Set<string>();
    for (const node of plan.order) {
      const before = prev.byId.get(node.id);
      if (!before) {
        added.push(node.id);
        continue;
      }
      const sameType = before.definition.type === node.definition.type && before.definition.version === node.definition.version;
      if (!sameType) retyped.add(node.id);
      const sameParams = sameType && sameValues(before.params, node.params);
      const links = plan.incoming.get(node.id), linksBefore = prev.plan.incoming.get(node.id);
      const sameNode = sameType && sameParams && !seedChanged && before.definition === node.definition;
      if (!sameNode || !sameJson(links, linksBefore)) changed.push(node.id);
      if (!sameNode || !sameJson(links?.params, linksBefore?.params)) rebuild.add(node.id);
      if (sameType && (sameParams || node.definition.keepState?.(before.params, node.params) !== false)) kept.add(node.id);
      else reset.push(node.id);
    }
    const ids = new Set(plan.order.map((n) => n.id));
    const removed = prev.plan.order.map((n) => n.id).filter((id) => !ids.has(id));

    // The next window boundary at or after now; else the horizon.
    const history = this.history;
    let first = -1, time = this.end ?? -Infinity;
    if (timing && history) {
      const j = history.findIndex((w) => w.t0 >= timing.now);
      if (j >= 0) {
        first = j;
        time = history[j]!.t0;
      }
    }
    // Never before the plan it replaces took effect: a swap without timing may have put that
    // at the horizon, past now. Swap times then stay in order, and the fold below applies.
    if (time < prev.from) {
      time = prev.from;
      first = history?.findIndex((w) => w.t0 >= time) ?? -1;
    }

    const next = this.makeStage(plan, time, prev, kept);
    let cancelled = 0;
    if (this.audioContext) {
      for (const node of plan.order) {
        if (!node.definition.audio) continue;
        const old = prev.audio.get(node.id);
        next.audio.set(node.id, old && !rebuild.has(node.id) ? old : this.buildAudio(node, next));
      }
      for (const instance of prev.audio.values()) {
        if (![...next.audio.values()].includes(instance)) cancelled += this.retire(instance, time);
      }
    }
    this.stage = this.active = next;
    // A swap to the same time as the last one replaces its ranks; that plan never ran.
    while (this.ranks.length > 1 && this.ranks.at(-1)!.from >= time) this.ranks.pop();
    this.ranks.push({ from: time, position: next.position, outPosition: next.outPosition });
    if (this.audioContext) this.rewire();
    for (const id of removed) {
      if (this.nodeWarnings.delete(id)) this.version++;
      this.pendingFrames.delete(id);
      // Snapshots keep copies for rewinds into windows before the swap.
      this.delayInputs.delete(id);
    }
    // Live events from the swap on that were pushed onto a node now removed or of another type.
    this.injected = this.injected.filter(({ node, event }) => event.time < time || (next.byId.has(node) && !retyped.has(node)));

    const affected = new Set<string>();
    for (const id of [...added, ...changed]) for (const d of this.downstreamOf(id, next)) affected.add(d);
    const followed = this.signalSourcesOf(affected, next);
    const replaced = new Set([...affected, ...removed]);
    const report: SwapReport = { time, windows: 0, added, removed, changed, reset, affected, followed, replaced, queries: 0, withdrawn: 0, events: [], cancelled };
    if (first >= 0) for (let j = first; j < history!.length; j++) history![j]!.stage = next;
    // A swap to the same boundary as the last one, or a second one at the horizon before a
    // query, leaves the stage before with no window: a replay crossing from the window
    // before goes straight into `next`, so `next` takes over that stage's own state changes too.
    if (prev.from === time) {
      for (const id of prev.fresh) if (next.byId.has(id)) next.fresh.add(id);
      for (const id of prev.gone) if (!next.byId.has(id)) next.gone.add(id);
    }
    if (first < 0) {
      // Nothing queried from `time` on: the next query starts the new plan.
      this.enter(next, () => true);
      return report;
    }

    const start = history![first]!;
    const scope: Scope = { only: affected, follow: followed };
    // The state and cap counts as the swap's first window began, then the swap's own
    // changes to the state; the window's snapshot is retaken from that.
    for (const id of [...affected, ...followed]) this.restore(id, start);
    for (const id of replaced) {
      this.restoreCounts(id, start);
      report.withdrawn += this.takeBack(id, time);
    }
    this.enter(next, (id) => affected.has(id) || followed.has(id));
    this.resnapshot(start, affected);
    const emit: Emit = { log: [], timing: timing && { now: timing.now, path: 'scheduled' }, rewind: true };
    report.queries = this.rerun(first, time, scope, emit);
    report.windows = history!.length - first;
    this.settleWarnings(affected);
    report.events = this.sortLog(emit.log);
    return report;
  }

  /**
   * Forgets windows nobody can rewind into any more: keeps the latest window
   * starting at or before `time` and everything after it. The scheduler calls
   * it with currentTime, since live events are never stamped earlier. Also
   * disposes audio instances a swap retired once `time` has passed their notes.
   */
  retain(time: number): void {
    this.disposeRetired(time);
    const history = this.history;
    if (!history) return;
    let keep = 0;
    for (let j = 0; j < history.length; j++) if (history[j]!.t0 <= time) keep = j;
    if (keep === 0) return;
    history.splice(0, keep);
    const from = history[0]!.t0;
    for (const ports of this.emitted.values()) for (const [port, events] of ports) ports.set(port, events.filter((e) => e.time >= from));
    for (const ports of this.sent.values()) for (const [port, sent] of ports) ports.set(port, sent.filter((s) => s.event.time >= from));
    for (const [id, drops] of this.drops) this.drops.set(id, drops.filter((d) => d.time >= from));
    let drop = 0;
    while (drop < this.injected.length && this.injected[drop]!.event.time < from) drop++;
    this.injected.splice(0, drop);
  }

  /**
   * Log order: time, channel, then plan order and output port order (stable for
   * the rest). Ties rank by the plan in force at their time, so a swap that
   * reorders the plan reorders only what comes after it, and the order doesn't
   * depend on which nodes a rewind re-ran.
   */
  sortLog(log: LoggedEvent[]): LoggedEvent[] {
    const ranks = this.ranks;
    // The last plan that took effect at or before t (both events of a tie share t).
    const at = (t: number) => {
      let lo = 0, hi = ranks.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ranks[mid]!.from <= t) lo = mid;
        else hi = mid - 1;
      }
      return ranks[lo]!;
    };
    return log.sort((a, b) => {
      const d = a.time - b.time || a.channel - b.channel;
      if (d) return d;
      const rank = at(a.time);
      return (rank.position.get(a.node) ?? 0) - (rank.position.get(b.node) ?? 0)
        || (rank.outPosition.get(a.node)?.get(a.port) ?? Infinity) - (rank.outPosition.get(b.node)?.get(b.port) ?? Infinity);
    });
  }

  /** Steps every visual node with the events whose time is before t1. */
  frame(t0: number, t1: number, dt: number): void {
    const stage = this.stage;
    for (const node of stage.plan.order) {
      if (!node.definition.frame) continue;
      const pending = this.pendingFrames.get(node.id) ?? new Map<string, EngineEvent[]>();
      const inputs: Record<string, EngineEvent[]> = {};
      for (const [port, events] of pending) {
        inputs[port] = events.filter((e) => e.time < t1);
        pending.set(port, events.filter((e) => e.time >= t1));
      }
      node.definition.frame({ ...stage.contexts.get(node.id)!, inputs, t0, t1, dt });
    }
  }

  /** Builds every audio node's Web Audio graph and connects the audio cables. Swaps build their own from then on. */
  attachAudio(context: AudioContextLike): void {
    this.audioContext = context;
    for (const node of this.stage.plan.order) if (node.definition.audio) this.stage.audio.set(node.id, this.buildAudio(node, this.stage));
    this.rewire();
  }

  images(): { node: string; image: NodeImage }[] {
    const images: { node: string; image: NodeImage }[] = [];
    for (const node of this.stage.plan.order) {
      const image = node.definition.image?.(this.stage.states.get(node.id)!, node.params);
      if (image) images.push({ node: node.id, image });
    }
    return images;
  }

  dispose(): void {
    for (const instance of this.stage.audio.values()) instance.dispose?.();
    for (const { instance } of this.retiring) instance.dispose?.();
    this.stage.audio.clear();
    this.retiring = [];
    this.connections.clear();
  }

  private makeStage(plan: Plan, from: number, prev: Stage | null, kept: ReadonlySet<string>): Stage {
    const stage: Stage = {
      plan, from,
      byId: new Map(plan.order.map((n) => [n.id, n])),
      position: new Map(), outPosition: new Map(), readers: new Map(), states: new Map(), contexts: new Map(), audio: new Map(),
      fresh: new Set(),
      gone: new Set(prev ? [...prev.byId.keys()].filter((id) => !plan.order.some((n) => n.id === id)) : []),
    };
    for (const [i, node] of plan.order.entries()) {
      const shared = kept.has(node.id) ? prev?.states.get(node.id) : undefined;
      stage.states.set(node.id, shared ?? {});
      if (!shared && prev) stage.fresh.add(node.id);
      stage.position.set(node.id, i);
      stage.outPosition.set(node.id, new Map(portsOf(node.definition, 'out').map((p, j) => [p.name, j])));
      stage.readers.set(node.id, new Set());
      if (!this.counts.has(node.id)) this.counts.set(node.id, new Map());
    }
    for (const [target, links] of plan.incoming) {
      for (const link of [...links.events, ...links.signals, ...links.values, ...links.params]) stage.readers.get(link.from.node)?.add(target);
    }
    for (const node of plan.order) {
      stage.contexts.set(node.id, createNodeContext(
        { nodeId: node.id, seed: plan.seed, definition: node.definition, params: node.params, state: stage.states.get(node.id)! },
        this.wiring(plan.incoming.get(node.id) ?? emptyLinks()),
      ));
    }
    return stage;
  }

  /**
   * Entering a stage's first window in a run that crosses into it: nodes in
   * scope that the stage starts fresh get empty state, and delay inputs held
   * by fresh or removed nodes are dropped. Nodes out of scope already moved on.
   */
  private enter(stage: Stage, inScope: (id: string) => boolean): void {
    for (const id of stage.fresh) {
      if (!inScope(id)) continue;
      restoreState(stage.states.get(id)!, {});
      this.delayInputs.delete(id);
    }
    for (const id of stage.gone) if (inScope(id)) this.delayInputs.delete(id);
  }

  private buildAudio(node: PlanNode, stage: Stage): AudioInstance {
    const { param } = stage.contexts.get(node.id)!;
    return node.definition.audio!({ audio: this.audioContext!, params: node.params, state: stage.states.get(node.id)!, param });
  }

  /** Withdraws what an old audio instance was handed from `time` on, and keeps it until its notes finish. Returns the count withdrawn. */
  private retire(instance: AudioInstance, time: number): number {
    let withdrawn = 0;
    for (const [port, sent] of this.sent.get(instance) ?? []) {
      const late = sent.filter((s) => s.event.time >= time);
      if (!late.length) continue;
      this.sent.get(instance)!.set(port, sent.filter((s) => s.event.time < time));
      if (instance.cancel) {
        instance.cancel(port, late.map((s) => s.sent));
        this.counters.cancelled += late.length;
        withdrawn += late.length;
      } else this.counters.uncancelled += late.length;
    }
    this.retiring.push({ instance, from: time });
    return withdrawn;
  }

  private disposeRetired(now: number): void {
    if (!this.retiring.length) return;
    this.retiring = this.retiring.filter(({ instance, from }) => {
      if (now < from || now < (instance.idleAt?.() ?? -Infinity)) return true;
      instance.dispose?.();
      for (const out of Object.values(instance.outputs ?? {})) this.connections.delete(out);
      this.sent.delete(instance);
      return false;
    });
  }

  /**
   * Connects the latest plan's audio cables. An output whose cables only grew
   * gets the new ones; one that lost a cable is disconnected and connected
   * again. Retiring instances keep their connections, so their notes sound out.
   */
  private rewire(): void {
    const stage = this.stage;
    const wanted = new Map<AudioNodeLike, AudioNodeLike[]>();
    for (const cable of stage.plan.audioCables) {
      const out = stage.audio.get(cable.from.node)?.outputs?.[cable.from.port];
      const into = stage.audio.get(cable.to.node)?.inputs?.[cable.to.port];
      if (out && into) wanted.set(out, [...(wanted.get(out) ?? []), into]);
    }
    const retiring = new Set(this.retiring.flatMap(({ instance }) => Object.values(instance.outputs ?? {})));
    for (const out of new Set([...this.connections.keys(), ...wanted.keys()])) {
      if (retiring.has(out)) continue;
      const have = this.connections.get(out) ?? [], want = wanted.get(out) ?? [];
      if (have.every((into) => want.includes(into))) {
        for (const into of want) if (!have.includes(into)) out.connect(into);
      } else {
        out.disconnect();
        for (const into of want) out.connect(into);
      }
      if (want.length) this.connections.set(out, want);
      else this.connections.delete(out);
    }
  }

  /** Takes back what a node emitted and queued for frames from `t` on, and the drops it made; returns how many events. */
  private takeBack(id: string, t: number): number {
    let removed = 0;
    for (const [port, events] of this.emitted.get(id) ?? []) {
      const kept = events.filter((e) => e.time < t);
      removed += events.length - kept.length;
      this.emitted.get(id)!.set(port, kept);
    }
    for (const [port, events] of this.pendingFrames.get(id) ?? []) this.pendingFrames.get(id)!.set(port, events.filter((e) => e.time < t));
    this.undoDrops(id, t);
    return removed;
  }

  /** The distinct stages of the retained windows from `first` on, and the latest. */
  private stagesFrom(first: number): Stage[] {
    const stages = new Set<Stage>();
    for (let j = first; j < this.history!.length; j++) stages.add(this.history![j]!.stage);
    stages.add(this.stage);
    return [...stages];
  }

  private rewind(origin: string, t: number, timing: DeliveryTiming | undefined): RewindReport {
    const history = this.history!;
    let first = history.length - 1;
    while (first > 0 && history[first]!.t0 > t) first--;
    const start = history[first]!;
    // Over every plan the re-run crosses: a swap may have rewired what reads the origin.
    const stages = this.stagesFrom(first);
    const affected = new Set<string>();
    for (const stage of stages) if (stage.byId.has(origin)) for (const id of this.downstreamOf(origin, stage)) affected.add(id);
    const followed = new Set<string>();
    for (const stage of stages) for (const id of this.signalSourcesOf(affected, stage)) followed.add(id);
    const scope: Scope = { only: affected, follow: followed };

    for (const id of [...affected, ...followed]) this.restore(id, start);
    // The re-run counts the affected nodes' events against the caps again, from the snapshot's count.
    for (const id of affected) this.restoreCounts(id, start);
    // Forget what the affected nodes emitted and queued for frames from t on; the re-run replaces it.
    let removed = 0;
    for (const id of affected) removed += this.takeBack(id, t);

    // Re-run deliveries are all at or after t >= timing.now (push refuses earlier), so none
    // can be late; they count as scheduled, and there is no catch-up shift.
    const emit: Emit = { log: [], timing: timing && { now: timing.now, path: 'scheduled' }, rewind: true };
    const queries = this.rerun(first, t, scope, emit);
    this.settleWarnings(affected);
    return { time: t, from: start.t0, to: history.at(-1)!.t1, affected, followed, queries, removed, added: this.sortLog(emit.log) };
  }

  /**
   * Runs the retained windows from `first` on again, each under its own
   * plan: replaying up to `t` to rebuild state, then emitting from `t`.
   * Crossing into a window that starts a newer plan applies that swap's state
   * changes, so state carries over a swap exactly as it did the first time.
   */
  private rerun(first: number, t: number, scope: Scope, emit: Emit): number {
    const history = this.history!;
    const inScope = (id: string) => scope.only.has(id) || scope.follow.has(id);
    let stage = history[first]!.stage, queries = 0;
    try {
      for (let j = first; j < history.length; j++) {
        const window = history[j]!;
        if (window.stage !== stage) {
          stage = window.stage;
          this.enter(stage, inScope);
        }
        // Later windows start after t, so their snapshots must now include the event.
        if (j > first) this.resnapshot(window, scope.only);
        this.active = stage;
        const split = Math.min(Math.max(t, window.t0), window.t1);
        // Replay up to t to rebuild state; what it emits was already scheduled or played.
        if (split > window.t0) queries += this.forChunks(window.t0, split, (a, b) => this.runChunk(a, b, scope, null));
        if (window.t1 > split) queries += this.forChunks(split, window.t1, (a, b) => this.runChunk(a, b, scope, emit));
      }
      // A swap that took effect at the horizon has no window yet; its changes still apply.
      if (stage !== this.stage) this.enter(this.stage, inScope);
    } finally {
      this.active = this.stage;
    }
    return queries;
  }

  /** A cap warning whose drops a re-run no longer makes goes away. */
  private settleWarnings(affected: ReadonlySet<string>): void {
    for (const id of affected) {
      const kinds = this.nodeWarnings.get(id);
      for (const kind of ['node-event-limit', 'patch-event-limit'] as const) {
        const warning = kinds?.get(kind);
        if (warning && warning.count <= 0) {
          kinds!.delete(kind);
          this.version++;
        }
      }
    }
    this.dismissed.clear();
  }

  /**
   * Nodes outside `nodes` that feed them over Signal, Value or param cables in
   * `stage`, directly or through each other. Their signal() and value() read
   * their state, so a re-run must step them through each chunk too.
   */
  private signalSourcesOf(nodes: ReadonlySet<string>, stage: Stage): Set<string> {
    const found = new Set<string>();
    const stack = [...nodes];
    while (stack.length) {
      const links = stage.plan.incoming.get(stack.pop()!);
      for (const link of [...(links?.signals ?? []), ...(links?.values ?? []), ...(links?.params ?? [])]) {
        const source = link.from.node;
        if (nodes.has(source) || found.has(source)) continue;
        found.add(source);
        stack.push(source);
      }
    }
    return found;
  }

  /** The node and every node that reads it in `stage`, directly or not. */
  private downstreamOf(origin: string, stage: Stage): Set<string> {
    const seen = new Set([origin]);
    const stack = [origin];
    while (stack.length) {
      for (const reader of stage.readers.get(stack.pop()!) ?? []) {
        if (seen.has(reader)) continue;
        seen.add(reader);
        stack.push(reader);
      }
    }
    return seen;
  }

  /**
   * One chunk in plan order, under the active stage. In a re-run (`scope`),
   * nodes outside `scope.only` replay what they emitted the first time; those
   * in `scope.follow` are also queried, for their state only. Without `emit`
   * the chunk only advances state and delay inputs.
   */
  private runChunk(c0: number, c1: number, scope: Scope | null, emit: Emit | null): number {
    const stage = this.active;
    const outputs = new Map<string, PortEvents>();
    let queries = 0;
    for (const node of stage.plan.order) {
      const { id, definition } = node;
      if (scope && !scope.only.has(id)) {
        outputs.set(id, this.emittedIn(id, c0, c1));
        if (scope.follow.has(id) && definition.query) {
          queries++;
          this.counters.queries++;
          const inputs = definition.delay ? (this.delayInputs.get(id) ?? {}) : this.gatherInputs(id, outputs);
          // Its own pushes too, so state built from them replays (its events come from emittedIn above).
          definition.query({ ...stage.contexts.get(id)!, inputs, pushed: this.pushedIn(id, c0, c1), t0: c0, t1: c1 });
        }
        continue;
      }
      const inputs = definition.delay ? (this.delayInputs.get(id) ?? {}) : this.gatherInputs(id, outputs);
      const result: PortEvents = {};
      const pushed = this.pushedIn(id, c0, c1);
      if (definition.query) {
        queries++;
        this.counters.queries++;
        const raw = definition.query({ ...stage.contexts.get(id)!, inputs, pushed, t0: c0, t1: c1 });
        for (const [port, events] of Object.entries(raw)) {
          if (!events?.length) continue;
          // Only events inside the window: anything else would break rewind and the no-late-events rule.
          const inside = events.filter((e) => e.time >= c0 && e.time < c1);
          this.counters.outOfWindow += events.length - inside.length;
          if (inside.length) result[port] = inside;
        }
      }
      // Live events pass through after the query, which saw them as `pushed` and doesn't return them.
      for (const [port, events] of Object.entries(pushed)) (result[port] ??= []).push(...events);
      for (const events of Object.values(result)) events.sort(compareEvents);
      this.applyLimits(id, result, emit !== null);
      outputs.set(id, result);
      if (!emit) continue;
      for (const [port, events] of Object.entries(result)) for (const event of events) emit.log.push({ node: id, port, ...event });
      if (this.history) this.record(id, result);
      this.deliver(id, inputs, c0, c1, emit);
      if (definition.frame) this.queueForFrame(id, inputs);
    }
    // Delay nodes get this chunk's inputs in the next chunk (or the next query).
    for (const node of stage.plan.order) {
      if (node.definition.delay && (!scope || scope.only.has(node.id) || scope.follow.has(node.id))) this.delayInputs.set(node.id, this.gatherInputs(node.id, outputs));
    }
    return queries;
  }

  /** The live events on `id`'s own outputs in [c0, c1), per port, sorted as the outputs will be. */
  private pushedIn(id: string, c0: number, c1: number): PushedEvents {
    let found: Record<string, EngineEvent[]> | null = null;
    for (const { node, port, event } of this.injected) {
      if (node === id && event.time >= c0 && event.time < c1) ((found ??= {})[port] ??= []).push(event);
    }
    if (!found) return NO_PUSHES;
    // Stable: ties keep push order, as in the merge into the outputs.
    for (const events of Object.values(found)) Object.freeze(events.sort(compareEvents));
    return Object.freeze(found);
  }

  /** Index × step, not a running sum, so chunk edges don't drift; the last ends exactly at t1. */
  private forChunks(t0: number, t1: number, run: (a: number, b: number) => number): number {
    // A hair under the shortest delay, so t + delay can't round below the next
    // chunk's start and leave a delayed event a chunk late. Rounding may add a
    // tiny trailing chunk, which is harmless. (One chunk is the whole window:
    // step may be Infinity, and 0 × Infinity is NaN.)
    const width = t1 - t0, step = this.active.plan.maxWindow * (1 - 1e-6);
    const chunks = width > step ? Math.ceil(width / step) : 1;
    let queries = 0;
    for (let i = 0; i < chunks; i++) queries += run(i === 0 ? t0 : t0 + i * step, i === chunks - 1 ? t1 : t0 + (i + 1) * step);
    return queries;
  }

  private deliver(id: string, inputs: PortEvents, c0: number, c1: number, emit: Emit): void {
    const instance = this.active.audio.get(id);
    if (!instance?.schedule) return;
    if (!emit.rewind) {
      for (const [port, events] of Object.entries(inputs)) if (events.length) this.send(instance, port, events, emit.timing);
      return;
    }
    // A re-run: compare with what this instance was already handed in the chunk,
    // withdraw what changed and send only what's new.
    const ports = new Set([...Object.keys(inputs), ...(this.sent.get(instance)?.keys() ?? [])]);
    for (const port of ports) {
      const before = this.sent.get(instance)?.get(port) ?? [];
      const old: Sent[] = [];
      const kept: Sent[] = [];
      for (const s of before) (s.event.time >= c0 && s.event.time < c1 ? old : kept).push(s);
      const added: EngineEvent[] = [];
      for (const event of inputs[port] ?? []) {
        const match = old.findIndex((s) => sameEvent(s.event, event));
        if (match >= 0) kept.push(...old.splice(match, 1));
        else added.push(event);
      }
      this.sent.get(instance)?.set(port, kept);
      const withdrawn = old.map((s) => s.sent);
      if (withdrawn.length) {
        if (instance.cancel) {
          instance.cancel(port, withdrawn);
          this.counters.cancelled += withdrawn.length;
        } else {
          this.counters.uncancelled += withdrawn.length;
          this.warn(id, 'no-cancel', withdrawn.length, Math.max(...withdrawn.map((e) => e.time)),
            `audio node "${id}" has schedule() but no cancel(): events a live event replaced can't be withdrawn, so they still play`);
        }
      }
      if (added.length) this.send(instance, port, added, emit.timing);
    }
  }

  private send(instance: AudioInstance, port: string, events: readonly EngineEvent[], timing: DeliveryTiming | undefined): void {
    const sent = events.map((event) => this.timed(event, timing));
    instance.schedule!(port, sent);
    this.counters.delivered += sent.length;
    if (!this.history) return;
    let ports = this.sent.get(instance);
    if (!ports) this.sent.set(instance, (ports = new Map()));
    const list = ports.get(port) ?? [];
    for (const [i, event] of events.entries()) list.push({ event, sent: sent[i]! });
    ports.set(port, list);
  }

  /** The time an audio node gets: moved by a catch-up, never before currentTime. */
  private timed(event: EngineEvent, timing: DeliveryTiming | undefined): EngineEvent {
    if (!timing) return event;
    let time = event.time;
    if (timing.catchUp && time < timing.catchUp.until) {
      time += timing.catchUp.shift;
      this.counters.caughtUp++;
    }
    if (!(time >= timing.now)) {
      time = timing.now;
      if (timing.path === 'immediate') this.counters.lateImmediate++;
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
    for (const node of this.stage.plan.order) {
      const state = this.snapshotOf(node.id, this.stage);
      if (state) states.set(node.id, state);
    }
    return states;
  }

  /** A copy of a query node's state in `stage`, or null when it has none (or is empty: restoring then empties it). */
  private snapshotOf(id: string, stage: Stage): NodeState | null {
    if (!stage.byId.get(id)?.definition.query) return null;
    const state = stage.states.get(id)!;
    for (const _ in state) {
      this.counters.snapshots++;
      return clonePlain(state, `node "${id}" state`);
    }
    return null;
  }

  private snapshotCounts(t0: number): Map<string, LimitCount> {
    const k = limitWindowOf(t0), snapshot = new Map<string, LimitCount>();
    for (const [id, counts] of this.counts) {
      const count = counts.get(k);
      if (count) snapshot.set(id, { ...count });
    }
    return snapshot;
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

  /** Sets a node's state and delay inputs back to a window's start, in the window's own plan. */
  private restore(id: string, window: WindowRecord): void {
    const stage = window.stage;
    if (stage.byId.get(id)?.definition.query) restoreState(stage.states.get(id)!, window.states.get(id) ?? {});
    const held = window.delayInputs.get(id);
    if (held) this.delayInputs.set(id, clonePlain(held));
    else this.delayInputs.delete(id);
  }

  /** Sets a node's cap counts back to a window's start. */
  private restoreCounts(id: string, window: WindowRecord): void {
    const counts = this.countsOf(id), from = limitWindowOf(window.t0);
    for (const [k, count] of counts) {
      if (k < from) continue;
      this.addPatchKept(k, -count.kept);
      counts.delete(k);
    }
    const count = window.counts.get(id);
    if (count) {
      counts.set(from, { ...count });
      this.addPatchKept(from, count.kept);
    }
  }

  private countsOf(id: string): Map<number, LimitCount> {
    let counts = this.counts.get(id);
    if (!counts) this.counts.set(id, (counts = new Map()));
    return counts;
  }

  private addPatchKept(k: number, n: number): void {
    const total = (this.patchKept.get(k) ?? 0) + n;
    if (total) this.patchKept.set(k, total);
    else this.patchKept.delete(k);
  }

  /**
   * The event caps (limits.ts): keeps the node's first events in each limit
   * window, in log order across its output ports, up to NODE_EVENT_LIMIT for
   * the node and PATCH_EVENT_LIMIT for the patch, and drops the rest from
   * `result` in place. `counted`: record the drops (a replay only rebuilds the counts).
   */
  private applyLimits(id: string, result: PortEvents, counted: boolean): void {
    const ports = Object.keys(result);
    if (!ports.length) return;
    const counts = this.countsOf(id);
    // The usual case: far from both caps in every limit window the events fall
    // in. Count per window, without sorting, and keep everything.
    let n = 0, first = Infinity, last = -Infinity;
    for (const port of ports) {
      const events = result[port]!;
      n += events.length;
      first = Math.min(first, events[0]!.time);
      last = Math.max(last, events.at(-1)!.time);
    }
    const fits = (k: number, m: number) => (counts.get(k)?.admitted ?? 0) + m <= NODE_EVENT_LIMIT && (this.patchKept.get(k) ?? 0) + m <= PATCH_EVENT_LIMIT;
    const keepAll = (k: number, m: number) => {
      const count = counts.get(k);
      if (count) {
        count.admitted += m;
        count.kept += m;
      } else counts.set(k, { admitted: m, kept: m });
      this.addPatchKept(k, m);
    };
    const lo = limitWindowOf(first), hi = limitWindowOf(last);
    if (lo === hi) {
      if (fits(lo, n)) return keepAll(lo, n);
    } else {
      const perWindow = new Map<number, number>();
      for (const port of ports) for (const event of result[port]!) {
        const k = limitWindowOf(event.time);
        perWindow.set(k, (perWindow.get(k) ?? 0) + 1);
      }
      if ([...perWindow].every(([k, m]) => fits(k, m))) {
        for (const [k, m] of perWindow) keepAll(k, m);
        return;
      }
    }
    // A cap binds: decide event by event, in log order.
    const outPosition = this.active.outPosition.get(id)!;
    const all: { port: string; event: EngineEvent; keep: boolean }[] = [];
    for (const port of ports) for (const event of result[port]!) all.push({ port, event, keep: true });
    // Stable, so events a port gave in one order keep it.
    all.sort((a, b) => compareEvents(a.event, b.event) || (outPosition.get(a.port) ?? Infinity) - (outPosition.get(b.port) ?? Infinity));
    let window = NaN, count: LimitCount = { admitted: 0, kept: 0 }, dropped = false;
    for (const item of all) {
      const k = limitWindowOf(item.event.time);
      if (k !== window) {
        window = k;
        count = counts.get(k) ?? { admitted: 0, kept: 0 };
        counts.set(k, count);
      }
      // The node cap counts what it let through, whatever the patch cap then did,
      // so it depends on the node's own events only.
      let kind: Drop['kind'] | null = 'node-event-limit';
      if (count.admitted < NODE_EVENT_LIMIT) {
        count.admitted++;
        kind = (this.patchKept.get(k) ?? 0) < PATCH_EVENT_LIMIT ? null : 'patch-event-limit';
      }
      if (!kind) {
        count.kept++;
        this.addPatchKept(k, 1);
        continue;
      }
      item.keep = false;
      dropped = true;
      if (counted) this.recordDrop(id, item.event.time, kind);
    }
    if (!dropped) return;
    for (const port of ports) delete result[port];
    for (const { port, event, keep } of all) if (keep) (result[port] ??= []).push(event);
  }

  private recordDrop(id: string, time: number, kind: Drop['kind']): void {
    if (kind === 'node-event-limit') this.counters.droppedNodeLimit++;
    else this.counters.droppedPatchLimit++;
    // A rewind re-making a drop that had been dismissed: counted, but not raised again.
    const dismissed = this.dismissed.get(id);
    const credit = dismissed?.get(kind) ?? 0;
    let seq = 0;
    if (credit > 0) dismissed!.set(kind, credit - 1);
    else {
      const ms = Math.round(LIMIT_WINDOW * 1000);
      seq = this.warn(id, kind, 1, time, kind === 'node-event-limit'
        ? `node "${id}" emitted more than ${NODE_EVENT_LIMIT} events in a ${ms} ms window; the excess was dropped`
        : `the patch emitted more than ${PATCH_EVENT_LIMIT} events in a ${ms} ms window; node "${id}" lost events past that`);
    }
    if (this.history) {
      let drops = this.drops.get(id);
      if (!drops) this.drops.set(id, (drops = []));
      drops.push({ time, kind, seq });
    }
  }

  /**
   * A rewind re-runs a node from `t`: take back the drops it made from then on,
   * since the re-run makes its own. Only drops counted on the node's current
   * warning come off it; drops whose warning was dismissed become credits, so
   * the re-run making them again doesn't raise them again.
   */
  private undoDrops(id: string, t: number): void {
    const drops = this.drops.get(id);
    if (!drops?.length) return;
    const kept: Drop[] = [];
    const touched = new Set<HeldWarning>();
    for (const drop of drops) {
      if (drop.time < t) {
        kept.push(drop);
        continue;
      }
      if (drop.kind === 'node-event-limit') this.counters.droppedNodeLimit--;
      else this.counters.droppedPatchLimit--;
      const warning = this.nodeWarnings.get(id)?.get(drop.kind);
      if (warning && drop.seq >= warning.seq) {
        // Left at zero for the re-run to add to; the rewind clears what stays at zero.
        warning.count--;
        touched.add(warning);
      } else {
        let dismissed = this.dismissed.get(id);
        if (!dismissed) this.dismissed.set(id, (dismissed = new Map()));
        dismissed.set(drop.kind, (dismissed.get(drop.kind) ?? 0) + 1);
      }
    }
    this.drops.set(id, kept);
    // The latest time comes from the drops still counted on the warning.
    for (const warning of touched) {
      warning.time = -Infinity;
      for (const drop of kept) if (drop.kind === warning.kind && drop.seq >= warning.seq) warning.time = Math.max(warning.time, drop.time);
      this.version++;
    }
  }

  /** Raises or adds to a node's warning; the host hears about it the first time. Returns the warning's `seq`. */
  private warn(id: string, kind: NodeWarningKind, count: number, time: number, message: string): number {
    let kinds = this.nodeWarnings.get(id);
    if (!kinds) this.nodeWarnings.set(id, (kinds = new Map()));
    const warning = kinds.get(kind);
    this.version++;
    if (warning) {
      warning.count += count;
      warning.time = Math.max(warning.time, time);
      return warning.seq;
    }
    const raised: HeldWarning = { node: id, kind, message, count, time, seq: ++this.warningSeq };
    kinds.set(kind, raised);
    this.onWarning?.(message, publicWarning(raised));
    return raised.seq;
  }

  /** Takes a window's snapshot of the given nodes again, from their live state, in the window's own plan. */
  private resnapshot(window: WindowRecord, affected: ReadonlySet<string>): void {
    const k = limitWindowOf(window.t0);
    for (const id of affected) {
      const count = this.countsOf(id).get(k);
      if (count) window.counts.set(id, { ...count });
      else window.counts.delete(id);
      const state = this.snapshotOf(id, window.stage);
      if (state) window.states.set(id, state);
      else window.states.delete(id);
      const held = this.delayInputs.get(id);
      if (held && Object.values(held).some((events) => events.length)) window.delayInputs.set(id, clonePlain(held));
      else window.delayInputs.delete(id);
    }
  }

  private gatherInputs(id: string, outputs: Map<string, PortEvents>): PortEvents {
    const inputs: PortEvents = {};
    for (const link of this.active.plan.incoming.get(id)?.events ?? []) {
      const events = outputs.get(link.from.node)?.[link.from.port];
      if (events?.length) (inputs[link.toPort] ??= []).push(...events);
    }
    // Several cables into one Event input merge in time order.
    for (const events of Object.values(inputs)) events.sort(compareEvents);
    return inputs;
  }

  /**
   * Source accessors for a node's cables. Sources are looked up per call in
   * the active stage, so build order doesn't matter, and an audio instance a
   * swap kept reads its sources as the plan running the chunk has them.
   */
  private wiring(links: NodeLinks): NodeWiring {
    const source = (link: Link) => {
      const node = this.active.byId.get(link.from.node)!;
      return { node, context: this.active.contexts.get(node.id)! };
    };
    const signal = (link: Link) => (t: number, channel: number) => {
      const { node, context } = source(link);
      return node.definition.signal?.(context, link.from.port, t, channel) ?? 0;
    };
    const group = <L extends Link, T>(list: L[], make: (link: L) => T): Record<string, T[]> => {
      const out: Record<string, T[]> = {};
      for (const link of list) (out[link.toPort] ??= []).push(make(link));
      return out;
    };
    return {
      events: [...new Set(links.events.map((l) => l.toPort))],
      signals: group(links.signals, signal),
      values: Object.fromEntries(links.values.map((link) => [link.toPort, (t: number) => {
        const { node, context } = source(link);
        return node.definition.value?.(context, link.from.port, t);
      }])),
      fields: group(links.fields, (link) => () => {
        const { node, context } = source(link);
        return node.definition.field?.(context, link.from.port);
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

/** A copy of a held warning without its internal `seq`. */
function publicWarning({ seq: _seq, ...warning }: HeldWarning): NodeWarning {
  return warning;
}

/** Same keys and values, compared with Object.is. */
function sameValues(a: ParamValues, b: ParamValues): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key]));
}

/** Plain data compared by its JSON: cables built by the same compiler code have the same key order. */
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Same time, channel and fields, whatever their order. NaN equals NaN; nothing else is coerced. */
function sameEvent(a: EngineEvent, b: EngineEvent): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (!Object.hasOwn(b, key) || !Object.is(a[key], b[key])) return false;
  return true;
}
