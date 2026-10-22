// Where the fluid steps (ADR 0016). The Fluid node hands each frame's work to a
// FluidBackend it gets from the host (`HostServices.fluid`): the splats due, the
// knobs, and a step of dt. Readers see the last finished step, latched at the
// start of each frame, as colored pixels.
//
// Two ways to run it, one protocol:
// - In a Worker (the browser). The engine has no Worker code: the host writes
//   a tiny script around `createFluidStepper` and wires it to a `FluidHost`:
//
//     // fluid-worker.ts
//     const step = createFluidStepper(() => performance.now());
//     self.onmessage = (e) => { const reply = step(e.data); self.postMessage(reply, fluidReplyTransfer(reply)); };
//
//     // main thread
//     const worker = new Worker(new URL('./fluid-worker.ts', import.meta.url), { type: 'module' });
//     const fluid = new FluidHost((request, transfer) => worker.postMessage(request, transfer));
//     worker.onmessage = (e) => fluid.receive(e.data);
//     worker.onerror = (e) => fluid.fail(e.message);
//     worker.onmessageerror = () => fluid.fail('reply could not be read');
//
// - In process (`createInProcessFluid`): the same host and stepper, with the
//   reply handed back at once. Headless runs and tests use it; every frame
//   steps in lockstep, so the CPU solver's output stays bit-exact.
import { createFluidColorizer, renderFluidPixels, type Colorizer } from '../render/fluid-renderer';
import { Fluid } from './fluid';

/** One `Fluid.splat` call: x, y (0–1), dye r, g, b, size, dx, dy. */
export type SplatArgs = readonly [x: number, y: number, r: number, g: number, b: number, size: number, dx: number, dy: number];

/** The solver's knobs, as the solver names them. Fluid's knobs map onto these (`fluidSolverParams`). */
export interface FluidSolverParams {
  /** Vorticity confinement. */
  swirl: number;
  /** Dye persistence, 0–1. */
  persistence: number;
  /** Velocity kept per 1/60 s. */
  drag: number;
}

/** One frame's work for the fluid, as the Fluid node hands it over. */
export interface FluidWork {
  /** Seconds to step. */
  dt: number;
  grid: { w: number; h: number };
  params: FluidSolverParams;
  /** Palette id for the colorizer (render/palettes.ts); unknown ids fall back to classic. */
  palette: string;
  /** Applied in order before the step. */
  splats: readonly SplatArgs[];
  /** Seconds on the audio clock, for the colorizer's slow shimmer. */
  time: number;
}

/** What goes to the worker: one or more frames' work merged, and a pixel buffer to reuse. */
export interface FluidStepRequest extends FluidWork {
  /** Counts resets: the stepper clears the solver when it changes, and the host drops replies from before one. */
  generation: number;
  /** The pixels of an earlier reply, handed back so the worker needn't allocate. Transferred. */
  recycle: Uint8ClampedArray | null;
}

/** What comes back: the dye after the step, colored. `pixels` is transferred, not copied. */
export interface FluidStepReply {
  generation: number;
  w: number;
  h: number;
  /** RGBA, row-major, top row first: one pixel per cell. */
  pixels: Uint8ClampedArray;
  /** Wall-clock milliseconds the step and the colorizing took (0 without a clock). */
  stepMs: number;
  colorMs: number;
}

/** A finished step, as readers see it. The same shape as a node image. */
export interface FluidImage {
  width: number;
  height: number;
  /** RGBA, row-major. Valid until the next frame's latch; copy it to keep it. */
  pixels: Uint8ClampedArray;
}

/** Where the Fluid node sends its work. One per running patch (ADR 0003: one Fluid). */
export interface FluidBackend {
  /**
   * Readers' view moves to the last finished step. The Fluid node calls it at
   * the start of its frame, so every reader in a frame sees the same step and
   * never the one this frame starts (ADR 0016).
   */
  latch(): void;
  /** The step latched at this frame's start, or null before the first finished step. */
  latched(): FluidImage | null;
  /** One frame's work. In process it steps at once; a worker host may merge it into the next step. */
  step(work: FluidWork): void;
  /** Clears the fluid: the next step starts from still water. Work queued since the last step is dropped. */
  reset(): void;
}

/** Fluid's knobs onto the solver's, as the M0 spike mapped them. */
export function fluidSolverParams(vorticity: number, dissipation: number, viscosity: number): FluidSolverParams {
  return { swirl: vorticity, persistence: 1 - dissipation, drag: 0.994 - viscosity * 0.06 };
}

/**
 * The worker's side of the protocol: a solver kept between calls. Each request
 * resizes it to the grid, sets the knobs, applies the splats, steps `dt` and
 * colors the dye into `recycle` (or a new buffer when that is missing or the
 * wrong size). Pure apart from that solver and `now`, which only times it.
 */
export function createFluidStepper(now: () => number = () => 0): (request: FluidStepRequest) => FluidStepReply {
  let sim: Fluid | null = null;
  let generation = 0;
  const colorizers = new Map<string, Colorizer>();
  return (request) => {
    const { dt, grid, params, splats, time, recycle } = request;
    if (!sim || request.generation !== generation) {
      sim = new Fluid(grid.w, grid.h);
      generation = request.generation;
    } else sim.resize(grid.w, grid.h);
    sim.swirl = params.swirl;
    sim.persistence = params.persistence;
    sim.drag = params.drag;
    for (const [x, y, r, g, b, size, dx, dy] of splats) sim.splat(x, y, [r, g, b], size, dx, dy);
    const start = now();
    sim.step(dt);
    const stepped = now();
    const pixels = recycle?.length === sim.n * 4 ? recycle : new Uint8ClampedArray(sim.n * 4);
    let colorize = colorizers.get(request.palette);
    if (!colorize) colorizers.set(request.palette, (colorize = createFluidColorizer(request.palette)));
    renderFluidPixels(sim, pixels, time, colorize);
    return { generation, w: sim.w, h: sim.h, pixels, stepMs: stepped - start, colorMs: now() - stepped };
  };
}

/** The buffers to transfer with a reply (postMessage's transfer list). */
export const fluidReplyTransfer = (reply: FluidStepReply): ArrayBuffer[] => [reply.pixels.buffer as ArrayBuffer];

/** Sends a request on, e.g. `worker.postMessage(request, transfer)`. */
export type FluidPost = (request: FluidStepRequest, transfer: ArrayBuffer[]) => void;

/** What a FluidHost has done, for the host's stats. */
export interface FluidHostStats {
  /** Requests sent. */
  sent: number;
  /** Replies latched or waiting to be. */
  received: number;
  /** Frames whose work waited for a busy worker and went with a later step. */
  merged: number;
  /** Requests that failed (`fail`). */
  failed: number;
  /** The last reply's timings. */
  stepMs: number;
  colorMs: number;
}

/**
 * The main thread's side of the protocol, DOM-free, with the M0 spike's rules:
 * - one step in flight at a time;
 * - work that arrives while one is in flight waits: its dt adds up (the solver
 *   caps a step at 35 ms), its splats queue, and the latest knobs, grid,
 *   palette and time win, so a slow device steps less often rather than
 *   queueing work;
 * - a spare pixel buffer goes back with the next request, so steady state
 *   allocates nothing;
 * - a failure (`fail`) clears the busy flag, so the next frame sends again
 *   and the fluid doesn't freeze. The failed step's splats are lost.
 * Readers latch the last finished step at each frame.
 */
export class FluidHost implements FluidBackend {
  readonly stats: FluidHostStats = { sent: 0, received: 0, merged: 0, failed: 0, stepMs: 0, colorMs: 0 };
  private busy = false;
  /** Work waiting for the next request. */
  private owed: FluidWork | null = null;
  private generation = 0;
  /** The reply readers see this frame, and the newest one not yet latched. */
  private shown: FluidImage | null = null;
  private finished: FluidImage | null = null;
  private spare: Uint8ClampedArray | null = null;

  constructor(private readonly post: FluidPost) {}

  latch(): void {
    if (!this.finished) return;
    if (this.shown) this.spare = this.shown.pixels;
    this.shown = this.finished;
    this.finished = null;
  }

  latched(): FluidImage | null {
    return this.shown;
  }

  /** True while a step is in flight. */
  get pending(): boolean {
    return this.busy;
  }

  step(work: FluidWork): void {
    if (this.owed) {
      this.stats.merged++;
      this.owed = { ...work, dt: this.owed.dt + work.dt, splats: [...this.owed.splats, ...work.splats] };
    } else this.owed = { ...work, splats: [...work.splats] };
    this.flush();
  }

  reset(): void {
    this.generation++;
    this.owed = null;
    this.shown = this.finished = null;
  }

  /** A reply from the worker. Replies from before a reset only give their buffer back. */
  receive(reply: FluidStepReply): void {
    this.busy = false;
    this.stats.received++;
    this.stats.stepMs = reply.stepMs;
    this.stats.colorMs = reply.colorMs;
    const image = { width: reply.w, height: reply.h, pixels: reply.pixels };
    if (reply.generation !== this.generation) this.spare = reply.pixels;
    else {
      // A reply that arrived after another one in the same frame replaces it; that one's buffer is spare.
      if (this.finished) this.spare = this.finished.pixels;
      this.finished = image;
    }
  }

  /** The worker failed a step (onerror, onmessageerror). Its buffers are gone; the next frame sends again. */
  fail(_reason?: unknown): void {
    this.busy = false;
    this.spare = null;
    this.stats.failed++;
  }

  private flush(): void {
    if (this.busy || !this.owed) return;
    const work = this.owed;
    const recycle = this.spare;
    this.owed = null;
    this.spare = null;
    this.busy = true;
    this.stats.sent++;
    const request: FluidStepRequest = { ...work, grid: { ...work.grid }, params: { ...work.params }, splats: work.splats, generation: this.generation, recycle };
    try {
      this.post(request, recycle ? [recycle.buffer as ArrayBuffer] : []);
    } catch (error) {
      // A post that throws never reaches the worker; nothing will reply.
      this.fail(error);
      throw error;
    }
  }
}

/**
 * The backend for headless runs and tests: the stepper runs inside `step`, so
 * each frame's step has finished before the next frame latches it.
 */
export function createInProcessFluid(now?: () => number): FluidHost {
  const stepper = createFluidStepper(now);
  const host: FluidHost = new FluidHost((request) => host.receive(stepper(request)));
  return host;
}
