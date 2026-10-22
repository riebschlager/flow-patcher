// Runs a patch in the browser: one AudioContext, the real Scheduler on the
// audio clock, the frame loop on requestAnimationFrame with the fluid in a
// Worker, and the performance canvas's pointer events on the immediate path
// (design.md, Timing and evaluation; Visual nodes run on the frame clock;
// Platform rules; ADR 0016, 0020).
import {
  compilePatch,
  FLUID_BACKGROUND,
  FluidHost,
  FrameLoop,
  outputLatencyOf,
  Runtime,
  Scheduler,
  type AudioContextLike,
  type FluidHostStats,
  type Patch,
  type SchedulerStats,
} from '@flow-patcher/engine';
import { INSTRUMENTS, instrumentCache, nodeRegistry, rendererImage } from '@flow-patcher/nodes';

/** Pointer events the canvas forwards, as Pointer node output ports. */
export type PointerPort = 'down' | 'move' | 'up' | 'cancel';

/** One pointerdown, for the Immediate path gate check (docs/milestones.md, M1). */
export interface Tap {
  /** currentTime when the handler ran, in seconds. */
  at: number;
  /** The pointerdown on the audio clock: `at` less the time the event waited before its handler ran
   *  (performance.now() − event.timeStamp). currentTime only moves once per audio callback, so this is
   *  `at`'s granularity, not a sample-exact mapping; what it adds is the main-thread wait ADR 0016 guards. */
  down: number;
  /** The time the push was stamped, or null when it was held for the AudioContext to start. */
  stamped: number | null;
  /** When the first note it caused starts sounding: the earliest oscillator start scheduled during the push.
   *  A cold tap's push runs on a later wake, so it takes the next oscillator start instead (approximate). */
  note: number | null;
  /** The push had to start the AudioContext, so its timing includes startup. */
  cold: boolean;
  /** The tap's splash (ADR 0020), null until it is drawn, or with no Renderer:
   *  - `handed`: frames after the push until a frame handed the tap's own event to a visual node (1 = the
   *    next frame, skipping the output-latency shift);
   *  - `frames`, `ms`: frames after the push, and ms after the pointerdown, until the Renderer drew the
   *    Fluid step that carried it. */
  splash: { handed: number; frames: number; ms: number } | null;
  /** The Fluid step carrying the splash was dropped (Worker failure, reset or splat cap), so it was never drawn. */
  splashLost: boolean;
}

/** The frame loop's counters, for the Immediate path under load gate check. */
export interface FrameStats {
  /** Frames ticked. */
  frames: number;
  /** Frames the Renderer had a picture for. */
  drawn: number;
  /** The fluid Worker's steps and timings, or null with no Fluid. */
  fluid: FluidHostStats | null;
}

/** A splash on its way to the canvas: handed to a visual node by a frame (`Runtime.lastFrame.taps`), then
 *  drawn once the Fluid has latched the step that frame took. */
interface PendingSplash {
  tap: Tap;
  /** The push's stamp, as the frame report lists it. */
  time: number;
  /** Wall time of the pointerdown, ms. */
  downWall: number;
  /** Frames ticked when the push ran. */
  frame: number;
  /** Once a frame handed it over: frames since the push, and the Fluid's step count after that frame. */
  carried: { handed: number; step: number } | null;
}

/** Sampled Voice's samples, served from the repo's vendor/ (packages/editor/vite.config.ts). */
async function fetchSample(file: string): Promise<string> {
  const response = await fetch(`${import.meta.env.BASE_URL}vendor/${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(`Couldn't load ${file} (HTTP ${response.status})`);
  return response.text();
}

/** An inline status on a node's card (design system: Node `status`). */
export interface NodeStatus {
  kind: 'loading' | 'error';
  message: string;
  /** Label of the action that `retry()` performs. */
  action?: string;
}

export interface LiveStatus {
  audio: AudioContextState;
  pointers: number;
}

export class LivePatch {
  readonly scheduler: Scheduler;
  readonly taps: Tap[] = [];
  private readonly context: AudioContext;
  /** The context as the runtime sees it: the instrument cache is keyed by this object. */
  private readonly audio: AudioContextLike;
  /** Each Sampled Voice's instrument, by node id. */
  private readonly instruments: Map<string, string>;
  private readonly unsubscribeInstruments: () => void;
  private readonly runtime: Runtime;
  /** Pointer nodes the canvas feeds. Canvas sources are host-fed, so the runner finds them by type. */
  private readonly pointers: string[];
  /** Oscillator starts scheduled while a push runs, collected for its Tap. */
  private starts: number[] | null = null;
  /** A cold tap still waiting for its held push to run. */
  private coldTap: Tap | null = null;
  private readonly frames: FrameLoop;
  private readonly fluid: { host: FluidHost; worker: Worker } | null;
  /** The Renderer the canvas shows: the first in plan order (one per patch). */
  private readonly renderer: string | null;
  private canvas: HTMLCanvasElement | null = null;
  /** The fluid's pixels at grid size, scaled onto the canvas. */
  private readonly ink = document.createElement('canvas');
  private readonly frameCounts = { frames: 0, drawn: 0 };
  private readonly splashes: PendingSplash[] = [];
  private raf = 0;
  private workerStalled = false;
  private readonly listeners = new Set<() => void>();
  private readonly onVisibility = () => this.scheduler.wake();

  constructor(patch: Patch) {
    const compiled = compilePatch(patch, nodeRegistry);
    if (!compiled.ok) throw new Error(compiled.errors.join('; '));
    this.fluid = compiled.plan.order.some((node) => node.definition.type === 'fluid') ? createFluidWorker() : null;
    this.runtime = new Runtime(compiled.plan, { services: { ...(this.fluid && { fluid: this.fluid.host }), samples: fetchSample } });
    this.renderer = compiled.plan.order.find((node) => node.definition.type === 'renderer')?.id ?? null;
    this.runtime.onWarning = (message) => console.warn(`[live] ${message}`);
    this.pointers = compiled.plan.order.filter((node) => node.definition.type === 'pointer').map((node) => node.id);
    this.instruments = new Map(compiled.plan.order.filter((node) => node.definition.type === 'sampled-voice').map((node) => [node.id, node.params.instrument as string]));
    this.context = new AudioContext({ latencyHint: 'interactive' });
    this.audio = this.observeStarts(this.context);
    this.runtime.attachAudio(this.audio);
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
    // Subscribed once everything that can throw is built, so a failed constructor leaves no listener behind.
    this.unsubscribeInstruments = instrumentCache.subscribe((audio) => {
      if (audio === this.audio) this.emit();
    });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.scheduler.start();
    this.frames = new FrameLoop(this.runtime, {
      clock: {
        audioTime: () => context.currentTime,
        wallTime: () => performance.now(),
        outputLatency: () => outputLatencyOf(context),
      },
    });
    const run = () => {
      // Ask for the next frame first, so a frame that throws doesn't stop the loop.
      this.raf = requestAnimationFrame(run);
      this.frame();
    };
    this.raf = requestAnimationFrame(run);
  }

  get status(): LiveStatus {
    return { audio: this.context.state, pointers: this.pointers.length };
  }

  /** What a node's card shows inline: a Sampled Voice's instrument loading or failed to load. Null when there's nothing to say. */
  nodeStatus(nodeId: string): NodeStatus | null {
    const key = this.instruments.get(nodeId);
    if (key === undefined) return null;
    const name = (INSTRUMENTS[key]?.name ?? key).toLowerCase();
    switch (instrumentCache.status(this.audio, key)) {
      case 'loading': return { kind: 'loading', message: `Loading ${name}` };
      case 'error': return { kind: 'error', message: `Couldn't load ${name}. Check your connection, then retry.`, action: 'Retry' };
      default: return null;
    }
  }

  /** The action on an error status: loads a Sampled Voice's instrument again. Its notes play once it's ready. */
  retry(nodeId: string): void {
    const key = this.instruments.get(nodeId);
    if (key !== undefined) instrumentCache.load(this.audio, key, fetchSample).catch(() => {});
  }

  get stats(): SchedulerStats {
    return this.scheduler.stats;
  }

  /** A node's state, for e2e and the console (such as Sampled Voice's skipped-note count). */
  stateOf(nodeId: string): Readonly<Record<string, unknown>> | undefined {
    return this.runtime.stateOf(nodeId);
  }

  get frameStats(): FrameStats {
    return { ...this.frameCounts, fluid: this.fluid ? { ...this.fluid.host.stats } : null };
  }

  /** The canvas the Renderer draws into, or null to stop drawing. */
  attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sends one pointer event to every Pointer node. x and y are 0–1, y = 0 at the top. */
  pointer(
    port: PointerPort,
    fields: { channel: number; x: number; y: number; pressure: number; pointerType: string },
    /** The event's timeStamp (performance.now() time), when it came from a real input event. */
    timeStamp?: number,
  ): void {
    const cold = this.context.state !== 'running';
    // The first pointerdown starts audio. Its push is held until then, so the first touch still sounds (Platform rules).
    if (cold && port === 'down') void this.context.resume();
    // Pushes are held while audio is stopped, so hover moves before the first tap would pile up and
    // replay as a burst that the event cap can cut the Down out of. Down carries the position anyway.
    if (!this.pointers.length || (cold && port === 'move')) return;
    const at = this.context.currentTime;
    const wall = performance.now();
    const waited = timeStamp !== undefined && timeStamp <= wall ? (wall - timeStamp) / 1000 : 0;
    this.starts = [];
    let stamped: number | null = null;
    try {
      for (const id of this.pointers) stamped ??= this.scheduler.push(id, port, fields)?.time ?? null;
    } finally {
      const starts = this.starts;
      this.starts = null;
      if (port === 'down') {
        const tap: Tap = { at, down: at - waited, stamped, note: starts.length ? Math.min(...starts) : null, cold, splash: null, splashLost: false };
        if (cold && tap.note === null) this.coldTap = tap;
        if (this.renderer && this.fluid && stamped !== null) {
          this.splashes.push({ tap, time: stamped, downWall: wall - waited * 1000, frame: this.frameCounts.frames, carried: null });
        }
        this.taps.push(tap);
        if (this.taps.length > 100) this.taps.shift();
        console.debug(`[live] tap: stamped ${ms(tap.stamped, tap.down)}, note ${ms(tap.note, tap.down)} after pointerdown${cold ? ' (cold)' : ''}`);
      }
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.fluid?.worker.terminate();
    this.scheduler.halt();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.runtime.dispose();
    this.unsubscribeInstruments();
    void this.context.close();
    this.listeners.clear();
  }

  /** One animation frame: the visual nodes on the frame clock, then the Renderer's picture onto the canvas. */
  private frame(): void {
    this.frameCounts.frames++;
    this.frames.tick();
    const image = this.renderer ? rendererImage(this.runtime.stateOf(this.renderer) ?? {}) : null;
    if (image) this.frameCounts.drawn++;
    this.draw(image);
    this.trackSplashes();
    this.watchWorker();
  }

  /** Warns once per stall when the fluid Worker hasn't answered a step for a couple of seconds (it may have hung). */
  private watchWorker(): void {
    const waiting = this.fluid?.host.stats.waitingFrames ?? 0;
    if (waiting > WORKER_STALL && !this.workerStalled) console.warn(`[live] fluid worker: no reply for ${waiting} frames`);
    this.workerStalled = waiting > WORKER_STALL;
  }

  /** Follows each tap's splash: the frame that handed the tap's event over, then the frame that drew it. */
  private trackSplashes(): void {
    const host = this.fluid?.host;
    if (!host || !this.splashes.length) return;
    const report = this.runtime.lastFrame;
    for (const pending of this.splashes) {
      if (!pending.carried && report?.taps.some((tap) => tap.time === pending.time)) {
        // The Fluid stepped after its writers this frame, so its newest step carries the splat.
        pending.carried = { handed: this.frameCounts.frames - pending.frame, step: host.stepCount };
      }
    }
    // Shown once the Fluid has latched (at a frame's start) the step that carried it.
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const { tap, downWall, frame, carried } = this.splashes[i]!;
      // Never handed over (the tap reaches no visual node), or never latched (a hung Worker): stop following it.
      if (this.frameCounts.frames - frame > SPLASH_GIVE_UP) {
        this.splashes.splice(i, 1);
        continue;
      }
      if (!carried) continue;
      // The step that carried it failed, or its work was cleared or capped: it will never be drawn.
      if (host.lostThrough >= carried.step) {
        this.splashes.splice(i, 1);
        tap.splashLost = true;
        console.debug(`[live] splash lost: the fluid step that carried it was dropped`);
        continue;
      }
      if (host.latchedThrough < carried.step) continue;
      this.splashes.splice(i, 1);
      tap.splash = { handed: carried.handed, frames: this.frameCounts.frames - frame, ms: performance.now() - downWall };
      console.debug(`[live] splash: handed over ${carried.handed} frame(s) after the tap, drawn after ${tap.splash.frames} (${tap.splash.ms.toFixed(1)} ms after pointerdown)`);
    }
  }

  private draw(image: ReturnType<typeof rendererImage>): void {
    const canvas = this.canvas;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    if (!image) {
      g.fillStyle = `rgb(${FLUID_BACKGROUND.join(' ')})`;
      g.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    // The pixels go back to the Worker at the next latch, so they're drawn now and not kept.
    if (this.ink.width !== image.width || this.ink.height !== image.height) {
      this.ink.width = image.width;
      this.ink.height = image.height;
    }
    this.ink.getContext('2d')!.putImageData(new ImageData(image.pixels as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(this.ink, 0, 0, canvas.width, canvas.height);
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
      createBiquadFilter: () => context.createBiquadFilter(),
      decodeAudioData: (data) => context.decodeAudioData(data),
      createOscillator: () => {
        const osc = context.createOscillator();
        const start = osc.start.bind(osc);
        osc.start = (when = 0) => {
          this.noteStart(Math.max(when, context.currentTime));
          start(when);
        };
        return osc;
      },
      createBufferSource: () => {
        const source = context.createBufferSource();
        const start = source.start.bind(source);
        source.start = (when = 0, offset?: number, duration?: number) => {
          this.noteStart(Math.max(when, context.currentTime));
          start(when, offset, duration);
        };
        return source;
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

/** Frames to wait for a tap's event to reach a visual node before giving up on its splash. */
const SPLASH_GIVE_UP = 120;
/** Frames a fluid step may stay unanswered before the Worker counts as stalled. */
const WORKER_STALL = 120;

const ms = (time: number | null, from: number) => (time === null ? '—' : `${((time - from) * 1000).toFixed(2)} ms`);

/** The fluid's Worker and the host that talks to it (fluid/backend.ts). */
function createFluidWorker(): { host: FluidHost; worker: Worker } {
  const worker = new Worker(new URL('./fluid-worker.ts', import.meta.url), { type: 'module' });
  const host = new FluidHost((request, transfer) => worker.postMessage(request, transfer));
  worker.onmessage = (event) => host.receive(event.data);
  worker.onerror = (event) => {
    console.warn(`[live] fluid worker: ${event.message}`);
    host.fail(event.message);
  };
  worker.onmessageerror = () => host.fail('reply could not be read');
  return { host, worker };
}
