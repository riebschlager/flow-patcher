// Offline audio for headless runs and tests, on node-web-audio-api's native
// OfflineAudioContext (the same Web Audio API the browser has).
import { OfflineAudioContext } from 'node-web-audio-api';
import type { AudioContextLike } from '@flow-patcher/engine';

export const SAMPLE_RATE = 48000;

export interface RenderedAudio {
  sampleRate: number;
  channels: Float32Array[];
}

/** Frames per Web Audio render quantum: suspend() times are quantized to it. */
export const RENDER_QUANTUM = 128;

/** A change made while an offline render is suspended at `time`. */
export interface AudioEdit {
  time: number;
  apply(context: AudioContextLike): void;
}

export interface RenderOptions {
  channels?: number;
  sampleRate?: number;
  /**
   * Changes applied mid-render. Each suspends the render at its time,
   * rounded down to a render quantum, runs, and resumes. Edits that land on
   * the same quantum run in the order given. An edit can't be at or past the end.
   */
  edits?: readonly AudioEdit[];
  /**
   * Renders to try when a suspend doesn't take (SuspendRaceError). Each try
   * runs `setup` and the edits again on a fresh context, so `setup` must build
   * everything it needs. Default 1: the error reaches the caller.
   */
  attempts?: number;
  /** Called before each try with its number (from 1). */
  onAttempt?(attempt: number): void;
  /** Test only: on the tries this returns true for, also make one suspend()
   *  from the first edit's handler, after rendering has started. node-web-audio-api
   *  always refuses it, so the try fails with SuspendRaceError the way a lost
   *  race does. Needs at least one edit. */
  testLateSuspend?(attempt: number): boolean;
}

/**
 * A suspend() that never took effect, so some edits didn't run. The render
 * fails loudly instead of returning audio with edits missing.
 *
 * node-web-audio-api 2.2.0 registers a suspend on a background task, and only
 * until rendering starts: a suspend() made after startRendering() is refused,
 * and one made before can still land too late. Back to back, about 1 render
 * in 70 with 160 suspends lost some. renderOffline waits 1 ms before starting,
 * which makes the race rarer but doesn't remove it: under parallel test load
 * it still happens. Callers render again from scratch (`attempts`, or
 * runPatch's own retry).
 */
export class SuspendRaceError extends Error {
  constructor(missed: number, total: number, cause?: unknown) {
    super(`renderOffline: ${missed} of ${total} suspends never took effect`, { cause });
    this.name = 'SuspendRaceError';
  }
}

/** Builds a graph with `setup`, renders `seconds` of it and returns the samples. */
export async function renderOffline(seconds: number, setup: (context: AudioContextLike) => void, options: RenderOptions = {}): Promise<RenderedAudio> {
  const attempts = Math.max(1, options.attempts ?? 1);
  for (let attempt = 1; ; attempt++) {
    options.onAttempt?.(attempt);
    try {
      return await renderOnce(seconds, setup, options, options.testLateSuspend?.(attempt) ?? false);
    } catch (error) {
      if (!(error instanceof SuspendRaceError) || attempt >= attempts) throw error;
      console.warn(`[renderOffline] ${error.message}; rendering again (try ${attempt + 1} of ${attempts})`);
    }
  }
}

async function renderOnce(
  seconds: number,
  setup: (context: AudioContextLike) => void,
  { channels = 2, sampleRate = SAMPLE_RATE, edits = [] }: RenderOptions,
  lateSuspend: boolean,
): Promise<RenderedAudio> {
  const length = Math.max(1, Math.round(seconds * sampleRate));
  const context = new OfflineAudioContext(channels, length, sampleRate);
  const like = context as unknown as AudioContextLike;
  // One suspend per quantum: the API refuses two at the same quantized time.
  const byQuantum = new Map<number, AudioEdit[]>();
  for (const edit of edits) {
    const quantum = Math.floor((edit.time * sampleRate) / RENDER_QUANTUM + 1e-9);
    if (!(quantum >= 0) || quantum * RENDER_QUANTUM >= length) throw new RangeError(`renderOffline: edit at ${edit.time} s is outside the render`);
    byQuantum.set(quantum, [...(byQuantum.get(quantum) ?? []), edit]);
  }
  setup(like);
  const quanta = [...byQuantum.keys()].sort((a, b) => a - b);
  let editError: unknown = null, suspendError: unknown = null, applied = 0;
  const suspendAt = (quantum: number, run: () => void) =>
    // suspend() rounds up to a quantum; half a frame early lands exactly on this one.
    context.suspend(Math.max(0, quantum * RENDER_QUANTUM - 0.5) / sampleRate).then(
      () => {
        run();
        return context.resume();
      },
      (error: unknown) => {
        suspendError ??= error;
      },
    ).catch((error: unknown) => {
      suspendError ??= error;
    });
  let expected = quanta.length;
  if (lateSuspend) {
    if (!quanta.length) throw new Error('renderOffline: testLateSuspend needs at least one edit');
    expected++;
  }
  for (const [i, quantum] of quanta.entries()) {
    void suspendAt(quantum, () => {
      // Rendering has started by the first handler, so this suspend is always refused.
      if (lateSuspend && i === 0) void suspendAt(Math.floor(length / RENDER_QUANTUM) - 1, () => applied++);
      applied++;
      try {
        for (const edit of byQuantum.get(quantum)!) edit.apply(like);
      } catch (error) {
        editError ??= error;
      }
    });
  }
  // Let the background registrations land before rendering takes the suspend list (see SuspendRaceError).
  if (quanta.length) await new Promise((resolve) => setTimeout(resolve, 1));
  const buffer = await context.startRendering();
  if (editError) throw editError;
  if (suspendError || applied < expected) throw new SuspendRaceError(expected - applied, expected, suspendError ?? undefined);
  return {
    sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i).slice()),
  };
}

export function peak(audio: RenderedAudio): number {
  let max = 0;
  for (const data of audio.channels) for (const v of data) max = Math.max(max, Math.abs(v));
  return max;
}

/** The largest absolute sample difference between two renders of the same length and channel count. */
export function maxDifference(a: RenderedAudio, b: RenderedAudio): number {
  if (a.channels.length !== b.channels.length || a.channels.some((data, ch) => data.length !== b.channels[ch]!.length)) return Infinity;
  let max = 0;
  a.channels.forEach((data, ch) => data.forEach((v, i) => (max = Math.max(max, Math.abs(v - b.channels[ch]![i]!)))));
  return max;
}

/**
 * How far two renders of the same events may differ. node-web-audio-api can
 * sum a mixing node's inputs in a different order from one render to the
 * next when voices are added mid-render (seen under a busy test run: up to
 * 9e-8, from a note onset on). 1e-6 is −120 dBFS, far under a 16-bit step.
 */
export const RENDER_TOLERANCE = 1e-6;

/** Fraction of samples, across all channels, with |v| at or above `level`. */
export function guardFraction(audio: RenderedAudio, level: number): number {
  let over = 0, total = 0;
  for (const data of audio.channels) {
    for (const v of data) if (Math.abs(v) >= level) over++;
    total += data.length;
  }
  return total ? over / total : 0;
}

/** RMS per block of `blockSeconds`, averaged across channels, rounded to 1e-6. */
export function blockLoudness(audio: RenderedAudio, blockSeconds = 0.05): number[] {
  const size = Math.round(blockSeconds * audio.sampleRate), length = audio.channels[0]?.length ?? 0, out: number[] = [];
  for (let start = 0; start < length; start += size) {
    let sum = 0, count = 0;
    for (const data of audio.channels) for (let i = start; i < Math.min(length, start + size); i++, count++) sum += data[i]! * data[i]!;
    out.push(Math.round(Math.sqrt(sum / Math.max(1, count)) * 1e6) / 1e6);
  }
  return out;
}

/** Longest run of samples (in seconds) where every channel is below `threshold`. */
export function longestSilence(audio: RenderedAudio, threshold = 1e-4, from = 0, to = Infinity): number {
  const length = audio.channels[0]?.length ?? 0;
  const first = Math.max(0, Math.floor(from * audio.sampleRate)), last = Math.min(length, Math.ceil(to * audio.sampleRate));
  let run = 0, longest = 0;
  for (let i = first; i < last; i++) {
    run = audio.channels.every((data) => Math.abs(data[i]!) < threshold) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest / audio.sampleRate;
}

/** 16-bit PCM WAV. */
export function encodeWav(audio: RenderedAudio): Uint8Array {
  const channels = audio.channels.length, frames = audio.channels[0]?.length ?? 0, dataBytes = frames * channels * 2;
  const view = new DataView(new ArrayBuffer(44 + dataBytes));
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (const data of audio.channels) {
      const v = Math.max(-1, Math.min(1, data[i]!));
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(view.buffer);
}
