// The shape of a node type. One file per node type in packages/nodes exports one
// of these; the palette, inspector and (later) server validation read it.
import type { AudioContextLike, AudioNodeLike } from './audio/types';
import type { EngineEvent, PortType } from './events';

export type NodeCategory =
  | 'canvas-sources'
  | 'gesture-recognizers'
  | 'time-rhythm'
  | 'harmony-pitch'
  | 'control-logic'
  | 'instruments'
  | 'effects-mix'
  | 'visual';

export interface PortSpec {
  name: string;
  type: PortType;
  direction: 'in' | 'out';
  label?: string;
  /** Field ports only: a Write output feeds only a Writers input. Default 'fluid'. */
  fieldKind?: FieldKind;
}

export type FieldKind = 'fluid' | 'write';

export interface NumberParamSpec {
  name: string;
  kind: 'number';
  min: number;
  max: number;
  default: number;
  unit?: string;
  label?: string;
  /** Integer-valued knob. */
  step?: number;
  /** Cables into this param add depth × signal to the knob. Default true. */
  modulatable?: boolean;
}

export interface EnumParamSpec {
  name: string;
  kind: 'enum';
  options: readonly string[];
  default: string;
  label?: string;
}

export interface ToggleParamSpec {
  name: string;
  kind: 'toggle';
  default: boolean;
  label?: string;
}

/** Free text, such as a chord string. The preset menu is derived from the text (`presetFor`). */
export interface TextParamSpec {
  name: string;
  kind: 'text';
  default: string;
  label?: string;
  /** Menu label → text it fills in. */
  presets?: Readonly<Record<string, string>>;
  /** An error message for unusable text, or null. The text is stored either way. */
  check?(text: string): string | null;
}

export type ParamSpec = NumberParamSpec | EnumParamSpec | ToggleParamSpec | TextParamSpec;
export type ParamValue = number | string | boolean;
export type ParamValues = Readonly<Record<string, ParamValue>>;

/**
 * Per-instance state. The engine keeps it while the node id survives an edit.
 *
 * Stateful nodes (ADR 0019). For every node with a `query()`, the engine
 * snapshots `ctx.state` at each scheduler window boundary, and when a live
 * event lands at time t inside a window already queried it restores the
 * latest snapshot at or before t and queries the node again from there. That
 * happens to the pushing node and everything downstream of it, and to the
 * Signal and Value sources those nodes read, so their state stays in step.
 * A node writes nothing special for this, but its state must follow three
 * rules:
 * - Plain data only: numbers, strings, booleans, null, arrays, plain objects
 *   and typed arrays. No functions, class instances, Maps or audio/GPU
 *   handles. Snapshots copy it with `clonePlain`, which throws on anything else.
 * - Keep it in `ctx.state` (mutate it or assign keys), never in module scope
 *   or closures, and change it only inside `query()`.
 * - It depends only on the events and times seen, never on how time was
 *   split into windows, as far as anyone can observe: after query(a, b) then
 *   query(b, c), every event the node emits and every read it allows (below)
 *   is identical to what it gives after query(a, c). Parts of the state that
 *   nothing can observe may differ, such as which transport anchors older
 *   than TRANSPORT_HISTORY are left (transport.ts; ADR 0021). Process inputs
 *   in time order.
 * `signal()` and `value()` may read the state. During queries they are only
 * asked about times t0 <= t < t1 of the chunk being run, after this node's
 * own query for that chunk, so knowing the current chunk is enough. (A delay
 * node reading at its inputs' times would reach back one chunk, at most its
 * delay.) Two readers ask about other times; answer them from the latest
 * state and don't keep history for them:
 * - an audio node sampling a param at a caught-up note's moved time, up to
 *   100 ms (the catch-up limit) after the chunk;
 * - `frame()`, which runs behind the horizon by up to the lookahead (1.25 s
 *   while hidden), so it asks about earlier times.
 * State written by `frame()` or `audio()` alone (a fluid solver, voices) is
 * not snapshotted, but it shares the object, so a node with `query()` must
 * keep such handles out of it.
 */
export type NodeState = Record<string, unknown>;

/** What a node sees in every hook: its params, state and the cables into it. */
export interface NodeContext {
  readonly nodeId: string;
  /** Patch seed. Use with `randomAt` from the engine; never Math.random. */
  readonly seed: number;
  /** Base (knob) values; `param()` adds modulation. */
  readonly params: ParamValues;
  readonly state: NodeState;
  /** Sum of the Signal cables into `port` at time t; 0 when unconnected. */
  signal(port: string, t: number, channel?: number): number;
  /** The Value on `port` at time t; undefined when unconnected. */
  value(port: string, t: number): unknown;
  /** A number param at time t: base + Σ depth × cable, clamped like the knob. NaN for non-number params. */
  param(name: string, t: number, channel?: number): number;
  /** True when a cable feeds this input port or param. */
  connected(port: string): boolean;
}

interface EventContext extends NodeContext {
  /** Events that arrived on each input port, in time order. */
  readonly inputs: Readonly<Record<string, readonly EngineEvent[]>>;
}

/**
 * A window query covers the half-open interval [t0, t1) on the audio clock.
 * Every event a query returns must have its time in [t0, t1); the runtime
 * drops (and counts) any that don't. Live input reaches a node through an
 * ordinary query too: the engine re-runs the window from the event's time.
 */
export interface QueryContext extends EventContext {
  readonly t0: number;
  readonly t1: number;
  /**
   * Live events pushed onto this node's own output ports (`Runtime.push`)
   * with time in [t0, t1), per port, in time order (then channel, then push
   * order): the order they reach the outputs in. Only this node's pushes; for
   * most nodes, and most windows, it is an empty object. Read-only: the
   * arrays and the events are shared with the outputs.
   *
   * The runtime already merges these events into the node's outputs after
   * `query()` returns, so `query()` must not return them itself, or they are
   * emitted twice. Use them to update state, such as a pointer's position or
   * the set of pointers down, so `signal()` and `value()` can answer from it.
   * A rewind (ADR 0019) re-queries the window with the same pushes, including
   * when the node is only stepped for its state as a Signal or Value source.
   */
  readonly pushed: Readonly<Record<string, readonly EngineEvent[]>>;
}

/** A visual frame covers [t0, t1) on the audio clock; `dt` is the frame step in seconds. */
export interface FrameContext extends EventContext {
  readonly t0: number;
  readonly t1: number;
  readonly dt: number;
  /** The shared object behind each Field cable into `port`, in patch order. */
  fields(port: string): readonly unknown[];
}

export type QueryResult = Partial<Record<string, EngineEvent[]>>;

export interface AudioInstance {
  /** Web Audio nodes behind each Audio input/output port. */
  inputs?: Record<string, AudioNodeLike>;
  outputs?: Record<string, AudioNodeLike>;
  /** Receives the events that arrived on Event/Note inputs, once per window.
   *  Their times are never before the audio clock's currentTime. */
  schedule?(port: string, events: readonly EngineEvent[]): void;
  /** Withdraws events handed to `schedule` earlier, which a rewind replaced
   *  (ADR 0019). They are the same objects, so match them by identity. None
   *  has started yet: each is at or after the live event that caused it. */
  cancel?(port: string, events: readonly EngineEvent[]): void;
  dispose?(): void;
}

export interface AudioSetupContext {
  readonly audio: AudioContextLike;
  readonly params: ParamValues;
  readonly state: NodeState;
  /** See `NodeContext.param`; sample it at note time inside `schedule`. */
  param(name: string, t: number, channel?: number): number;
}

export interface NodeImage {
  width: number;
  height: number;
  /** RGBA, row-major, top row first. */
  pixels: Uint8ClampedArray;
}

/**
 * Marks a node as an adapter the editor offers when a cable joins a `from`
 * output to a `to` input (docs/nodes/control-logic.md). `input` is the node's
 * port the cable's source plugs into, `output` the port that feeds its target.
 */
export interface AdapterSpec {
  from: PortType;
  to: PortType;
  input: string;
  output: string;
}

export interface NodeDefinition {
  /** Stable type id stored in patches, e.g. "clock". */
  type: string;
  /** Bump when ports or params change (see docs/nodes/README.md). */
  version: number;
  label: string;
  category: NodeCategory;
  description: string;
  ports: readonly PortSpec[];
  params: readonly ParamSpec[];
  /** Set on adapter nodes (Sample & Hold, Threshold, …) so the editor can find them by type pair. */
  adapter?: AdapterSpec;
  /** Event and Note outputs. Pure: the same inputs and window give the same events. */
  query?(ctx: QueryContext): QueryResult;
  /** Signal outputs: a pure function of time per channel, sampled at event times. */
  signal?(ctx: NodeContext, port: string, t: number, channel: number): number;
  /** Value outputs: valid for any t this node has been queried up to. */
  value?(ctx: NodeContext, port: string, t: number): unknown;
  /** Field outputs: the object shared by reference with every reader. */
  field?(ctx: NodeContext, port: string): unknown;
  /** Visual nodes: runs once per animation frame. */
  frame?(ctx: FrameContext): void;
  /** Audio nodes: builds the Web Audio graph for one instance. */
  audio?(ctx: AudioSetupContext): AudioInstance;
  /** Visual nodes: the current picture, for the renderer and headless runs. */
  image?(state: NodeState, params: ParamValues): NodeImage | null;
  /** Delay nodes (Delay Edge): seconds from an input event to the output it causes, read from params.
   *  Cables into the node don't order the plan, so it can close a cycle. Its query sees the
   *  previous window's inputs, and the runtime keeps windows no wider than this. */
  delay?(params: ParamValues): number;
}

export function defaultParams(definition: NodeDefinition): Record<string, ParamValue> {
  return Object.fromEntries(definition.params.map((param) => [param.name, param.default]));
}

/** Coerces a stored value into the spec's range, falling back to the default. */
export function resolveParam(spec: ParamSpec, value: unknown): ParamValue {
  switch (spec.kind) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return spec.default;
      const clamped = Math.max(spec.min, Math.min(spec.max, value));
      return spec.step ? Math.round(clamped / spec.step) * spec.step : clamped;
    }
    case 'enum':
      return typeof value === 'string' && spec.options.includes(value) ? value : spec.default;
    case 'toggle':
      return typeof value === 'boolean' ? value : spec.default;
    case 'text':
      return typeof value === 'string' ? value : spec.default;
  }
}

export const CUSTOM_PRESET = 'Custom';

/** The preset menu entry for a text: the preset whose text matches, else Custom. */
export function presetFor(spec: TextParamSpec, text: string): string {
  for (const [label, preset] of Object.entries(spec.presets ?? {})) if (preset === text) return label;
  return CUSTOM_PRESET;
}

/** Cables into a param are allowed on number params unless they opt out. */
export const isModulatable = (spec: ParamSpec | undefined): spec is NumberParamSpec =>
  spec?.kind === 'number' && spec.modulatable !== false;

export function resolveParams(definition: NodeDefinition, values: Readonly<Record<string, unknown>>): ParamValues {
  return Object.fromEntries(definition.params.map((spec) => [spec.name, resolveParam(spec, values[spec.name])]));
}

export const portsOf = (definition: NodeDefinition, direction: PortSpec['direction']): PortSpec[] =>
  definition.ports.filter((port) => port.direction === direction);
