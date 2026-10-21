import { resolveParams, type EngineEvent, type NodeDefinition, type QueryResult } from '@flow-patcher/engine';

/** Calls a node's query directly with resolved params. */
export function query(
  definition: NodeDefinition,
  t0: number,
  t1: number,
  { params = {}, inputs = {}, seed = 1, nodeId = 'n', state = {} }: {
    params?: Record<string, unknown>;
    inputs?: Record<string, EngineEvent[]>;
    seed?: number;
    nodeId?: string;
    state?: Record<string, unknown>;
  } = {},
): QueryResult {
  if (!definition.query) throw new Error(`${definition.type} has no query()`);
  return definition.query({ t0, t1, params: resolveParams(definition, params), inputs, seed, nodeId, state });
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
