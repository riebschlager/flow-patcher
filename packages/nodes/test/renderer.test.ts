import { describe, expect, it } from 'vitest';
import { compilePatch, createInProcessFluid, Runtime, type FluidField, type FluidHost, type NodeState, type Patch } from '@flow-patcher/engine';
import { nodeRegistry, renderer, rendererImage } from '../src';
import { frame } from './helpers';

const DT = 1 / 60;
const params = {};

/** A Field object whose image() gives `image`. */
const fieldOf = (image: unknown): FluidField => ({ kind: 'fluid', image: () => image as ReturnType<FluidField['image']> });
const pixels = (w: number, h: number, fill: number) => new Uint8ClampedArray(w * h * 4).fill(fill);

/** Runs one Renderer frame over the given Field cables and returns its image. */
function show(fields: unknown[], state: NodeState = {}) {
  frame(renderer, 0, DT, { state, fields: { field: fields.map((f) => () => f) } });
  return renderer.image!(state, params);
}

const node = (id: string, type: string, x = 0) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params: {}, position: { x, y: 0 } });
const cable = (from: string, fromPort: string, to: string, toPort: string) => ({ from: { node: from, port: fromPort }, to: { node: to, port: toPort } });

/** Pointer.down → Splat → Fluid → Renderer, stepped in process. */
function runtime(fluid: FluidHost): Runtime {
  const patch: Patch = {
    format: 'flowpatch', version: 1, seed: 5,
    nodes: [node('p', 'pointer'), node('s', 'splat'), node('f', 'fluid'), node('r', 'renderer')],
    cables: [cable('p', 'down', 's', 'at'), cable('s', 'write', 'f', 'writers'), cable('f', 'field', 'r', 'field')],
  };
  const compiled = compilePatch(patch, nodeRegistry);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return new Runtime(compiled.plan, { services: { fluid } });
}

describe('renderer', () => {
  it('has one Fluid Field input, no outputs, no params and no query', () => {
    expect(renderer.ports).toEqual([{ name: 'field', type: 'field', direction: 'in', label: 'Field', fieldKind: 'fluid' }]);
    expect(renderer.params).toEqual([]);
    expect(renderer.query).toBeUndefined();
    expect(renderer.frame).toBeTypeOf('function');
    expect(renderer.category).toBe('visual');
  });

  it('shows nothing with no field cabled, before any frame, or before the first finished step', () => {
    expect(renderer.image!({}, params)).toBeNull();
    expect(show([])).toBeNull();
    expect(rendererImage({})).toBeNull();
    expect(show([fieldOf(null)])).toBeNull();
  });

  it('shows Fluid’s latched pixels, bit for bit, in a running patch', () => {
    const fluid = createInProcessFluid();
    const rt = runtime(fluid);
    rt.push('p', 'down', { time: 0, channel: 0, x: 0.3, y: 0.6 });
    rt.push('p', 'down', { time: 0, channel: 1, x: 0.7, y: 0.4 });
    rt.query(0, 0.2);
    // Frame 1 takes the splats and steps; readers see that step from frame 2's latch.
    rt.frame(0, DT, DT);
    expect(rt.images().find((i) => i.node === 'r')).toBeUndefined();
    for (let i = 1; i < 6; i++) rt.frame(i * DT, (i + 1) * DT, DT);
    const latched = fluid.latched()!;
    const image = rt.images().find((i) => i.node === 'r')!.image;
    expect([image.width, image.height]).toEqual([latched.width, latched.height]);
    expect(image.pixels).toEqual(latched.pixels);
    // Both channels' splats are in the picture: brighter than the background around them.
    const at = (x: number, y: number) => {
      const k = (Math.round(x * image.width) + Math.round(y * image.height) * image.width) * 4;
      return image.pixels[k]! + image.pixels[k + 1]! + image.pixels[k + 2]!;
    };
    expect(at(0.3, 0.6)).toBeGreaterThan(at(0.05, 0.05) + 100);
    expect(at(0.7, 0.4)).toBeGreaterThan(at(0.05, 0.05) + 100);
    // Only the Renderer exposes an image.
    expect(rt.images().map((i) => i.node)).toEqual(['r']);
  });

  it('hands over the backend’s buffer without copying, and image() copies it', () => {
    const shared = { width: 2, height: 1, pixels: pixels(2, 1, 9) };
    const state: NodeState = {};
    const image = show([fieldOf(shared)], state)!;
    expect(rendererImage(state)).toBe(shared);
    expect(image.pixels).not.toBe(shared.pixels);
    expect(image.pixels).toEqual(shared.pixels);
  });

  it('gives a copy that stays the same after the next frame’s latch recycles the buffer', () => {
    const fluid = createInProcessFluid();
    const rt = runtime(fluid);
    rt.push('p', 'down', { time: 0, channel: 0, x: 0.5, y: 0.5 });
    // A second splat lands in a later frame, so later steps differ from the kept one.
    rt.push('p', 'down', { time: 0.08, channel: 1, x: 0.2, y: 0.2 });
    rt.query(0, 0.4);
    for (let i = 0; i < 3; i++) rt.frame(i * DT, (i + 1) * DT, DT);
    const kept = rt.images()[0]!.image;
    const before = kept.pixels.slice();
    const buffer = fluid.latched()!.pixels;
    // The next frames latch newer steps; the old buffer goes back to the stepper and is drawn over.
    for (let i = 3; i < 8; i++) rt.frame(i * DT, (i + 1) * DT, DT);
    expect(fluid.latched()!.pixels).not.toEqual(before);
    expect(buffer).not.toEqual(before);
    expect(kept.pixels).toEqual(before);
  });

  it('draws the first Fluid among its cables and ignores anything that isn’t one', () => {
    const fluidImage = { width: 1, height: 1, pixels: pixels(1, 1, 200) };
    const writer = { write() {} };
    expect(show([writer, 'nope', null, 42, { kind: 'fluid' }, fieldOf(fluidImage)])!.pixels).toEqual(fluidImage.pixels);
    expect(show([writer, { kind: 'water', image: () => fluidImage }])).toBeNull();
  });

  it('shows nothing for a Field whose image is null or malformed', () => {
    for (const bad of [
      null,
      undefined,
      {},
      { width: NaN, height: 1, pixels: pixels(1, 1, 1) },
      { width: 0, height: 0, pixels: new Uint8ClampedArray(0) },
      { width: -1, height: 1, pixels: pixels(1, 1, 1) },
      { width: 1.5, height: 1, pixels: pixels(1, 1, 1) },
      { width: 2, height: 2, pixels: pixels(1, 1, 1) },
      { width: 1, height: 1, pixels: [1, 2, 3, 4] },
    ]) expect(show([fieldOf(bad)]), JSON.stringify(bad)).toBeNull();
  });

  it('forgets the last picture when the Field stops giving one', () => {
    const state: NodeState = {};
    expect(show([fieldOf({ width: 1, height: 1, pixels: pixels(1, 1, 50) })], state)).not.toBeNull();
    expect(show([fieldOf(null)], state)).toBeNull();
    expect(show([], state)).toBeNull();
  });
});
