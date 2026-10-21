import { createFluidColorizer, renderFluidPixels } from './flow/fluid-renderer.js';
import { Fluid } from './flow/fluid.js';

// Flow's CPU solver and colorizer off the main thread, so neither delays a tap's pointerdown.
// Each message from the Fluid node is one frame's work: grid, knobs, the splats due, then a step.
// The reply is the dye after the step, colored into RGBA pixels, in a buffer transferred rather than copied.

/** x, y, r, g, b, size, dx, dy: one Fluid.splat call. */
export type SplatArgs = [number, number, number, number, number, number, number, number];

export type StepRequest = {
  dt: number;
  grid: { w: number; h: number };
  params: { swirl: number; persistence: number; drag: number };
  splats: SplatArgs[];
  /** The main thread's clock in seconds, for the colorizer's shimmer. */
  time: number;
  /** Last frame's pixel buffer, handed back for reuse. */
  recycle: Uint8ClampedArray | null;
};

export type StepReply = { w: number; h: number; pixels: Uint8ClampedArray; ms: number; colorMs: number };

let sim: Fluid | null = null;
const colorize = createFluidColorizer('classic');

self.onmessage = (e: MessageEvent<StepRequest>) => {
  const { dt, grid, params, splats, time, recycle } = e.data;
  sim ??= new Fluid(grid.w, grid.h);
  sim.resize(grid.w, grid.h);
  Object.assign(sim, params);
  for (const [x, y, r, g, b, size, dx, dy] of splats) sim.splat(x, y, [r, g, b], size, dx, dy);
  const start = performance.now();
  sim.step(dt);
  const ms = performance.now() - start;
  const pixels = recycle?.length === sim.n * 4 ? recycle : new Uint8ClampedArray(sim.n * 4);
  renderFluidPixels(sim, pixels, time, colorize);
  const colorMs = performance.now() - start - ms;
  const reply: StepReply = { w: sim.w, h: sim.h, pixels, ms, colorMs };
  self.postMessage(reply, { transfer: [pixels.buffer] });
};
