import { describe, expect, it } from 'vitest';
import { resolveParams } from '@flow-patcher/engine';
import { FLUID_GRID, fluid } from '../src/fluid';

const params = resolveParams(fluid, {});

describe('fluid node', () => {
  it('has no image before its first frame', () => {
    expect(fluid.image!({}, params)).toBeNull();
  });

  it('splats at event positions and renders a grid-sized image', () => {
    const state = {};
    fluid.frame!({ nodeId: 'f', seed: 1, params, state, inputs: { splat: [{ time: 0, channel: 0, x: 0.25, y: 0.5 }] }, t0: 0, t1: 1 / 60, dt: 1 / 60 });
    const image = fluid.image!(state, params)!;
    expect([image.width, image.height]).toEqual([FLUID_GRID.w, FLUID_GRID.h]);
    const brightness = (x: number, y: number) => {
      const i = (Math.round(x * image.width) + Math.round(y * image.height) * image.width) * 4;
      return image.pixels[i]! + image.pixels[i + 1]! + image.pixels[i + 2]!;
    };
    expect(brightness(0.25, 0.5)).toBeGreaterThan(brightness(0.75, 0.5) + 100);
  });

  it('places events without a position deterministically', () => {
    const render = () => {
      const state = {};
      fluid.frame!({ nodeId: 'f', seed: 7, params, state, inputs: { splat: [{ time: 0.5, channel: 0 }] }, t0: 0, t1: 1 / 60, dt: 1 / 60 });
      return fluid.image!(state, params)!.pixels;
    };
    expect(render()).toEqual(render());
  });

  it('survives hostile event fields', () => {
    const state = {};
    fluid.frame!({ nodeId: 'f', seed: 1, params, state, inputs: { splat: [{ time: 0, channel: -3, x: NaN, y: 1e9, index: 2.5 }] }, t0: 0, t1: 1, dt: 1 });
    expect(fluid.image!(state, params)!.pixels.every(Number.isFinite)).toBe(true);
  });
});
