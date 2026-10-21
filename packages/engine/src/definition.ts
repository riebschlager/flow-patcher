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
}

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

export type ParamSpec = NumberParamSpec | EnumParamSpec | ToggleParamSpec;
export type ParamValue = number | string | boolean;
export type ParamValues = Readonly<Record<string, ParamValue>>;

/** Per-instance state. The engine keeps it while the node id survives an edit. */
export type NodeState = Record<string, unknown>;

interface BaseContext {
  readonly nodeId: string;
  /** Patch seed. Use with `randomAt` from the engine; never Math.random. */
  readonly seed: number;
  readonly params: ParamValues;
  readonly state: NodeState;
  /** Events that arrived on each input port, in time order. */
  readonly inputs: Readonly<Record<string, readonly EngineEvent[]>>;
}

/** A window query covers the half-open interval [t0, t1) on the audio clock. */
export interface QueryContext extends BaseContext {
  readonly t0: number;
  readonly t1: number;
}

/** A visual frame covers [t0, t1) on the audio clock; `dt` is the frame step in seconds. */
export interface FrameContext extends BaseContext {
  readonly t0: number;
  readonly t1: number;
  readonly dt: number;
}

export type QueryResult = Partial<Record<string, EngineEvent[]>>;

export interface AudioInstance {
  /** Web Audio nodes behind each Audio input/output port. */
  inputs?: Record<string, AudioNodeLike>;
  outputs?: Record<string, AudioNodeLike>;
  /** Receives the events that arrived on Event/Note inputs, once per window. */
  schedule?(port: string, events: readonly EngineEvent[]): void;
  dispose?(): void;
}

export interface AudioSetupContext {
  readonly audio: AudioContextLike;
  readonly params: ParamValues;
  readonly state: NodeState;
}

export interface NodeImage {
  width: number;
  height: number;
  /** RGBA, row-major, top row first. */
  pixels: Uint8ClampedArray;
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
  /** Event and Note outputs. Pure: the same inputs and window give the same events. */
  query?(ctx: QueryContext): QueryResult;
  /** Visual nodes: runs once per animation frame. */
  frame?(ctx: FrameContext): void;
  /** Audio nodes: builds the Web Audio graph for one instance. */
  audio?(ctx: AudioSetupContext): AudioInstance;
  /** Visual nodes: the current picture, for the renderer and headless runs. */
  image?(state: NodeState, params: ParamValues): NodeImage | null;
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
  }
}

export function resolveParams(definition: NodeDefinition, values: Readonly<Record<string, unknown>>): ParamValues {
  return Object.fromEntries(definition.params.map((spec) => [spec.name, resolveParam(spec, values[spec.name])]));
}

export const portsOf = (definition: NodeDefinition, direction: PortSpec['direction']): PortSpec[] =>
  definition.ports.filter((port) => port.direction === direction);
