import { Fluid } from '../flow/fluid.js';
import { fluidGridSize } from '../flow/fluid-viewport.js';
import type { NodeType } from '../registry';
import { isMobile, stage } from '../stage';
import { stats } from '../stats';

export type Sim = InstanceType<typeof Fluid>;
/** What a writer's Field output is: apply everything due before audio time t to the fluid. */
export type FieldWriter = (sim: Sim, t: number) => void;

const LOG_EVERY = 5000; // ms

/**
 * Flow's CPU solver. Each frame it sizes its grid to the performance canvas, lets its writers add what's
 * due, then steps. Its Field output is the solver itself, shared by reference.
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
    const sim = new Fluid(isMobile() ? 144 : 224, isMobile() ? 112 : 156);
    let period = { steps: 0, total: 0, max: 0, since: performance.now() };
    return {
      fields: { field: sim },
      frame(_t0, t1, dt, inputs) {
        resize(sim);
        for (const write of inputs.fields('writers')) if (typeof write === 'function') (write as FieldWriter)(sim, t1);
        const start = performance.now();
        sim.step(dt);
        const ms = performance.now() - start;
        stats.fluidMs = stats.fluidMs ? stats.fluidMs * 0.95 + ms * 0.05 : ms;
        stats.fluidMaxMs = Math.max(stats.fluidMaxMs, ms);
        stats.fluidGrid = `${sim.w}×${sim.h}`;
        period.steps++;
        period.total += ms;
        period.max = Math.max(period.max, ms);
        if (start - period.since >= LOG_EVERY) {
          const lag = stats.splatLag;
          const draw = stats.render;
          const render = draw.count ? `; render avg ${(draw.total / draw.count).toFixed(2)} ms, max ${draw.max.toFixed(2)} ms` : '';
          const splats = lag.count ? `; ${lag.count} splats landed avg ${(lag.total / lag.count).toFixed(1)} ms, max ${lag.max.toFixed(1)} ms after their time` : '';
          console.log(`[spike] fluid step avg ${(period.total / period.steps).toFixed(2)} ms, max ${period.max.toFixed(2)} ms over ${period.steps} frames, grid ${stats.fluidGrid} (${sim.n} cells${isMobile() ? ', mobile budget' : ''})${render}${splats}, output latency ${stats.outputLatencyMs.toFixed(1)} ms`);
          stats.splatLag = { count: 0, total: 0, max: 0 };
          stats.render = { count: 0, total: 0, max: 0 };
          period = { steps: 0, total: 0, max: 0, since: start };
        }
      },
      set(knob, value) {
        if (knob === 'vorticity') sim.swirl = value;
        if (knob === 'dissipation') sim.persistence = 1 - value;
        if (knob === 'viscosity') sim.drag = 0.994 - value * 0.06;
      },
      // Unreachable while unique nodes can't be deleted.
      dispose() {
        stats.fluidGrid = '';
        stats.fluidMs = 0;
      },
    };
  },
};

/**
 * From Flow's resize(): keep cells square to the canvas, within the desktop or mobile budget.
 * Sub-cell aspect changes (mobile browser chrome) are ignored, so the same dye isn't resampled over and over.
 */
function resize(sim: Sim) {
  const rect = stage()?.getBoundingClientRect();
  if (!rect) return;
  const mobile = isMobile();
  const grid = fluidGridSize(rect.width, rect.height, { mobile });
  if (!grid || (sim.w === grid.w && sim.h === grid.h)) return;
  const cellAspect = (rect.width * sim.h) / (rect.height * sim.w);
  const overBudget = sim.n > (mobile ? 16128 : 35000);
  if (Math.abs(cellAspect - 1) > 0.0125 || overBudget || sim.n < grid.w * grid.h * 0.9) sim.resize(grid.w, grid.h);
}
