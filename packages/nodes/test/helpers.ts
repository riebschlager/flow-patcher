import { readFile } from 'node:fs/promises';
import {
  compilePatch,
  createNodeContext,
  resolveParams,
  type AudioContextLike,
  type AudioNodeLike,
  type AudioSetupContext,
  type BoundContext,
  type EngineEvent,
  type HostServices,
  type NodeDefinition,
  type NodeWiring,
  type ParamValue,
  type Patch,
  type QueryResult,
  Runtime,
  type SwapReport,
  VoicePool,
} from '@flow-patcher/engine';
import { nodeRegistry } from '../src';
import { renderOffline } from '../../../tools/lib/audio';

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
  /** Field cables per input port. */
  fields?: NodeWiring['fields'];
  /** The host's platform resources, as `RuntimeOptions.services`. */
  services?: HostServices;
  /** Live events pushed onto the node's own output ports, as `Runtime.push` would. `query` and
   *  `queryTiled` hand each window the ones in [t0, t1), sorted by time then channel. */
  pushed?: Record<string, EngineEvent[]>;
}

/** The `pushed` a window [t0, t1) sees, as the runtime builds it. */
export function pushedIn(pushed: Record<string, EngineEvent[]>, t0: number, t1: number): Record<string, EngineEvent[]> {
  const out: Record<string, EngineEvent[]> = {};
  for (const [port, events] of Object.entries(pushed)) {
    const inside = events.filter((e) => e.time >= t0 && e.time < t1).sort((a, b) => a.time - b.time || a.channel - b.channel);
    if (inside.length) out[port] = inside;
  }
  return out;
}

/** The same context the runtime builds, wired to the given sources. */
export function context(
  definition: NodeDefinition,
  { params = {}, seed = 1, nodeId = 'n', state = {}, events, signals, values, mods, fields, services }: Omit<ContextOptions, 'pushed'> & { events?: readonly string[] } = {},
): BoundContext {
  return createNodeContext({ nodeId, seed, definition, params: resolveParams(definition, params), state, services }, { events, signals, values, mods, fields });
}

/** Calls a node's frame() as the runtime does. `immediate` lists the input events that came by the immediate path. */
export function frame(
  definition: NodeDefinition,
  t0: number,
  t1: number,
  { inputs = {}, immediate = [], dt = t1 - t0, ...options }: Omit<ContextOptions, 'pushed'> & { inputs?: Record<string, EngineEvent[]>; immediate?: readonly EngineEvent[]; dt?: number } = {},
): void {
  if (!definition.frame) throw new Error(`${definition.type} has no frame()`);
  const marked = new Set(immediate);
  definition.frame({
    ...context(definition, { ...options, events: Object.keys(inputs) }),
    inputs, t0, t1, dt,
    pathOf: (event) => (marked.has(event) ? 'immediate' : 'scheduled'),
  });
}

/** Calls a node's query directly with resolved params. */
export function query(
  definition: NodeDefinition,
  t0: number,
  t1: number,
  { inputs = {}, pushed = {}, ...options }: ContextOptions & { inputs?: Record<string, EngineEvent[]> } = {},
): QueryResult {
  if (!definition.query) throw new Error(`${definition.type} has no query()`);
  // Event inputs given here count as cabled, as in the runtime.
  return definition.query({ ...context(definition, { ...options, events: Object.keys(inputs) }), inputs, pushed: pushedIn(pushed, t0, t1), t0, t1 });
}

/** The setup context an audio node gets from the runtime. Pass `voices` to share one pool between instances, as on one context. */
export function audioSetup(
  definition: NodeDefinition,
  audio: AudioContextLike,
  { voices = new VoicePool(() => audio.currentTime), ...options }: ContextOptions & { voices?: VoicePool } = {},
): AudioSetupContext {
  const ctx = context(definition, options);
  return { audio, params: ctx.params, state: ctx.state, param: ctx.param, connected: ctx.connected, voices, services: ctx.services };
}

/** Queries [0, end) in windows of `step` and concatenates one output port. Each window sees only
 *  its own share of `pushed`. Like `query`, it returns what the node returned, without the pushed
 *  events the runtime would merge into its outputs. */
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

/** A `HostServices.samples` that reads vendor/ from disk, as a headless host does. Counts its calls in `calls`. */
export function vendorSamples(): ((file: string) => Promise<string>) & { calls: string[] } {
  const calls: string[] = [];
  const samples = async (file: string) => {
    calls.push(file);
    return readFile(new URL(`../../../vendor/${file}`, import.meta.url), 'utf8');
  };
  return Object.assign(samples, { calls });
}

/** RMS of a render over [t, t + width), on one channel or (by default) across all of them. */
export function busRms(audio: { sampleRate: number; channels: Float32Array[] }, t: number, width: number, channel?: number): number {
  const from = Math.round(t * audio.sampleRate), to = Math.round((t + width) * audio.sampleRate);
  let sum = 0, count = 0;
  for (const [index, data] of audio.channels.entries()) {
    if (channel !== undefined && index !== channel) continue;
    for (let i = from; i < Math.min(to, data.length); i++, count++) sum += data[i]! ** 2;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

/**
 * Runs a patch of one `definition` node (id `n`) and an Output through the runtime on an offline
 * context, swapping to each later entry of `params` in turn (one swap per 0.1 s, from 0.2 s).
 * Returns each swap's report and how many instances of the node were built: an in-place edit
 * (ADR 0031) lists `n` in `updated` and builds none.
 */
export async function swapRun(definition: NodeDefinition, params: Record<string, ParamValue>[]): Promise<{ reports: SwapReport[]; built: number }> {
  let built = 0;
  const counted: NodeDefinition = { ...definition, audio: (ctx) => (built++, definition.audio!(ctx)) };
  const definitions = new Map([...nodeRegistry, [definition.type, counted]]);
  const patch = (values: Record<string, ParamValue>): Patch => ({
    format: 'flowpatch', version: 1, seed: 1,
    nodes: [
      { id: 'n', type: definition.type, typeVersion: definition.version, params: values, position: { x: 0, y: 0 } },
      { id: 'out', type: 'output', typeVersion: nodeRegistry.get('output')!.version, params: {}, position: { x: 0, y: 0 } },
    ],
    cables: [],
  });
  const compile = (p: Patch) => {
    const compiled = compilePatch(p, definitions);
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    return compiled.plan;
  };
  const reports: SwapReport[] = [];
  let swap: (values: Record<string, ParamValue>) => void = () => {};
  await renderOffline(0.2 + 0.1 * params.length, (audio) => {
    built = 0;
    reports.length = 0;
    const runtime = new Runtime(compile(patch(params[0]!)));
    runtime.attachAudio(audio);
    runtime.query(0, 0.5);
    swap = (values) => reports.push(runtime.swap(compile(patch(values)), { now: audio.currentTime }));
  }, { edits: params.slice(1).map((values, i) => ({ time: 0.2 + 0.1 * i, apply: () => swap(values) })) });
  return { reports, built };
}

/** A sine at `hz` with RMS `level / √2`, started at 0, panned hard left (−1) or right (1) when `side` is given. */
export function sine(context: AudioContextLike, hz: number, level = 0.5, side?: -1 | 1): AudioNodeLike {
  const osc = context.createOscillator(), amp = context.createGain();
  osc.frequency.value = hz;
  amp.gain.value = level;
  osc.connect(amp);
  osc.start(0);
  if (side === undefined) return amp;
  // The test context is node-web-audio-api's, which has StereoPannerNode; the engine's AudioContextLike doesn't list it.
  const panner = (context as AudioContextLike & { createStereoPanner(): AudioNodeLike & { pan: { value: number } } }).createStereoPanner();
  panner.pan.value = side;
  amp.connect(panner);
  return panner;
}
