import {
  createNodeContext,
  resolveParams,
  type AudioContextLike,
  type AudioSetupContext,
  type BoundContext,
  type EngineEvent,
  type NodeDefinition,
  type NodeWiring,
  type QueryResult,
} from '@flow-patcher/engine';

export interface ContextOptions {
  params?: Record<string, unknown>;
  seed?: number;
  nodeId?: string;
  state?: Record<string, unknown>;
  /** Signal cables per input port. */
  signals?: NodeWiring['signals'];
  /** One Value cable per input port. */
  values?: NodeWiring['values'];
  /** Signal cables into number params, with their depth. */
  mods?: NodeWiring['mods'];
}

/** The same context the runtime builds, wired to the given sources. */
export function context(
  definition: NodeDefinition,
  { params = {}, seed = 1, nodeId = 'n', state = {}, events, signals, values, mods }: ContextOptions & { events?: readonly string[] } = {},
): BoundContext {
  return createNodeContext({ nodeId, seed, definition, params: resolveParams(definition, params), state }, { events, signals, values, mods });
}

/** Calls a node's query directly with resolved params. */
export function query(
  definition: NodeDefinition,
  t0: number,
  t1: number,
  { inputs = {}, ...options }: ContextOptions & { inputs?: Record<string, EngineEvent[]> } = {},
): QueryResult {
  if (!definition.query) throw new Error(`${definition.type} has no query()`);
  // Event inputs given here count as cabled, as in the runtime.
  return definition.query({ ...context(definition, { ...options, events: Object.keys(inputs) }), inputs, t0, t1 });
}

/** The setup context an audio node gets from the runtime. */
export function audioSetup(definition: NodeDefinition, audio: AudioContextLike, options: ContextOptions = {}): AudioSetupContext {
  const ctx = context(definition, options);
  return { audio, params: ctx.params, state: ctx.state, param: ctx.param };
}

/** Queries [0, end) in windows of `step` and concatenates one output port. */
export function queryTiled(
  definition: NodeDefinition,
  port: string,
  end: number,
  step: number,
  options: Parameters<typeof query>[3] & { inputsFor?: (t0: number, t1: number) => Record<string, EngineEvent[]> } = {},
): EngineEvent[] {
  const out: EngineEvent[] = [];
  const count = Math.ceil(end / step - 1e-9);
  for (let i = 0; i < count; i++) {
    const t0 = i * step, t1 = Math.min(end, (i + 1) * step);
    out.push(...(query(definition, t0, t1, { ...options, inputs: options.inputsFor?.(t0, t1) ?? options.inputs ?? {} })[port] ?? []));
  }
  return out;
}

export const ticks = (times: number[], channel = 0): EngineEvent[] => times.map((time, index) => ({ time, channel, index }));
