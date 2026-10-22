// The frame clock (design.md, "Visual nodes run on the frame clock"). Each
// animation frame the visual nodes get the stretch of the audio clock since
// the last frame, shifted back by the output latency, so a splash lands when
// its note is heard rather than when it is scheduled or rendered. A tap's own
// events skip the shift: the runtime hands them over by arrival (ADR 0020).
//
// The clocks and the frame timer are injected, as for the Scheduler, so the
// same loop runs under requestAnimationFrame, headless and in tests.
import type { AudioContextLike } from './audio/types';

/** Longest frame step, in seconds: Flow's tick clamps dt like this (the solver clamps again at 35 ms). */
export const MAX_FRAME_DT = 0.033;
/** The step for a first frame, or when the wall clock didn't move forward. */
export const FALLBACK_FRAME_DT = 0.016;
/** The widest frame interval, in seconds. After a hidden tab or a long stall the first frame back
 *  covers only the last stretch of this length, rather than everything since the last frame. */
export const MAX_FRAME_SPAN = 0.25;
/** How far behind a frame's t0 a scheduled event may still be shown late, in seconds (Runtime.frame).
 *  Covers a catch-up's late events (ADR 0017, at most 100 ms); older ones are dropped. */
export const FRAME_BACKLOG = 0.25;
/** Scheduled events held per visual node input while no frame runs (a hidden tab); the oldest go first. */
export const FRAME_QUEUE_LIMIT = 4096;

export interface FrameClock {
  /** The audio clock in seconds: AudioContext.currentTime. */
  audioTime(): number;
  /** A wall clock in milliseconds: the rAF timestamp or performance.now(). Gives dt. */
  wallTime(): number;
  /** Seconds between the audio clock and the speakers (`outputLatencyOf`). Default 0. */
  outputLatency?(): number;
}

export interface FrameTimer {
  /** Calls `tick` once per display frame until the returned function is called
   *  (requestAnimationFrame, re-requested before each call). */
  everyFrame(tick: () => void): () => void;
}

/** What one frame ran. */
export interface FrameTick {
  /** The frame clock's interval [t0, t1): audio time minus latency. */
  t0: number;
  t1: number;
  /** Seconds to step, from the wall clock, clamped. */
  dt: number;
  /** The latency subtracted, in seconds. */
  latency: number;
}

/** What a FrameLoop drives: `Runtime.frame`. */
export interface FrameTarget {
  frame(t0: number, t1: number, dt: number): void;
}

export interface FrameLoopOptions {
  clock: FrameClock;
  /** Drives `start()`. Tests and headless runs can call `tick()` themselves. */
  timer?: FrameTimer;
  maxDt?: number;
  fallbackDt?: number;
  maxSpan?: number;
}

/**
 * The output latency of an AudioContext, in seconds: `outputLatency` where the
 * browser reports it (it includes Bluetooth), else `baseLatency`, else 0.
 * Never negative or NaN.
 */
export function outputLatencyOf(context: Pick<AudioContextLike, 'outputLatency' | 'baseLatency'>): number {
  const latency = context.outputLatency || context.baseLatency || 0;
  return Number.isFinite(latency) && latency > 0 ? latency : 0;
}

/** The frame loop. One per running patch, beside the Scheduler. */
export class FrameLoop {
  private readonly target: FrameTarget;
  private readonly clock: FrameClock;
  private readonly timer: FrameTimer | undefined;
  private readonly maxDt: number;
  private readonly fallbackDt: number;
  private readonly maxSpan: number;
  private last: { t1: number; wall: number } | null = null;
  private stop: (() => void) | null = null;

  constructor(target: FrameTarget, options: FrameLoopOptions) {
    this.target = target;
    this.clock = options.clock;
    this.timer = options.timer;
    this.maxDt = options.maxDt ?? MAX_FRAME_DT;
    this.fallbackDt = options.fallbackDt ?? FALLBACK_FRAME_DT;
    this.maxSpan = options.maxSpan ?? MAX_FRAME_SPAN;
  }

  /**
   * One frame: [t0, t1) runs from the last frame's t1 to audio time minus the
   * output latency. The first frame (and the first after `reset`) is empty,
   * t0 = t1, with the fallback dt. t1 never moves back, so a latency that
   * grows mid-run (a Bluetooth headset connecting) holds the frame clock still
   * until audio time catches up, rather than showing anything twice. An
   * interval wider than MAX_FRAME_SPAN (the first frame after a hidden tab)
   * is cut to its last MAX_FRAME_SPAN, so visual nodes don't get a long
   * backlog at once; the runtime drops what's left behind (FRAME_BACKLOG).
   */
  tick(): FrameTick {
    const wall = this.clock.wallTime();
    const raw = this.clock.outputLatency?.() ?? 0;
    const latency = Number.isFinite(raw) && raw > 0 ? raw : 0;
    const now = this.clock.audioTime() - latency;
    const last = this.last;
    const t1 = Math.max(last ? last.t1 : now, now);
    const t0 = last ? Math.max(last.t1, t1 - this.maxSpan) : now;
    const elapsed = last ? (wall - last.wall) / 1000 : NaN;
    const dt = elapsed > 0 ? Math.min(this.maxDt, elapsed) : this.fallbackDt;
    this.last = { t1, wall };
    this.target.frame(t0, t1, dt);
    return { t0, t1, dt, latency };
  }

  /** Forgets the last frame, so the next tick starts afresh (after the audio clock was replaced, say). */
  reset(): void {
    this.last = null;
  }

  /** Ticks on the injected timer. The timer should ask for the next frame before
   *  calling `tick`, so a frame that throws doesn't stop the loop. */
  start(): void {
    if (this.stop) return;
    if (!this.timer) throw new Error('FrameLoop.start needs a timer; call tick() yourself instead');
    this.stop = this.timer.everyFrame(() => this.tick());
  }

  halt(): void {
    this.stop?.();
    this.stop = null;
    this.last = null;
  }
}
