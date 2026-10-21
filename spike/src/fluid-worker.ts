import { Fluid } from './flow/fluid.js';

// Flow's CPU solver off the main thread, so a step never delays a tap's pointerdown.
// Each message from the Fluid node is one frame's work: grid, knobs, the splats due, then a step.
// The reply is the dye after the step, in buffers transferred rather than copied.

/** x, y, r, g, b, size, dx, dy: one Fluid.splat call. */
export type SplatArgs = [number, number, number, number, number, number, number, number];

export type StepRequest = {
  dt: number;
  grid: { w: number; h: number };
  params: { swirl: number; persistence: number; drag: number };
  splats: SplatArgs[];
  /** Last frame's dye buffers, handed back for reuse. */
  recycle: Float32Array[] | null;
};

export type StepReply = { w: number; h: number; r: Float32Array; g: Float32Array; b: Float32Array; ms: number };

let sim: Fluid | null = null;

self.onmessage = (e: MessageEvent<StepRequest>) => {
  const { dt, grid, params, splats, recycle } = e.data;
  sim ??= new Fluid(grid.w, grid.h);
  sim.resize(grid.w, grid.h);
  Object.assign(sim, params);
  for (const [x, y, r, g, b, size, dx, dy] of splats) sim.splat(x, y, [r, g, b], size, dx, dy);
  const start = performance.now();
  sim.step(dt);
  const ms = performance.now() - start;
  const s = sim;
  const dye = sim as unknown as Record<'r' | 'g' | 'b', Float32Array>; // Fluid creates its arrays in a loop, so TS can't see them
  const [r, g, b] = (['r', 'g', 'b'] as const).map((k, i) => {
    const buf = recycle?.[i]?.length === s.n ? recycle[i] : new Float32Array(s.n);
    buf.set(dye[k]);
    return buf;
  });
  const reply: StepReply = { w: s.w, h: s.h, r, g, b, ms };
  self.postMessage(reply, { transfer: [r.buffer, g.buffer, b.buffer] });
};
