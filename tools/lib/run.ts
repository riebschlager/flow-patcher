// Headless engine run: load a patch, run window queries and frames, and collect
// events, audio and frame images. Used by `pnpm run-patch` and by tests.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  compilePatch,
  LOOKAHEAD,
  ManualClock,
  parsePatch,
  Runtime,
  Scheduler,
  type AudioContextLike,
  type LoggedEvent,
  type NodeDefinition,
  type NodeImage,
  type Patch,
  type SchedulerStats,
} from '@flow-patcher/engine';
import { nodeRegistry } from '@flow-patcher/nodes';
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
  /** Render audio through a native OfflineAudioContext. */
  audio?: boolean;
  /** Wake the scheduler during the render, suspending it at every wake, the way
   *  the live scheduler runs ahead of currentTime. Off: every window is queried
   *  before rendering starts. Events are the same either way, and audio samples
   *  are within RENDER_TOLERANCE (tools/run-patch.test.ts); only edits need it. Needs audio. */
  live?: boolean;
}

/** What an edit in a live run can reach. */
export interface LiveRun {
  /** The render's currentTime, which the scheduler's clock is set to. */
  time: number;
  context: AudioContextLike;
  scheduler: Scheduler;
  runtime: Runtime;
}

/** A change made during a live run at `time` (rounded down to a render quantum), after that moment's wake. */
export interface RunEdit {
  time: number;
  apply(run: LiveRun): void;
}

export interface RunHooks {
  /** Edits during a live run (`live: true` with audio). If a suspend() doesn't take,
   *  the run starts over (LIVE_ATTEMPTS) and the edits apply again to the new one. */
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
  /** The scheduler's counters at the end of the run. */
  scheduler: SchedulerStats;
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

export async function runPatch(patch: Patch, options: RunOptions = {}, hooks: RunHooks = {}): Promise<RunResult> {
  const opts: Required<RunOptions> = { seconds: 4, window: 0.025, fps: 60, audio: true, live: false, ...options };
  for (let attempt = 1; ; attempt++) {
    try {
      return await runOnce(patch, opts, hooks, attempt);
    } catch (error) {
      if (!(error instanceof SuspendRaceError) || attempt >= LIVE_ATTEMPTS) throw error;
      console.warn(`[run-patch] ${error.message}; running again (attempt ${attempt + 1} of ${LIVE_ATTEMPTS})`);
    }
  }
}

async function runOnce(patch: Patch, opts: Required<RunOptions>, hooks: RunHooks, attempt: number): Promise<RunResult> {
  const compiled = compilePatch(patch, hooks.registry ?? nodeRegistry);
  if (!compiled.ok) throw new PatchError(compiled.errors);
  const runtime = new Runtime(compiled.plan);
  runtime.onWarning = (message) => console.warn(`[run-patch] ${message}`);
  // The real scheduler on a simulated clock: every wake is on time, so no window is caught up or skipped.
  const clock = new ManualClock();
  const scheduler = new Scheduler(runtime, { clock, wakeInterval: opts.window, lookahead: Math.max(LOOKAHEAD, opts.window), record: true });
  let frames = 0;

  // Wake times are computed by index, never by accumulation, so every run tiles time identically.
  let wakes = 0;
  const queryUntil = (time: number) => {
    while ((scheduler.horizon ?? -Infinity) < time) {
      clock.set(wakes++ * opts.window);
      scheduler.wake();
    }
  };
  const frameCount = opts.fps > 0 ? Math.floor(opts.seconds * opts.fps + 1e-9) : 0;
  /** Steps every frame up to `limit` whose window has been queried, or queries it first when `query` is set. */
  const framesUntil = (limit: number, query: boolean) => {
    for (; frames < frameCount; frames++) {
      const t0 = frames / opts.fps, t1 = (frames + 1) / opts.fps;
      if (t1 > limit) break;
      if (query) queryUntil(t1);
      runtime.frame(t0, t1, 1 / opts.fps);
    }
  };
  const run = () => {
    framesUntil(Infinity, true);
    queryUntil(opts.seconds);
  };

  const hasAudio = compiled.plan.order.some((node) => node.definition.audio);
  const live = opts.live && opts.audio && hasAudio;
  if (hooks.edits?.length && !live) throw new Error('runPatch: edits need a live run with audio (live: true)');
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
          edit.apply({ time: context.currentTime, context, scheduler, runtime });
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
        { edits: steps, testLateSuspend: hooks.testLateSuspend && (() => hooks.testLateSuspend!(attempt)) },
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
    });
  } else {
    run();
  }
  const images = runtime.images();
  runtime.dispose();
  // The last wake looks ahead past the end; the run covers [0, seconds).
  const events = scheduler.events().filter((e) => e.time < opts.seconds);
  return { patch, options: opts, attempts: attempt, events, scheduler: scheduler.stats, frames, audio, images };
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
    frames: result.frames,
    audio: result.audio && { file: 'audio.wav', seconds: result.options.seconds, peak: Math.round(peak(result.audio) * 1e6) / 1e6 },
    images: result.images.map(({ node, image }) => ({ node, file: `frame-${node}.png`, width: image.width, height: image.height })),
  };
  write('summary.json', JSON.stringify(summary, null, 2) + '\n');
  return written;
}

export const patchName = (file: string): string => basename(file, extname(file));
