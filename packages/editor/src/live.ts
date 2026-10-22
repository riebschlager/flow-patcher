// Runs a patch in the browser: one AudioContext, the real Scheduler on the
// audio clock, and the performance canvas's pointer events on the immediate
// path (design.md, Timing and evaluation; Platform rules).
import { compilePatch, Runtime, Scheduler, type AudioContextLike, type Patch, type SchedulerStats } from '@flow-patcher/engine';
import { nodeRegistry } from '@flow-patcher/nodes';

/** Pointer events the canvas forwards, as Pointer node output ports. */
export type PointerPort = 'down' | 'move' | 'up' | 'cancel';

/** One pointerdown, for the Immediate path gate check (docs/milestones.md, M1). */
export interface Tap {
  /** currentTime when the handler ran, in seconds. */
  at: number;
  /** The time the push was stamped, or null when it was held for the AudioContext to start. */
  stamped: number | null;
  /** When the first note it caused starts sounding: the earliest oscillator start scheduled during the push.
   *  A cold tap's push runs on a later wake, so it takes the next oscillator start instead (approximate). */
  note: number | null;
  /** The push had to start the AudioContext, so its timing includes startup. */
  cold: boolean;
}

export interface LiveStatus {
  audio: AudioContextState;
  pointers: number;
}

export class LivePatch {
  readonly scheduler: Scheduler;
  readonly taps: Tap[] = [];
  private readonly context: AudioContext;
  private readonly runtime: Runtime;
  /** Pointer nodes the canvas feeds. Canvas sources are host-fed, so the runner finds them by type. */
  private readonly pointers: string[];
  /** Oscillator starts scheduled while a push runs, collected for its Tap. */
  private starts: number[] | null = null;
  /** A cold tap still waiting for its held push to run. */
  private coldTap: Tap | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly onVisibility = () => this.scheduler.wake();

  constructor(patch: Patch) {
    const compiled = compilePatch(patch, nodeRegistry);
    if (!compiled.ok) throw new Error(compiled.errors.join('; '));
    this.runtime = new Runtime(compiled.plan);
    this.runtime.onWarning = (message) => console.warn(`[live] ${message}`);
    this.pointers = compiled.plan.order.filter((node) => node.definition.type === 'pointer').map((node) => node.id);
    this.context = new AudioContext({ latencyHint: 'interactive' });
    this.runtime.attachAudio(this.observeStarts(this.context));
    const context = this.context;
    this.scheduler = new Scheduler(this.runtime, {
      clock: {
        audioTime: () => context.currentTime,
        wallTime: () => performance.now(),
        running: () => context.state === 'running',
        hidden: () => document.hidden,
      },
      timer: {
        every(ms, tick) {
          const id = setInterval(tick, ms);
          return () => clearInterval(id);
        },
      },
      onStall: (stall) => console.warn(`[live] stall: ${stall.skipped} window(s) skipped, ${(stall.late * 1000).toFixed(1)} ms late`),
    });
    context.addEventListener('statechange', () => {
      // Held pushes run on the first wake after the context starts.
      this.scheduler.wake();
      this.emit();
    });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.scheduler.start();
  }

  get status(): LiveStatus {
    return { audio: this.context.state, pointers: this.pointers.length };
  }

  get stats(): SchedulerStats {
    return this.scheduler.stats;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sends one pointer event to every Pointer node. x and y are 0–1, y = 0 at the top. */
  pointer(port: PointerPort, fields: { channel: number; x: number; y: number; pressure: number; pointerType: string }): void {
    const cold = this.context.state !== 'running';
    // The first pointerdown starts audio. Its push is held until then, so the first touch still sounds (Platform rules).
    if (cold && port === 'down') void this.context.resume();
    // Pushes are held while audio is stopped, so hover moves before the first tap would pile up and
    // replay as a burst that the event cap can cut the Down out of. Down carries the position anyway.
    if (!this.pointers.length || (cold && port === 'move')) return;
    const at = this.context.currentTime;
    this.starts = [];
    let stamped: number | null = null;
    try {
      for (const id of this.pointers) stamped ??= this.scheduler.push(id, port, fields)?.time ?? null;
    } finally {
      const starts = this.starts;
      this.starts = null;
      if (port === 'down') {
        const tap: Tap = { at, stamped, note: starts.length ? Math.min(...starts) : null, cold };
        if (cold && tap.note === null) this.coldTap = tap;
        this.taps.push(tap);
        if (this.taps.length > 100) this.taps.shift();
        console.debug(`[live] tap: stamped ${ms(tap.stamped, at)}, note ${ms(tap.note, at)} after currentTime${cold ? ' (cold)' : ''}`);
      }
    }
  }

  dispose(): void {
    this.scheduler.halt();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.runtime.dispose();
    void this.context.close();
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** The AudioContext as the runtime sees it, noting oscillator start times while a push runs. */
  private observeStarts(context: AudioContext): AudioContextLike {
    return {
      get currentTime() {
        return context.currentTime;
      },
      get sampleRate() {
        return context.sampleRate;
      },
      destination: context.destination,
      createGain: () => context.createGain(),
      createDynamicsCompressor: () => context.createDynamicsCompressor(),
      createWaveShaper: () => context.createWaveShaper(),
      createOscillator: () => {
        const osc = context.createOscillator();
        const start = osc.start.bind(osc);
        osc.start = (when = 0) => {
          this.noteStart(Math.max(when, context.currentTime));
          start(when);
        };
        return osc;
      },
    };
  }

  private noteStart(time: number): void {
    if (this.starts) this.starts.push(time);
    else if (this.coldTap) {
      this.coldTap.note = time;
      this.coldTap = null;
    }
  }
}

const ms = (time: number | null, from: number) => (time === null ? '—' : `${((time - from) * 1000).toFixed(2)} ms`);
