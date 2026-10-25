// The shape of a node type. One file per node type in packages/nodes exports one
// of these; the palette, inspector and (later) server validation read it.
import type { AudioContextLike, AudioNodeLike } from './audio/types';
import type { Voices } from './audio/voices';
import type { EngineEvent, EventPath, PortType } from './events';
import type { FluidBackend } from './fluid/backend';
import type { InputSpec } from './input';

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
  /** Field ports only: a Write output feeds only a Writers input, an Overlay output only an Overlays input. Default 'fluid'. */
  fieldKind?: FieldKind;
  /** Inputs only: what the editor tells the user while no cable comes in, when the node then does
   *  something they might not expect (Progression holding its first chord with no Transport). */
  unwiredHint?: string;
}

export type FieldKind = 'fluid' | 'write' | 'overlay';

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
  /** Cables into this param modulate the knob (`modulate`). Default true. */
  modulatable?: boolean;
  /**
   * How the knob's travel and its cables' depth read the range (ADR 0032). Default 'linear'.
   * - 'linear': equal travel, equal difference; a cable adds depth × signal, in the param's unit.
   * - 'log': equal travel, equal ratio, for frequencies and times. A cable's depth is in octaves:
   *   value = base × 2^(Σ depth × signal), clamped to the range. Needs min > 0 (`paramSpecError`).
   * Either way the stored value, the typed value and what `param()` gives the node are in the param's
   * own unit (Hz, s); only the knob position (`knobPosition`, `knobValue`) and the depth change.
   */
  scale?: 'linear' | 'log';
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
 * Per-instance state. The engine keeps it while the node id survives an edit
 * (hot patching), unless the type or version changes or `keepState` says no.
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
 * - an audio node sampling a param at a caught-up note's moved time, or on
 *   its automation grid in a caught-up chunk, up to 100 ms (the catch-up
 *   limit) after the chunk;
 * - `frame()`, which runs behind the horizon by up to the lookahead (1.25 s
 *   while hidden), so it asks about earlier times.
 * State written by `frame()` or `audio()` alone (a fluid solver, voices) is
 * not snapshotted, but it shares the object, so a node with `query()` must
 * keep such handles out of it.
 */
export type NodeState = Record<string, unknown>;

/**
 * Platform resources the host gives the runtime (`RuntimeOptions.services`),
 * the way it gives audio nodes an AudioContext (ADR 0013). Every node sees
 * them as `ctx.services`. All optional: a node falls back to an in-process
 * stand-in, so headless runs and tests need none.
 */
export interface HostServices {
  /** Where Fluid steps: a FluidHost around a Worker in the browser (ADR 0016),
   *  `createInProcessFluid()` headless. One per running patch. */
  fluid?: FluidBackend;
  /** The text of a vendored sample file by name, such as "0000_FluidR3_GM_sf2_file.js":
   *  the browser fetches /vendor/<file>, headless reads vendor/ from disk. Rejects
   *  when the file is missing. */
  samples?: (file: string) => Promise<string>;
  /** Whether the player asked for reduced motion (prefers-reduced-motion). Overlays keep their
   *  color and drop the motion they add (ADR 0012, ADR 0030). Absent means no. */
  reducedMotion?: () => boolean;
}

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
  /** A number param at time t: the base with its cables applied (`modulate`: base + Σ depth × cable, or
   *  base × 2^(Σ depth × cable) on a log param), clamped like the knob. NaN for non-number params. */
  param(name: string, t: number, channel?: number): number;
  /** True when a cable feeds this input port or param. */
  connected(port: string): boolean;
  /** The host's platform resources. */
  readonly services: HostServices;
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
   * A source whose `input.rewrites` is set is the exception: the runtime
   * doesn't merge them, and `query()` returns its own versions, such as
   * Pointer's with a slot channel and derived fields, at the pushes' times.
   * Such a node may also be pushed on push-only ports (`InputSpec.reads`),
   * which appear here and nowhere else.
   * A rewind (ADR 0019) re-queries the window with the same pushes, including
   * when the node is only stepped for its state as a Signal or Value source.
   */
  readonly pushed: Readonly<Record<string, readonly EngineEvent[]>>;
}

/**
 * A visual frame covers [t0, t1) on the frame clock: the audio clock shifted
 * back by the output latency (FrameLoop). `dt` is the frame step in seconds.
 *
 * `inputs` holds the events due this frame, per port, in time order: every
 * scheduled event before t1 not handed over yet, and every immediate event
 * (a tap's own, ADR 0020) that arrived since the last frame, whatever its
 * time. Each event is handed over once, rewinds included.
 */
export interface FrameContext extends EventContext {
  readonly t0: number;
  readonly t1: number;
  readonly dt: number;
  /** The shared object behind each Field cable into `port`, in patch order. */
  fields(port: string): readonly unknown[];
  /** Which path an event in `inputs` came by. */
  pathOf(event: EngineEvent): EventPath;
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
  /** Audio-clock time from which nothing this instance scheduled still sounds:
   *  its last voice's release end. When an edit removes or rebuilds the node,
   *  the runtime disposes the old instance only once currentTime reaches this,
   *  so sounding notes finish their release (design.md, Hot patching). Without
   *  it, the old instance is disposed as soon as the new plan takes effect. */
  idleAt?(): number;
  /**
   * Called once per chunk the runtime runs while emitting, for every node with
   * an audio instance, at the node's place in plan order (ADR 0031): after its
   * upstream Signal sources were queried, so `param()` and `signal()` answer
   * for [t0, t1). This is where a node with no Event or Note input follows
   * modulated params. Not called in state-only replays.
   *
   * Times are on the audio clock as `schedule` gets them: a catch-up (ADR 0017)
   * moves a chunk that starts in the missed stretch later by its shift, and t0
   * is never before the clock at hand-over. A rewind or swap calls it again for
   * a chunk it already covered, from the re-run's start, so it must be
   * idempotent: cancel what it scheduled from t0 on and schedule again,
   * keeping the ramp t0 falls in whole (a `paramAutomation` per param does it). Sample on an absolute grid (t = k /
   * AUTOMATION_RATE, `automationTimes`), not at t0 or per chunk, so the
   * values don't depend on how time was split into windows. Skip params with
   * no cable (`AudioSetupContext.connected`): their base value doesn't move.
   * `clock` is the audio clock at hand-over (-Infinity when the query has no
   * delivery timing). Pass it to `paramAutomation`'s `follow`, which keeps
   * what the render thread may already be playing.
   */
  automate?(t0: number, t1: number, clock: number): void;
  /**
   * In-place knob edits (ADR 0031): a hot swap that changes only params listed
   * in the definition's `liveParams` keeps this instance and calls this instead
   * of building a new one. `params` are the new resolved params; `time` is when
   * the swap takes effect, on the audio clock and never before it. Ramp each
   * unmodulated param that changed to its new value from `time` (an `editRamp`
   * per param), never jump. Modulated ones need nothing here: the swap re-runs the windows
   * from `time`, and `automate` (whose `param()` sees the new base) ramps them
   * from the end of the ramp being played at `time`, over the next grid step (`paramAutomation`).
   * Without it, the runtime builds a new instance as for any other edit.
   */
  update?(params: ParamValues, time: number): void;
  dispose?(): void;
}

export interface AudioSetupContext {
  /** The node's id, as `NodeContext.nodeId`. */
  readonly nodeId: string;
  /** The patch seed, as `NodeContext.seed`. With `nodeId`, it keys randomness drawn at setup, such as a generated
   *  impulse response: `rngAt(seed, nodeId, ...keys)` for a stream, `randomAt(seed, nodeId, ...keys)` for one value.
   *  Never Math.random. A seed change rebuilds the instance, so both are fixed for its life. */
  readonly seed: number;
  readonly audio: AudioContextLike;
  /** The resolved params as the instance was built. An in-place edit hands the new ones to `AudioInstance.update`. */
  readonly params: ParamValues;
  readonly state: NodeState;
  /** See `NodeContext.param`; sample it at note time inside `schedule`, and on the
   *  automation grid inside `automate`. It reads the plan running the chunk, so after
   *  an in-place edit it adds modulation to the new base. */
  param(name: string, t: number, channel?: number): number;
  /**
   * See `NodeContext.signal` and `NodeContext.value`: the Signal cables into an input
   * port, summed, and the Value on one, at time t (0 and undefined when unconnected).
   * Like `param`, they read the plan running the chunk, so after a swap they follow
   * the new cables, and a rewind into earlier windows reads the old ones. Use them at
   * note time inside `schedule`, and inside `automate` at the times it works in: the
   * audio clock, so in a caught-up chunk (ADR 0017) t is the moved time, and the read
   * answers for that later moment, not for the patch time the chunk was queried at.
   * Sources answer reads past their chunk from their latest state (`NodeState`), so a
   * stateful source such as a Clock's Transport gives the reading as of its latest
   * window there. Outside a chunk (setup, `update`), they read the sources as they stand.
   */
  signal(port: string, t: number, channel?: number): number;
  value(port: string, t: number): unknown;
  /** True when a cable feeds this param or input port (Event, Note, Signal, Value or
   *  Field; Audio ports always answer false). For params it is fixed for the instance's
   *  life, since a change to the cables into params builds a new instance; for ports it
   *  answers for the plan running the chunk, so a swap or a rewind across one can change it. */
  connected(name: string): boolean;
  /** The runtime's voice pool, shared by every audio node on this context, as this
   *  node sees it (its steals count toward it). Claim a voice per note in
   *  `schedule` and release it in `cancel`. */
  readonly voices: Voices;
  /** The host's platform resources, the same object as `NodeContext.services`. */
  readonly services: HostServices;
}

/** An inline status on a node's card (design system: Node `status`), such as an instrument loading or failing to load. */
export interface NodeStatus {
  /** `blocked`: the browser denied the node's permission (`blockedStatus`). */
  kind: 'loading' | 'error' | 'blocked';
  message: string;
  /** Label of the action that `NodeDefinition.retry` performs, such as "Retry". */
  action?: string;
}

/** A browser permission a source node needs before it can read anything (MIDI In; later motion and mic). */
export type Permission = 'midi';

/** Where the host's request for a permission stands. `unsupported`: the browser has no such API. */
export type PermissionState = 'unasked' | 'pending' | 'granted' | 'denied' | 'unsupported';

const PERMISSION_LABELS: Record<Permission, string> = { midi: 'MIDI' };

/** The card status for a node whose permission isn't granted, or null when it is (or hasn't been asked yet). */
export function blockedStatus(permission: Permission, state: PermissionState | undefined): NodeStatus | null {
  const label = PERMISSION_LABELS[permission];
  if (state === 'denied') return { kind: 'blocked', message: `${label} blocked — Allow in browser settings` };
  if (state === 'unsupported') return { kind: 'blocked', message: `${label} isn't available in this browser` };
  return null;
}

/**
 * What the status hooks see: one node of a running patch, as the host knows
 * it. Read-only, and outside any window: the hooks answer for "now".
 */
export interface StatusContext {
  readonly nodeId: string;
  /** The node's resolved params (`resolveParams`). */
  readonly params: ParamValues;
  /** The context the node's audio runs on, as the runtime was given it (`attachAudio`). */
  readonly audio: AudioContextLike;
  /** The host's platform resources, the same object the node's other hooks see. */
  readonly services: HostServices;
  /** Where the request for the node's `permission` stands; undefined when it declares none. */
  readonly permission?: PermissionState;
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
  /** Canvas sources: the input stream event types (ADR 0029) the host pushes to this node, and on
   *  which Event outputs. The live host and the headless runner both route by it (`inputRouter`). */
  input?: InputSpec;
  /** At most one node of this type per patch (Fluid, ADR 0003; Renderer, ADR 0005).
   *  The compiler rejects a second; the editor can grey it out in the palette. */
  unique?: boolean;
  /** A source behind a browser permission. The editor asks the first time a patch
   *  containing the node plays, and passes the answer to `status` as
   *  `StatusContext.permission`; `blockedStatus` gives the card's blocked state. */
  permission?: Permission;
  /** Event and Note outputs. Pure: the same inputs and window give the same events. */
  query?(ctx: QueryContext): QueryResult;
  /** Signal outputs: a pure function of time per channel, sampled at event times. */
  signal?(ctx: NodeContext, port: string, t: number, channel: number): number;
  /** Value outputs: valid for any t this node has been queried up to. */
  value?(ctx: NodeContext, port: string, t: number): unknown;
  /** Field outputs: the object shared by reference with every reader. A Fluid
   *  output gives a `FluidField`, a Write output a `FluidWriter` (fluid/field.ts
   *  has the writer contract), an Overlay output an `OverlayDrawer` (render/overlay.ts). */
  field?(ctx: NodeContext, port: string): unknown;
  /** Visual nodes: runs once per animation frame. */
  frame?(ctx: FrameContext): void;
  /** Audio nodes: builds the Web Audio graph for one instance. */
  audio?(ctx: AudioSetupContext): AudioInstance;
  /** Audio nodes: the params (usually knobs) an edit changes in place
   *  through `AudioInstance.update`, without a new instance (ADR 0031). A swap
   *  that changes anything else (another param, such as a menu that changes the
   *  graph, the version, the seed or the cables into params), or whose
   *  `keepState` resets the node, still rebuilds. */
  liveParams?: readonly string[];
  /** Visual nodes: the current picture, for the renderer and headless runs. */
  image?(state: NodeState, params: ParamValues): NodeImage | null;
  /** Delay nodes (Delay Edge): seconds from an input event to the output it causes, read from params.
   *  Cables into the node don't order the plan, so it can close a cycle. Its query sees the
   *  previous window's inputs, and the runtime keeps windows no wider than this. */
  delay?(params: ParamValues): number;
  /** Hot patching: whether the node's state survives an edit that changes its
   *  params from `before` to `after`. Default true, so a node must cope with
   *  new params on old state (Clock re-anchors its transport). Return false
   *  when the old state means nothing under the new params; the node then
   *  starts from empty state where the new plan takes effect. A change of type
   *  or version never keeps state. */
  keepState?(before: ParamValues, after: ParamValues): boolean;
  /** Editor: what the node's card shows inline right now, or null when there's
   *  nothing to say (Sampled Voice: its instrument loading or failed). Cheap and
   *  side-effect free; the host calls it whenever `watchStatus` fires. */
  status?(ctx: StatusContext): NodeStatus | null;
  /** Editor: performs the current status's `action` (Sampled Voice: loads the
   *  instrument again). A no-op when there's nothing to do. */
  retry?(ctx: StatusContext): void;
  /** Editor: calls `listener` whenever `status(ctx)` may have changed, and
   *  returns the unsubscribe function. It may fire for changes that leave the
   *  status as it was. Without it the host reads `status` only on its own
   *  re-renders. */
  watchStatus?(ctx: StatusContext, listener: () => void): () => void;
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

/** Whether a number param's knob and cable depth are logarithmic (`NumberParamSpec.scale`, ADR 0032). */
export const isLogParam = (spec: ParamSpec | undefined): boolean => spec?.kind === 'number' && spec.scale === 'log';

/**
 * What is wrong with a param spec, or null when it's usable. The compiler rejects a patch that uses a
 * node whose definition has one, and the catalog test checks every node. Today it checks only what
 * a log scale needs: a finite range with 0 < min < max.
 */
export function paramSpecError(spec: ParamSpec): string | null {
  if (spec.kind !== 'number' || spec.scale !== 'log') return null;
  if (!(Number.isFinite(spec.min) && Number.isFinite(spec.max) && spec.min > 0 && spec.max > spec.min)) return `a log-scaled param needs 0 < min < max (has ${spec.min}–${spec.max})`;
  return null;
}

/**
 * Where a value sits on its knob's travel, 0–1: linear in the value, or in its logarithm on a log param
 * (ADR 0032). A value outside the range gives the nearest end; a non-number or NaN gives the default's
 * position, as `resolveParam` would store the default.
 */
export function knobPosition(spec: NumberParamSpec, value: number): number {
  const v = typeof value === 'number' && !Number.isNaN(value) ? Math.max(spec.min, Math.min(spec.max, value)) : spec.default;
  if (!(spec.max > spec.min)) return 0;
  const p = isLogParam(spec) ? Math.log(v / spec.min) / Math.log(spec.max / spec.min) : (v - spec.min) / (spec.max - spec.min);
  return Math.max(0, Math.min(1, p));
}

/**
 * The value at a knob position, 0–1: the inverse of `knobPosition`, in the param's unit. Positions past
 * the ends give the ends (exactly min and max), NaN gives the default. Not rounded to `step`; the caller
 * snaps it (`resolveParam` rounds a stored value).
 */
export function knobValue(spec: NumberParamSpec, position: number): number {
  if (typeof position !== 'number' || Number.isNaN(position)) return spec.default;
  if (position <= 0) return spec.min;
  if (position >= 1) return spec.max;
  const v = isLogParam(spec) ? spec.min * (spec.max / spec.min) ** position : spec.min + position * (spec.max - spec.min);
  return Math.max(spec.min, Math.min(spec.max, v));
}

/**
 * A number param with its cables applied (design.md, Core concepts: cables into a param; ADR 0032).
 * `offset` is Σ depth × signal over the cables, with non-finite terms already left out. On a linear
 * param it is in the param's unit and adds to the base; on a log param it is in octaves and scales it:
 * base × 2^offset. The result is clamped to the range and rounded to `step`. A non-finite offset (huge
 * finite terms overflowing) falls back to the base, not the default. On a log param a finite offset
 * whose power over- or underflows clamps to max or min.
 */
export function modulate(spec: NumberParamSpec, base: number, offset: number): number {
  if (!Number.isFinite(offset)) return base;
  if (offset === 0) return base;
  if (!isLogParam(spec)) {
    // For the editor and tests: `param()` sums a linear param's cables onto the base itself, in cable order,
    // so its values stay bit-exact with what they were before log params (adding a pre-summed offset can round differently).
    const sum = base + offset;
    return Number.isFinite(sum) ? (resolveParam(spec, sum) as number) : base;
  }
  const scaled = base * 2 ** offset;
  return resolveParam(spec, scaled === Infinity ? spec.max : scaled) as number;
}

/** How far a cable's depth reaches on a param: over the whole range at ±this. The range's width on a
 *  linear param, its width in octaves (log2(max / min)) on a log one. For the editor's depth control. */
export function depthRange(spec: NumberParamSpec): number {
  return isLogParam(spec) ? Math.log2(spec.max / spec.min) : spec.max - spec.min;
}

/** The unit a cable's depth into this param is in: "oct" on a log param (ADR 0032), else the param's own. */
export const depthUnit = (spec: NumberParamSpec): string | undefined => (isLogParam(spec) ? 'oct' : spec.unit);

/** Cables into a param are allowed on number params unless they opt out. */
export const isModulatable = (spec: ParamSpec | undefined): spec is NumberParamSpec =>
  spec?.kind === 'number' && spec.modulatable !== false;

export function resolveParams(definition: NodeDefinition, values: Readonly<Record<string, unknown>>): ParamValues {
  return Object.fromEntries(definition.params.map((spec) => [spec.name, resolveParam(spec, values[spec.name])]));
}

export const portsOf = (definition: NodeDefinition, direction: PortSpec['direction']): PortSpec[] =>
  definition.ports.filter((port) => port.direction === direction);
