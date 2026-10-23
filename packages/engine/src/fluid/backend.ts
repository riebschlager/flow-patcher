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
/** One `Fluid.force` call, tagged: a push of (dx, dy) around x, y. */
export type ForceArgs = readonly [op: 'force', x: number, y: number, dx: number, dy: number, radius: number];
/** One `Fluid.pulse` call, tagged: a dye-free vortex around x, y; direction 1 turns clockwise on screen, -1 the other way. */
export type PulseArgs = readonly [op: 'pulse', x: number, y: number, strength: number, radius: number, direction: number];
/** Anything a writer hands the solver before a step. Untagged tuples are splats, so splat-only work keeps its shape. */
export type FluidWrite = SplatArgs | ForceArgs | PulseArgs;

/** Applies one write to the solver. */
export function applyFluidWrite(sim: Fluid, write: FluidWrite): void {
  if (write[0] === 'force') sim.force(write[1], write[2], write[3], write[4], write[5]);
  else if (write[0] === 'pulse') sim.pulse(write[1], write[2], write[3], write[4], write[5]);
  else {
    const [x, y, r, g, b, size, dx, dy] = write as SplatArgs;
    sim.splat(x, y, [r, g, b], size, dx, dy);
  }
}

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
  /** Splats, forces and pulses, applied in order before the step. */
  splats: readonly FluidWrite[];
  /** Seconds on the audio clock, for the colorizer's slow shimmer. */
  time: number;
}

/** What goes to the worker: one or more frames' work merged, and a pixel buffer to reuse. */
export interface FluidStepRequest extends FluidWork {
  /** Counts resets: the stepper clears the solver when it changes, and the host drops replies from before one. */
  generation: number;
  /** Numbers requests; the reply echoes it, so the host can tell a reply to the step in flight from a late one. */
  seq: number;
  /** The pixels of an earlier reply, handed back so the worker needn't allocate. Transferred. */
  recycle: Uint8ClampedArray | null;
}

/** What comes back: the dye after the step, colored. `pixels` is transferred, not copied. */
export interface FluidStepReply {
  generation: number;
  seq: number;
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
    for (const write of splats) applyFluidWrite(sim, write);
    const start = now();
    sim.step(dt);
    const stepped = now();
    const pixels = recycle?.length === sim.n * 4 ? recycle : new Uint8ClampedArray(sim.n * 4);
    let colorize = colorizers.get(request.palette);
    if (!colorize) colorizers.set(request.palette, (colorize = createFluidColorizer(request.palette)));
    renderFluidPixels(sim, pixels, time, colorize);
    return { generation, seq: request.seq, w: sim.w, h: sim.h, pixels, stepMs: stepped - start, colorMs: now() - stepped };
  };
}

/** The buffers to transfer with a reply (postMessage's transfer list). */
export const fluidReplyTransfer = (reply: FluidStepReply): ArrayBuffer[] => [reply.pixels.buffer as ArrayBuffer];

/** Sends a request on, e.g. `worker.postMessage(request, transfer)`. */
export type FluidPost = (request: FluidStepRequest, transfer: ArrayBuffer[]) => void;

/** Splats that may wait for a busy worker; older ones are dropped past it. The per-node event budget. */
export const MAX_OWED_SPLATS = 256;

/** What a FluidHost has done, for the host's stats. */
export interface FluidHostStats {
  /** Requests sent. */
  sent: number;
  /** Replies to the step in flight, in the current generation: the ones readers can latch. */
  received: number;
  /** Replies dropped: from before a reset, or arriving after `fail()` gave their step up. */
  stale: number;
  /** Finished steps moved to the readers by `latch()`. */
  latched: number;
  /** Frames whose work waited for a busy worker and went with a later step. */
  merged: number;
  /** Waiting splats dropped, oldest first, past MAX_OWED_SPLATS. */
  droppedSplats: number;
  /** Requests that failed (`fail`). */
  failed: number;
  /** Frames (`step` calls) since the step in flight was sent; 0 when none is. A worker that died keeps
   *  this growing, so a host can warn on it. */
  waitingFrames: number;
  /** The most `waitingFrames` has reached. */
  maxWaitingFrames: number;
  /** The last reply's timings. */
  stepMs: number;
  colorMs: number;
}

/**
 * The main thread's side of the protocol, DOM-free, with the M0 spike's rules:
 * - one step in flight at a time;
 * - work that arrives while one is in flight waits: its dt adds up (the solver
 *   caps a step at 35 ms), its splats queue (at most MAX_OWED_SPLATS, oldest
 *   dropped first), and the latest knobs, grid, palette and time win, so a
 *   slow device steps less often rather than queueing work. It goes out as
 *   soon as the reply arrives;
 * - a spare pixel buffer goes back with the next request, so steady state
 *   allocates nothing;
 * - a failure (`fail`) clears the busy flag, so the next frame sends again
 *   and the fluid doesn't freeze. The failed step's splats are lost.
 * Readers latch the last finished step at each frame.
 */
export class FluidHost implements FluidBackend {
  readonly stats: FluidHostStats = { sent: 0, received: 0, stale: 0, latched: 0, merged: 0, droppedSplats: 0, failed: 0, waitingFrames: 0, maxWaitingFrames: 0, stepMs: 0, colorMs: 0 };
  /** The `seq` of the step in flight, or null. */
  private inFlight: number | null = null;
  private seq = 0;
  /** Work waiting for the next request; its splats array is the host's own, appended in place. */
  private owed: (FluidWork & { splats: FluidWrite[] }) | null = null;
  /** The `step` call each owed splat came from, beside `owed.splats`. */
  private owedSteps: number[] = [];
  private generation = 0;
  /** `step` calls so far, and how many of them the step in flight, the newest finished one and the latched one include. */
  private steps = 0;
  private inFlightThrough = 0;
  private finishedThrough = 0;
  private through = 0;
  private lost = 0;
  /** The reply readers see this frame, and the newest one not yet latched. */
  private shown: FluidImage | null = null;
  private finished: FluidImage | null = null;
  private spare: Uint8ClampedArray | null = null;

  constructor(private readonly post: FluidPost) {}

  latch(): void {
    if (!this.finished) return;
    if (this.shown) this.spare = this.shown.pixels;
    this.shown = this.finished;
    this.through = this.finishedThrough;
    this.finished = null;
    this.stats.latched++;
  }

  latched(): FluidImage | null {
    return this.shown;
  }

  /**
   * How many `step` calls the latched picture covers, counted from the host's
   * creation (resets included): every call up to it either reached the solver
   * before this picture or was lost (`lostThrough`). A host that knows the
   * frame whose step took some work (a tap's splash: `Runtime.lastFrame`)
   * reads `stepCount` after that frame as the work's step number n; the work
   * is on screen once `latchedThrough >= n`, unless `lostThrough >= n`.
   * Work in a hung worker is neither: `latchedThrough` stops moving.
   */
  get latchedThrough(): number {
    return this.through;
  }

  /**
   * The highest `step` call whose work, or part of it, never reached the
   * solver, or was cleared from it: `fail()` loses the step in flight,
   * `reset()` everything so far, and the MAX_OWED_SPLATS cap the oldest
   * waiting splats. 0 when nothing was lost.
   */
  get lostThrough(): number {
    return this.lost;
  }

  /** `step` calls so far. */
  get stepCount(): number {
    return this.steps;
  }

  /** True while a step is in flight. */
  get pending(): boolean {
    return this.inFlight !== null;
  }

  step(work: FluidWork): void {
    this.steps++;
    const owed = this.owed;
    if (owed) {
      this.stats.merged++;
      owed.dt += work.dt;
      owed.grid = work.grid;
      owed.params = work.params;
      owed.palette = work.palette;
      owed.time = work.time;
      owed.splats.push(...work.splats);
    } else {
      this.owed = { ...work, splats: [...work.splats] };
      this.owedSteps = [];
    }
    for (let i = 0; i < work.splats.length; i++) this.owedSteps.push(this.steps);
    const splats = this.owed!.splats;
    if (splats.length > MAX_OWED_SPLATS) {
      const drop = splats.length - MAX_OWED_SPLATS;
      splats.splice(0, drop);
      this.lost = Math.max(this.lost, this.owedSteps[drop - 1]!);
      this.owedSteps.splice(0, drop);
      this.stats.droppedSplats += drop;
    }
    if (this.inFlight !== null) {
      this.stats.waitingFrames++;
      this.stats.maxWaitingFrames = Math.max(this.stats.maxWaitingFrames, this.stats.waitingFrames);
    }
    this.flush();
  }

  reset(): void {
    this.generation++;
    this.lost = this.steps;
    this.owed = null;
    this.shown = this.finished = null;
  }

  /**
   * A reply from the worker. Only the reply to the step in flight, in the
   * current generation, is kept for readers; any other gives its buffer back.
   * Work that waited while the step ran goes out at once.
   */
  receive(reply: FluidStepReply): void {
    if (reply.seq !== this.inFlight) {
      // Its step was given up (`fail`); the step in flight, if any, is another one.
      this.stats.stale++;
      this.spare = reply.pixels;
      return;
    }
    this.inFlight = null;
    this.stats.waitingFrames = 0;
    this.stats.stepMs = reply.stepMs;
    this.stats.colorMs = reply.colorMs;
    if (reply.generation !== this.generation) {
      this.stats.stale++;
      this.spare = reply.pixels;
    } else {
      this.stats.received++;
      // A reply that arrived after another one in the same frame replaces it; that one's buffer is spare.
      if (this.finished) this.spare = this.finished.pixels;
      this.finished = { width: reply.w, height: reply.h, pixels: reply.pixels };
      this.finishedThrough = this.inFlightThrough;
    }
    // Called from the worker's onmessage: a post that throws there has nobody to catch it.
    this.flush(false);
  }

  /** The worker failed a step (onerror, onmessageerror). Its buffers are gone; the next frame sends again. */
  fail(_reason?: unknown): void {
    if (this.inFlight !== null) this.lost = Math.max(this.lost, this.inFlightThrough);
    this.inFlight = null;
    this.stats.waitingFrames = 0;
    this.spare = null;
    this.stats.failed++;
  }

  /** Sends the owed work if no step is in flight. A post that throws fails the step (it is lost),
   *  and the error is rethrown unless `rethrow` is false. */
  private flush(rethrow = true): void {
    if (this.inFlight !== null || !this.owed) return;
    const work = this.owed;
    const recycle = this.spare;
    this.owed = null;
    this.spare = null;
    const seq = ++this.seq;
    this.inFlight = seq;
    this.inFlightThrough = this.steps;
    this.stats.sent++;
    const request: FluidStepRequest = { ...work, grid: { ...work.grid }, params: { ...work.params }, splats: work.splats, generation: this.generation, seq, recycle };
    try {
      this.post(request, recycle ? [recycle.buffer as ArrayBuffer] : []);
    } catch (error) {
      // A post that throws never reaches the worker; nothing will reply.
      if (this.inFlight === seq) this.fail(error);
      if (rethrow) throw error;
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
