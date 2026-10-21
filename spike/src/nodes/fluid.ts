import { Fluid } from '../flow/fluid.js';
import { fluidGridSize } from '../flow/fluid-viewport.js';
import type { SplatArgs, StepReply, StepRequest } from '../fluid-worker';
import type { NodeType } from '../registry';
import { isMobile, stage } from '../stage';
import { recordFluidStep, stats } from '../stats';

/** What writers see of the fluid. */
export type Sim = { splat(x: number, y: number, color: number[], size?: number, dx?: number, dy?: number): void };
/** What a writer's Field output is: apply everything due before audio time t to the fluid. */
export type FieldWriter = (sim: Sim, t: number) => void;
/** What the Renderer draws: the dye on a w × h grid. */
export type Dye = { w: number; h: number; r: Float32Array; g: Float32Array; b: Float32Array };

const LOG_EVERY = 5000; // ms

/** The solver steps in a Worker unless the page has ?fluid=main, which keeps M0's main-thread solver for an A/B. */
const inWorker = () => new URLSearchParams(location.search).get('fluid') !== 'main';

/**
 * The Fluid's Field output when the solver runs in a Worker: writers queue splats on it, and the Renderer
 * reads the dye from the worker's last reply, one frame behind the main-thread solver.
 */
export class FluidProxy implements Sim {
  dye: Dye | null = null;
  splats: SplatArgs[] = [];
  splat(x: number, y: number, color: number[], size = 0.05, dx = 0, dy = 0) {
    this.splats.push([x, y, color[0], color[1], color[2], size, dx, dy]);
  }
}

/** The dye a Field carries, or null if it isn't a Fluid (a Splat's Write cabled to the Renderer by mistake). */
export const dyeOf = (field: unknown): Dye | null =>
  field instanceof Fluid ? (field as unknown as Dye) : field instanceof FluidProxy ? field.dye : null;

/**
 * Flow's CPU solver. Each frame it sizes its grid to the performance canvas, lets its writers add what's
 * due, then steps. Its Field output is the solver itself, or a FluidProxy when it runs in a Worker, shared by reference.
 */
export const fluid: NodeType = {
  type: 'fluid',
  label: 'Fluid',
  unique: true,
  inputs: [{ name: 'writers', label: 'Writers', type: 'field' }],
  outputs: [{ name: 'field', label: 'Field', type: 'field' }],
  knobs: [
    { name: 'vorticity', label: 'Vorticity', min: 0, max: 2, default: 0.6 },
    // Flow's persistence, upside down: 0.3 is Flow's default of 0.7.
    { name: 'dissipation', label: 'Dissipation', min: 0, max: 1, default: 0.3 },
    // Velocity drag per 1/60 s, from Flow's 0.994 at 0 to 0.934 at 1.
    { name: 'viscosity', label: 'Viscosity', min: 0, max: 1, default: 0 },
  ],
  create() {
    const grid = { w: isMobile() ? 144 : 224, h: isMobile() ? 112 : 156 };
    const params = { swirl: 0.6, persistence: 0.7, drag: 0.994 };
    const worker = inWorker();
    stats.fluidMode = worker ? 'worker' : 'main thread';
    let period = { steps: 0, total: 0, max: 0, since: performance.now() };

    // Step time is measured where the step runs; on the worker path it arrives with the reply.
    const recordStep = (ms: number) => {
      stats.fluidMs = stats.fluidMs ? stats.fluidMs * 0.95 + ms * 0.05 : ms;
      stats.fluidMaxMs = Math.max(stats.fluidMaxMs, ms);
      recordFluidStep(ms);
      stats.fluidGrid = `${grid.w}×${grid.h}`;
      period.steps++;
      period.total += ms;
      period.max = Math.max(period.max, ms);
      const now = performance.now();
      if (now - period.since >= LOG_EVERY) {
        const lag = stats.splatLag;
        const draw = stats.render;
        const render = draw.count ? `; render avg ${(draw.total / draw.count).toFixed(2)} ms, max ${draw.max.toFixed(2)} ms` : '';
        const splats = lag.count ? `; ${lag.count} splats landed avg ${(lag.total / lag.count).toFixed(1)} ms, max ${lag.max.toFixed(1)} ms after their time` : '';
        console.log(`[spike] fluid step (${stats.fluidMode}) avg ${(period.total / period.steps).toFixed(2)} ms, max ${period.max.toFixed(2)} ms over ${period.steps} steps, grid ${stats.fluidGrid} (${grid.w * grid.h} cells${isMobile() ? ', mobile budget' : ''})${render}${splats}, output latency ${stats.outputLatencyMs.toFixed(1)} ms`);
        stats.splatLag = { count: 0, total: 0, max: 0 };
        stats.render = { count: 0, total: 0, max: 0 };
        period = { steps: 0, total: 0, max: 0, since: now };
      }
    };

    const dispose = () => {
      stats.fluidGrid = '';
      stats.fluidMs = 0;
    };
    const set = (knob: string, value: number) => {
      if (knob === 'vorticity') params.swirl = value;
      if (knob === 'dissipation') params.persistence = 1 - value;
      if (knob === 'viscosity') params.drag = 0.994 - value * 0.06;
    };

    if (!worker) {
      const sim = new Fluid(grid.w, grid.h);
      return {
        fields: { field: sim },
        frame(_t0, t1, dt, inputs) {
          resize(grid);
          sim.resize(grid.w, grid.h);
          Object.assign(sim, params);
          for (const write of inputs.fields('writers')) if (typeof write === 'function') (write as FieldWriter)(sim, t1);
          const start = performance.now();
          sim.step(dt);
          recordStep(performance.now() - start);
        },
        set,
        // Runs when Demo replaces the patch; the new Fluid sets these again on its first frame.
        dispose,
      };
    }

    const proxy = new FluidProxy();
    const thread = new Worker(new URL('../fluid-worker.ts', import.meta.url), { type: 'module' });
    // One step in flight at a time. Frames that land while the worker is busy add their dt to the next step,
    // and their splats wait in the proxy, so a slow device steps less often rather than queueing work.
    let busy = false;
    let owed = 0;
    let spare: Float32Array[] | null = null;
    thread.onmessage = (e: MessageEvent<StepReply>) => {
      busy = false;
      if (proxy.dye) spare = [proxy.dye.r, proxy.dye.g, proxy.dye.b];
      proxy.dye = e.data;
      recordStep(e.data.ms);
    };
    thread.onerror = (e) => console.error('[spike] fluid worker', e.message);
    return {
      fields: { field: proxy },
      frame(_t0, t1, dt, inputs) {
        resize(grid);
        for (const write of inputs.fields('writers')) if (typeof write === 'function') (write as FieldWriter)(proxy, t1);
        owed += dt;
        if (busy) return;
        busy = true;
        const request: StepRequest = { dt: owed, grid: { ...grid }, params: { ...params }, splats: proxy.splats, recycle: spare };
        thread.postMessage(request, spare ? { transfer: spare.map((a) => a.buffer) } : {});
        proxy.splats = [];
        spare = null;
        owed = 0;
      },
      set,
      // Runs when Demo replaces the patch; the new Fluid sets these again on its first step.
      dispose() {
        thread.terminate();
        dispose();
      },
    };
  },
};

/**
 * From Flow's resize(): keep cells square to the canvas, within the desktop or mobile budget.
 * Sub-cell aspect changes (mobile browser chrome) are ignored, so the same dye isn't resampled over and over.
 */
function resize(grid: { w: number; h: number }) {
  const rect = stage()?.getBoundingClientRect();
  if (!rect) return;
  const mobile = isMobile();
  const next = fluidGridSize(rect.width, rect.height, { mobile });
  if (!next || (grid.w === next.w && grid.h === next.h)) return;
  const n = grid.w * grid.h;
  const cellAspect = (rect.width * grid.h) / (rect.height * grid.w);
  const overBudget = n > (mobile ? 16128 : 35000);
  if (Math.abs(cellAspect - 1) > 0.0125 || overBudget || n < next.w * next.h * 0.9) Object.assign(grid, next);
}
