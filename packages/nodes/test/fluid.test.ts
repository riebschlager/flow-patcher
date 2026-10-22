import { describe, expect, it } from 'vitest';
import {
  canonicalDyes,
  createFluidColorizer,
  createInProcessFluid,
  Fluid,
  isFluidField,
  renderFluidPixels,
  resolveParams,
  type FluidBackend,
  type FluidTarget,
  type FluidWork,
  type FluidWriter,
  type NodeState,
} from '@flow-patcher/engine';
import { FLUID_GRID, fluid } from '../src/fluid';
import { context, frame } from './helpers';

const params = resolveParams(fluid, {});
const DT = 1 / 60;

/** A writer that splats the given calls once. */
const writer = (calls: Parameters<FluidTarget['splat']>[]): FluidWriter => ({
  write(target) {
    for (const call of calls.splice(0)) target.splat(...call);
  },
});

/** A backend that records the work it's handed and steps nothing. */
function spy(): FluidBackend & { work: FluidWork[]; resets: number; latches: number } {
  return {
    work: [], resets: 0, latches: 0,
    latch() { this.latches++; },
    latched: () => null,
    step(work) { this.work.push(work); },
    reset() { this.resets++; },
  };
}

const brightness = (image: { width: number; height: number; pixels: Uint8ClampedArray }, x: number, y: number) => {
  const i = (Math.round(x * image.width) + Math.round(y * image.height) * image.width) * 4;
  return image.pixels[i]! + image.pixels[i + 1]! + image.pixels[i + 2]!;
};

describe('fluid node', () => {
  it('takes splats only through Writers (v3: the interim Splat input and its Size knob went to the Splat node)', () => {
    expect(fluid.version).toBe(3);
    expect(fluid.ports.map((p) => `${p.direction} ${p.name}`)).toEqual(['in writers', 'out field']);
    expect(fluid.params.map((p) => p.name)).toEqual(['vorticity', 'dissipation', 'viscosity', 'palette']);
  });

  it('has no image before its first finished step', () => {
    expect(fluid.image!({}, params)).toBeNull();
    const state = {};
    frame(fluid, 0, DT, { state });
    // One step has run, but readers see it only from the next frame's latch.
    expect(fluid.image!(state, params)).toBeNull();
  });

  it('applies its writers\' splats at their positions and renders a grid-sized image a frame later', () => {
    const state = {};
    const a = writer([[0.25, 0.5, canonicalDyes[0]!]]);
    frame(fluid, 0, DT, { nodeId: 'f', state, fields: { writers: [() => a] } });
    frame(fluid, DT, 2 * DT, { nodeId: 'f', state });
    const image = fluid.image!(state, params)!;
    expect([image.width, image.height]).toEqual([FLUID_GRID.w, FLUID_GRID.h]);
    expect(brightness(image, 0.25, 0.5)).toBeGreaterThan(brightness(image, 0.75, 0.5) + 100);
  });

  it('takes splats from every writer on its Writers input, once each', () => {
    const state = {};
    const a = writer([[0.2, 0.3, canonicalDyes[0]!, 0.06]]), b = writer([[0.8, 0.7, canonicalDyes[2]!, 0.06, 0, 19]]);
    const backend = spy();
    const fields = { writers: [() => a, () => 'not a writer', () => b] };
    frame(fluid, 0, DT, { state, fields, services: { fluid: backend } });
    frame(fluid, DT, 2 * DT, { state, fields, services: { fluid: backend } });
    expect(backend.work.map((w) => w.splats.length)).toEqual([2, 0]);
    expect(backend.work[0]!.splats[1]).toEqual([0.8, 0.7, ...canonicalDyes[2]!, 0.06, 0, 19]);
  });

  it('maps its knobs onto the solver and sends the palette, grid, dt and frame time', () => {
    const backend = spy();
    frame(fluid, 1, 1 + DT, { dt: DT, params: { vorticity: 0.4, dissipation: 0.25, viscosity: 0.5, palette: 'ember' }, services: { fluid: backend } });
    const [work] = backend.work;
    expect(work!.params).toEqual({ swirl: 0.4, persistence: 0.75, drag: 0.994 - 0.03 });
    expect(work).toMatchObject({ palette: 'ember', grid: FLUID_GRID, dt: DT, time: 1 + DT });
  });

  it('latches, then steps, every frame; resets the backend once, when it starts', () => {
    const backend = spy();
    const state = {};
    for (let i = 0; i < 3; i++) frame(fluid, i * DT, (i + 1) * DT, { state, services: { fluid: backend } });
    expect([backend.resets, backend.latches, backend.work.length]).toEqual([1, 3, 3]);
    // Fresh state (the node added again, or its state reset by an edit) starts from still water.
    frame(fluid, 3 * DT, 4 * DT, { state: {}, services: { fluid: backend } });
    expect(backend.resets).toBe(2);
  });

  it('gives its Field readers the latched step', () => {
    const state = {};
    const field = fluid.field!(context(fluid, { state }), 'field');
    expect(isFluidField(field)).toBe(true);
    if (!isFluidField(field)) return;
    expect(field.image()).toBeNull();
    const a = writer([[0.5, 0.5, canonicalDyes[1]!]]);
    frame(fluid, 0, DT, { state, fields: { writers: [() => a] } });
    frame(fluid, DT, 2 * DT, { state });
    expect(field.image()!.pixels).toEqual(fluid.image!(state, params)!.pixels);
    // The same object every time, so readers can hold on to it.
    expect(fluid.field!(context(fluid, { state }), 'field')).toBe(field);
  });

  it('steps exactly as the solver and colorizer called directly', () => {
    const state: NodeState = {};
    const a = writer([[0.3, 0.4, canonicalDyes[0]!], [0.6, 0.5, canonicalDyes[1]!, 0.05, 0, 19]]);
    frame(fluid, 0, DT, { state, fields: { writers: [() => a] }, params: { palette: 'aurora' } });
    frame(fluid, DT, 2 * DT, { state, params: { palette: 'aurora' } });
    const sim = new Fluid(FLUID_GRID.w, FLUID_GRID.h);
    sim.splat(0.3, 0.4, canonicalDyes[0]!, 0.05);
    sim.splat(0.6, 0.5, canonicalDyes[1]!, 0.05, 0, 19);
    sim.step(DT);
    const pixels = renderFluidPixels(sim, new Uint8ClampedArray(sim.n * 4), DT, createFluidColorizer('aurora'));
    expect(fluid.image!(state, params)!.pixels).toEqual(pixels);
  });

  it('survives hostile writers', () => {
    const state = {};
    const bad = writer([[NaN, Infinity, [NaN, -1, 1e9], -5, NaN, Infinity], [0.5, 0.5, [] as unknown as [number, number, number]]]);
    frame(fluid, 0, 1, { state, fields: { writers: [() => bad] } });
    frame(fluid, 1, 2, { state });
    expect(fluid.image!(state, params)!.pixels.every(Number.isFinite)).toBe(true);
  });

  it('uses the host fluid backend when there is one', () => {
    const backend = createInProcessFluid();
    const state = {};
    const a = writer([[0.5, 0.5, canonicalDyes[0]!]]);
    frame(fluid, 0, DT, { state, services: { fluid: backend }, fields: { writers: [() => a] } });
    frame(fluid, DT, 2 * DT, { state, services: { fluid: backend } });
    expect(backend.latched()).not.toBeNull();
    expect(backend.stats.sent).toBe(2);
  });
});
