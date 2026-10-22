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
  type LoggedEvent,
  type NodeImage,
  type Patch,
  type SchedulerStats,
} from '@flow-patcher/engine';
import { nodeRegistry } from '@flow-patcher/nodes';
import { encodeWav, peak, renderOffline, type RenderedAudio } from './audio';
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
}

export interface RunResult {
  patch: Patch;
  options: Required<RunOptions>;
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

export async function runPatch(patch: Patch, options: RunOptions = {}): Promise<RunResult> {
  const opts: Required<RunOptions> = { seconds: 4, window: 0.025, fps: 60, audio: true, ...options };
  const compiled = compilePatch(patch, nodeRegistry);
  if (!compiled.ok) throw new PatchError(compiled.errors);
  const runtime = new Runtime(compiled.plan);
  // The real scheduler on a simulated clock: every wake is on time, so no window is caught up or skipped.
  const clock = new ManualClock();
  const scheduler = new Scheduler(runtime, { clock, wakeInterval: opts.window, lookahead: Math.max(LOOKAHEAD, opts.window), record: true });
  let frames = 0;

  const run = () => {
    // Wake times are computed by index, never by accumulation, so every run tiles time identically.
    let wakes = 0;
    const queryUntil = (time: number) => {
      while ((scheduler.horizon ?? -Infinity) < time) {
        clock.set(wakes++ * opts.window);
        scheduler.wake();
      }
    };
    const frameCount = opts.fps > 0 ? Math.floor(opts.seconds * opts.fps + 1e-9) : 0;
    for (let f = 0; f < frameCount; f++) {
      const t0 = f / opts.fps, t1 = (f + 1) / opts.fps;
      queryUntil(t1);
      runtime.frame(t0, t1, 1 / opts.fps);
      frames++;
    }
    queryUntil(opts.seconds);
  };

  const hasAudio = compiled.plan.order.some((node) => node.definition.audio);
  let audio: RenderedAudio | null = null;
  if (opts.audio && hasAudio) {
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
  return { patch, options: opts, events, scheduler: scheduler.stats, frames, audio, images };
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
