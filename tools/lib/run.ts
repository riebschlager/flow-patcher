// Headless engine run: load a patch, run window queries and frames, and collect
// events, audio and frame images. Used by `pnpm run-patch` and by tests.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  applyPatchEdits,
  compilePatch,
  createInProcessFluid,
  LOOKAHEAD,
  PATCH_EDIT_OPS,
  ManualClock,
  parsePatch,
  Runtime,
  Scheduler,
  type AudioContextLike,
  type EngineEvent,
  type LoggedEvent,
  type NodeDefinition,
  type NodeImage,
  type NodeWarning,
  type Patch,
  type PatchEdit,
  type SchedulerStats,
  type SwapReport,
} from '@flow-patcher/engine';
import { INSTRUMENT_KEYS, instrumentCache, nodeRegistry, sampledVoice } from '@flow-patcher/nodes';
import { encodeWav, peak, renderOffline, SuspendRaceError, type AudioEdit, type RenderedAudio } from './audio';
import { encodePng } from './png';

export interface RunOptions {
  /** Length of the run on the audio clock. */
  seconds?: number;
  /** Seconds between scheduler wakes, which is the window size after the first
   *  wake. The live scheduler wakes every 25 ms. The lookahead is the live
   *  120 ms, or one window when that is longer, so a wide window never stalls. */
  window?: number;
  /** Visual frame rate. 0 skips frames. */
  fps?: number;
  /** Output latency in seconds: frame k covers [k/fps − latency, (k+1)/fps − latency)
   *  on the audio clock, as the live FrameLoop shifts frames. Default 0. */
  latency?: number;
  /** Render audio through a native OfflineAudioContext. */
  audio?: boolean;
  /** Wake the scheduler during the render, suspending it at every wake, the way
   *  the live scheduler runs ahead of currentTime. Off: every window is queried
   *  before rendering starts. Events are the same either way, and audio samples
   *  are within RENDER_TOLERANCE (tools/run-patch.test.ts); only edits need it. Needs audio. */
  live?: boolean;
}

/** What an edit during a run can reach. */
export interface LiveRun {
  /** The scheduler clock's time: a live run's render currentTime. */
  time: number;
  /** The render's context in a live run; null in a run without audio. */
  context: AudioContextLike | null;
  scheduler: Scheduler;
  runtime: Runtime;
  /** The patch with every edit so far applied. */
  readonly patch: Patch;
  /**
   * Hot patching: applies `edits` to the patch, compiles it and swaps the plan
   * in at the next window boundary (Scheduler.swap). Throws a PatchError when
   * the edited patch doesn't compile; the running plan and patch then stay.
   */
  edit(edits: readonly PatchEdit[]): SwapReport;
}

/**
 * A change made during a run at `time`, after that moment's wake. In a live
 * run `time` is rounded down to a render quantum; in a run without audio the
 * scheduler's clock is set to `time` itself, between two wakes.
 */
export interface RunEdit {
  time: number;
  apply(run: LiveRun): void;
  /** The patch edits `apply` makes, when known up front: the runner preloads the instruments they bring in. */
  edits?: readonly PatchEdit[];
}

/** Scripted patch edits, as in `<name>.edits.json`: at `time`, apply `edits` as one swap. */
export interface ScriptedEdit {
  time: number;
  edits: PatchEdit[];
}

/** A swap made during a run: the clock time it was asked for at, and what it did. */
export interface RunSwap {
  at: number;
  report: SwapReport;
}

/** An event pushed onto a node's output before the run starts, the way a canvas source's host pushes it live. */
export interface RunInput {
  node: string;
  port: string;
  event: EngineEvent;
}

export interface RunHooks {
  /** Scripted input, such as pointer gestures for a Pointer node. Pushed before
   *  the first window is queried, so it never rewinds. */
  inputs?: readonly RunInput[];
  /** Edits during the run: a live run (`live: true` with audio), or a run without
   *  audio (`audio: false`, or a patch with no audio nodes). If a suspend() doesn't
   *  take, a live run starts over (LIVE_ATTEMPTS) and the edits apply again to the new one.
   *  `scriptedEdits` turns patch edits into these. */
  edits?: readonly RunEdit[];
  /** Node types to compile against. Default: every node in @flow-patcher/nodes. */
  registry?: ReadonlyMap<string, NodeDefinition>;
  /** Test only: fail these attempts of a live run with SuspendRaceError (see RenderOptions.testLateSuspend). */
  testLateSuspend?(attempt: number): boolean;
}

export interface RunResult {
  patch: Patch;
  options: Required<RunOptions>;
  /** Runs it took: more than 1 when a live run had to start over (SuspendRaceError). */
  attempts: number;
  events: LoggedEvent[];
  /** Every swap the edits made (`LiveRun.edit`), in order. */
  swaps: RunSwap[];
  /** The scheduler's counters at the end of the run. */
  scheduler: SchedulerStats;
  /** The runtime's per-node warnings at the end of the run, such as an event cap biting. */
  warnings: NodeWarning[];
  frames: number;
  audio: RenderedAudio | null;
  images: { node: string; image: NodeImage }[];
}

export class PatchError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join('\n'));
  }
}

export function loadPatch(file: string): Patch {
  const parsed = parsePatch(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.ok) throw new PatchError(parsed.errors);
  return parsed.patch;
}

/**
 * Tries a live run gets. A suspend() that doesn't take (SuspendRaceError) loses
 * edits and wakes, so the whole run starts over: a fresh compile, runtime,
 * scheduler, clock and render. The attempt count is in the result.
 */
export const LIVE_ATTEMPTS = 3;

/** The scripted input beside a patch file (`<name>.inputs.json`), or none. */
export function loadInputs(patchFile: string): RunInput[] {
  const file = join(dirname(patchFile), `${patchName(patchFile)}.inputs.json`);
  if (!existsSync(file)) return [];
  const inputs: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const valid = (i: unknown): i is RunInput => {
    if (typeof i !== 'object' || i === null) return false;
    const { node, port, event } = i as Record<string, unknown>;
    return typeof node === 'string' && typeof port === 'string' && typeof event === 'object' && event !== null
      && Number.isFinite((event as EngineEvent).time) && Number.isInteger((event as EngineEvent).channel);
  };
  if (!Array.isArray(inputs) || !inputs.every(valid)) throw new Error(`${file}: expected [{ node, port, event: { time, channel, … } }]`);
  return inputs;
}

/** The scripted edits beside a patch file (`<name>.edits.json`), or none. Throws, naming the
 *  file and the entry, on anything that isn't a list of `{ time, edits: PatchEdit[] }`. */
export function loadEdits(patchFile: string): ScriptedEdit[] {
  const file = join(dirname(patchFile), `${patchName(patchFile)}.edits.json`);
  if (!existsSync(file)) return [];
  const script: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const fail = (where: string, what: string): never => {
    throw new Error(`${file}: ${where}: ${what}`);
  };
  if (!Array.isArray(script)) fail('top level', 'expected [{ time, edits: [{ op, … }] }]');
  for (const [i, entry] of (script as unknown[]).entries()) {
    const where = `[${i}]`;
    if (!isRecord(entry)) fail(where, 'expected { time, edits }');
    const { time, edits } = entry as Record<string, unknown>;
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) fail(`${where}.time`, 'expected a number of seconds, 0 or more');
    if (!Array.isArray(edits)) fail(`${where}.edits`, 'expected an array of edits');
    for (const [j, edit] of (edits as unknown[]).entries()) {
      const problem = editProblem(edit);
      if (problem) fail(`${where}.edits[${j}]`, problem);
    }
  }
  return script as ScriptedEdit[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRef = (v: unknown) => isRecord(v) && typeof v.node === 'string' && typeof v.port === 'string';
const isParamValue = (v: unknown) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

/** What's wrong with one scripted PatchEdit, or null. Node types and ports are the compiler's to check. */
function editProblem(edit: unknown): string | null {
  if (!isRecord(edit)) return 'expected an object with an op';
  const ops: readonly unknown[] = PATCH_EDIT_OPS;
  if (!ops.includes(edit.op)) return `op must be one of ${PATCH_EDIT_OPS.join(', ')}, got ${JSON.stringify(edit.op)}`;
  switch (edit.op as PatchEdit['op']) {
    case 'set-param':
      if (typeof edit.node !== 'string' || typeof edit.param !== 'string') return 'set-param needs node and param strings';
      return isParamValue(edit.value) ? null : 'set-param needs a number, string or boolean value';
    case 'remove-node':
      return typeof edit.node === 'string' ? null : 'remove-node needs a node id string';
    case 'add-node': {
      const n = edit.node;
      if (!isRecord(n) || typeof n.id !== 'string' || !n.id || typeof n.type !== 'string' || !Number.isInteger(n.typeVersion)) return 'add-node needs node { id, type, typeVersion, params, position }';
      if (!isRecord(n.params) || !Object.values(n.params).every(isParamValue)) return 'add-node needs node.params of numbers, strings or booleans';
      if (!isRecord(n.position) || !Number.isFinite(n.position.x) || !Number.isFinite(n.position.y)) return 'add-node needs node.position { x, y }';
      return n.pinned === undefined || (Array.isArray(n.pinned) && n.pinned.every((k) => typeof k === 'string')) ? null : 'add-node needs node.pinned to be strings, or none';
    }
    case 'add-cable': {
      const c = edit.cable;
      if (!isRecord(c) || !isRef(c.from) || !isRef(c.to)) return 'add-cable needs cable { from: { node, port }, to: { node, port } }';
      return c.depth === undefined || (typeof c.depth === 'number' && Number.isFinite(c.depth)) ? null : 'add-cable needs a finite depth, or none';
    }
    case 'remove-cable':
      return isRef(edit.from) && isRef(edit.to) ? null : 'remove-cable needs from and to { node, port }';
  }
}

/** Run edits that apply scripted patch edits, each set as one swap. */
export const scriptedEdits = (script: readonly ScriptedEdit[]): RunEdit[] =>
  script.map(({ time, edits }) => ({ time, edits, apply: (run) => void run.edit(edits) }));

/** Every instrument a Sampled Voice plays in the plan or gets from these edits. */
function instrumentsOf(plan: { order: readonly { definition: NodeDefinition; params: Record<string, unknown> }[] }, edits: readonly RunEdit[]): string[] {
  const keys = new Set<string>();
  const voices = new Set<string>();
  for (const node of plan.order) {
    if (node.definition.type !== 'sampled-voice') continue;
    voices.add(node.id);
    keys.add(node.params.instrument as string);
  }
  for (const edit of edits.flatMap((e) => e.edits ?? [])) {
    if (edit.op === 'add-node' && edit.node.type === 'sampled-voice') {
      voices.add(edit.node.id);
      keys.add((edit.node.params.instrument as string | undefined) ?? (sampledVoice.params.find((p) => p.name === 'instrument')!.default as string));
    } else if (edit.op === 'set-param' && edit.param === 'instrument' && voices.has(edit.node)) {
      keys.add(edit.value as string);
    }
  }
  return [...keys].filter((key) => INSTRUMENT_KEYS.includes(key));
}

export async function runPatch(patch: Patch, options: RunOptions = {}, hooks: RunHooks = {}): Promise<RunResult> {
  const opts: Required<RunOptions> = { seconds: 4, window: 0.025, fps: 60, latency: 0, audio: true, live: false, ...options };
  if (!(Number.isFinite(opts.latency) && opts.latency >= 0)) throw new RangeError(`runPatch: latency must be 0 or more seconds, got ${opts.latency}`);
  for (let attempt = 1; ; attempt++) {
    try {
      return await runOnce(patch, opts, hooks, attempt);
    } catch (error) {
      if (!(error instanceof SuspendRaceError) || attempt >= LIVE_ATTEMPTS) throw error;
      console.warn(`[run-patch] ${error.message}; running again (attempt ${attempt + 1} of ${LIVE_ATTEMPTS})`);
    }
  }
}

/** Sampled Voice's samples, read from the repo's vendor/ (the browser fetches them from /vendor). */
const VENDOR = new URL('../../vendor/', import.meta.url);
export const vendorSamples = (file: string): Promise<string> => readFile(new URL(file, VENDOR), 'utf8');

async function runOnce(patch: Patch, opts: Required<RunOptions>, hooks: RunHooks, attempt: number): Promise<RunResult> {
  const registry = hooks.registry ?? nodeRegistry;
  const compiled = compilePatch(patch, registry);
  if (!compiled.ok) throw new PatchError(compiled.errors);
  // The fluid steps in process, in lockstep with the frames, so its output is bit-exact.
  const runtime = new Runtime(compiled.plan, { services: { fluid: createInProcessFluid(), samples: vendorSamples } });
  // Decode the patch's instruments, and those its scripted edits bring in, on each render's context
  // before anything is scheduled, so no note is skipped while one loads and the audio is the same
  // every run. Only an edit whose patch edits aren't known up front (a bare `apply`) can bring in an
  // instrument that then loads lazily, partway through the render.
  const instruments = instrumentsOf(compiled.plan, hooks.edits ?? []);
  const prepare = async (context: AudioContextLike) => {
    await Promise.all(instruments.map((key) => instrumentCache.load(context, key, vendorSamples)));
  };
  runtime.onWarning = (message) => console.warn(`[run-patch] ${message}`);
  for (const { node, port, event } of hooks.inputs ?? []) runtime.push(node, port, event);
  // The real scheduler on a simulated clock: every wake is on time, so no window is caught up or skipped.
  const clock = new ManualClock();
  const scheduler = new Scheduler(runtime, { clock, wakeInterval: opts.window, lookahead: Math.max(LOOKAHEAD, opts.window), record: true });
  let frames = 0;

  const hasAudio = compiled.plan.order.some((node) => node.definition.audio);
  const live = opts.live && opts.audio && hasAudio;

  // Edits see the patch as edited so far, and swap through the scheduler.
  let current = patch;
  const swaps: RunSwap[] = [];
  const liveRun = (context: AudioContextLike | null): LiveRun => ({
    time: clock.audio,
    context,
    scheduler,
    runtime,
    get patch() {
      return current;
    },
    edit(edits) {
      const next = applyPatchEdits(current, edits);
      const recompiled = compilePatch(next, registry);
      if (!recompiled.ok) throw new PatchError(recompiled.errors);
      current = next;
      const report = scheduler.swap(recompiled.plan);
      swaps.push({ at: clock.audio, report });
      return report;
    },
  });

  // Wake times are computed by index, never by accumulation, so every run tiles time identically.
  let wakes = 0;
  // A run without live audio applies its edits between wakes, on the simulated clock.
  const pending = [...(hooks.edits ?? [])].sort((a, b) => a.time - b.time);
  for (const edit of pending) if (!(edit.time >= 0 && edit.time < opts.seconds)) throw new RangeError(`runPatch: edit at ${edit.time} is outside the run [0, ${opts.seconds})`);
  const wakeOnce = () => {
    clock.set(wakes++ * opts.window);
    scheduler.wake();
    if (live) return;
    // The edits from this wake up to the next one.
    while (pending.length && pending[0]!.time < wakes * opts.window) {
      const edit = pending.shift()!;
      clock.set(edit.time);
      edit.apply(liveRun(null));
    }
  };
  const queryUntil = (time: number) => {
    while ((scheduler.horizon ?? -Infinity) < time) wakeOnce();
  };
  const frameCount = opts.fps > 0 ? Math.floor(opts.seconds * opts.fps + 1e-9) : 0;
  /** Steps every frame up to `limit` whose window has been queried, or queries it first when `query` is set. */
  const framesUntil = (limit: number, query: boolean) => {
    for (; frames < frameCount; frames++) {
      const t0 = frames / opts.fps - opts.latency, t1 = (frames + 1) / opts.fps - opts.latency;
      if (t1 > limit) break;
      if (query) queryUntil(t1);
      runtime.frame(t0, t1, 1 / opts.fps);
    }
  };
  const run = () => {
    framesUntil(Infinity, true);
    queryUntil(opts.seconds);
    // Edits after the last wake still re-run what was queried before the end.
    while (!live && pending.length) wakeOnce();
  };

  // Rendering after every window is queried would let a swap dispose voices before they play.
  if (hooks.edits?.length && opts.audio && hasAudio && !live) throw new Error('runPatch: edits with audio need a live run (live: true), or audio: false');
  let audio: RenderedAudio | null = null;
  if (live) {
    // The scheduler wakes as the render plays: at each wake the render is
    // suspended at that moment and the clock reads its currentTime.
    const at = (context: AudioContextLike) => clock.set(context.currentTime);
    const steps: AudioEdit[] = [];
    for (let k = 1; k * opts.window < opts.seconds; k++) {
      steps.push({
        time: k * opts.window,
        apply(context) {
          at(context);
          scheduler.wake();
          framesUntil(scheduler.horizon ?? 0, false);
        },
      });
    }
    for (const edit of hooks.edits ?? []) {
      steps.push({
        time: edit.time,
        apply(context) {
          at(context);
          edit.apply(liveRun(context));
        },
      });
    }
    try {
      audio = await renderOffline(
        opts.seconds,
        (context) => {
          runtime.attachAudio(context);
          at(context);
          scheduler.wake();
          framesUntil(scheduler.horizon ?? 0, false);
        },
        { edits: steps, prepare, testLateSuspend: hooks.testLateSuspend && (() => hooks.testLateSuspend!(attempt)) },
      );
    } catch (error) {
      runtime.dispose();
      throw error;
    }
    // Finish the log and frames past the last wake, on the simulated clock.
    wakes = Math.ceil((clock.audio + 1e-9) / opts.window);
    run();
  } else if (opts.audio && hasAudio) {
    audio = await renderOffline(opts.seconds, (context) => {
      runtime.attachAudio(context);
      run();
    }, { prepare });
  } else {
    run();
  }
  const images = runtime.images();
  const warnings = runtime.warnings();
  runtime.dispose();
  // The last wake looks ahead past the end; the run covers [0, seconds).
  const events = scheduler.events().filter((e) => e.time < opts.seconds);
  return { patch, options: opts, attempts: attempt, events, swaps, scheduler: scheduler.stats, warnings, frames, audio, images };
}

/** One event per line, so event logs diff cleanly. */
export function formatEvents(events: readonly LoggedEvent[]): string {
  return events.length ? `[\n${events.map((e) => JSON.stringify(e)).join(',\n')}\n]\n` : '[]\n';
}

export function writeRun(result: RunResult, outDir: string, name: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const write = (file: string, data: string | Uint8Array) => {
    writeFileSync(join(outDir, file), data);
    written.push(join(outDir, file));
  };
  write('events.json', formatEvents(result.events));
  if (result.audio) write('audio.wav', encodeWav(result.audio));
  for (const { node, image } of result.images) write(`frame-${node}.png`, encodePng(image.width, image.height, image.pixels, 4));
  const byNode: Record<string, number> = {};
  for (const e of result.events) byNode[`${e.node}.${e.port}`] = (byNode[`${e.node}.${e.port}`] ?? 0) + 1;
  const summary = {
    patch: name,
    options: result.options,
    attempts: result.attempts,
    events: result.events.length,
    eventsByPort: byNode,
    scheduler: result.scheduler,
    warnings: result.warnings,
    swaps: result.swaps.map(({ at, report }) => ({ at, time: report.time, windows: report.windows, added: report.added, removed: report.removed, changed: report.changed, reset: report.reset })),
    frames: result.frames,
    audio: result.audio && { file: 'audio.wav', seconds: result.options.seconds, peak: Math.round(peak(result.audio) * 1e6) / 1e6 },
    images: result.images.map(({ node, image }) => ({ node, file: `frame-${node}.png`, width: image.width, height: image.height })),
  };
  write('summary.json', JSON.stringify(summary, null, 2) + '\n');
  return written;
}

export const patchName = (file: string): string => basename(file, extname(file));
