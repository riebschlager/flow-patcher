// Borrowed from Flow's fluid-renderer check, plus byte-exact golden renders.
import { describe, expect, it } from 'vitest';
import { Fluid, FLUID_BACKGROUND, canonicalDyes, colorPalettes, createFluidColorizer, hexRGB, renderFluidPixels, type RGB } from '../src';
import { expectGolden, sha256 } from '../../../test-support/golden';

const saturation = (rgb: number[]) => 1 - Math.min(...rgb) / Math.max(...rgb);

function turbulentSim(): Fluid {
  const sim = new Fluid(64, 48);
  for (let i = 0; i < 36; i++) sim.splat(0.2 + (i % 6) * 0.12, 0.2 + Math.floor(i / 6) * 0.12, canonicalDyes[i % 4]!, 0.07, 3, -2);
  for (let i = 0; i < 20; i++) sim.step(1 / 30);
  return sim;
}

describe('fluid renderer', () => {
  it('matches golden palette renders byte for byte', () => {
    const sim = turbulentSim(), hashes: Record<string, string[]> = {};
    for (const id of Object.keys(colorPalettes)) {
      hashes[id] = [0, 12.345].map((time) => sha256(renderFluidPixels(sim, new Uint8ClampedArray(sim.n * 4), time, createFluidColorizer(id), { luminance: 1.25 })));
    }
    expectGolden('palette-renders', hashes);
  });

  for (const [id, palette] of Object.entries(colorPalettes)) {
    it(`${id}: keeps swatch colors and stays inside palette bounds`, () => {
      const colorize = createFluidColorizer(id), out = [0, 0, 0];
      const swatches = palette.colors.map((c) => hexRGB(c.hex).map((v) => v * 255) as RGB);
      colorize(0, 0, 0, 1, 0, out);
      expect(out).toEqual(FLUID_BACKGROUND);
      swatches.forEach((swatch, i) => {
        colorize(...(canonicalDyes[i]!.map((v) => v * 100) as RGB), 1, 0, out);
        out.forEach((v, j) => expect(Math.abs(v - swatch[j])).toBeLessThan(1e-5));
        expect(Math.abs(saturation(out) - saturation(swatch))).toBeLessThan(1e-5);
      });
      const maxSaturation = Math.max(...swatches.map(saturation));
      const samples = [...canonicalDyes, [1, 1, 1], [0.8, 1, 0.9], [2, 1, 3]] as RGB[];
      for (const dye of samples) for (const density of [0.001, 0.1, 1, 50, 10000]) for (const lighting of [0.3, 1, 1.6]) for (const gradient of [-1e4, 0, 1e4]) {
        colorize(...(dye.map((v) => v * density) as RGB), lighting, gradient, out);
        out.forEach((v, j) => expect(Number.isFinite(v) && v >= 0 && v <= Math.max(...swatches.map((c) => c[j])) + 1e-5).toBe(true));
        if (density >= 50) expect(saturation(out)).toBeLessThanOrEqual(maxSaturation + 1e-5);
      }
    });
  }

  it('never mutates the simulation', () => {
    const sim = turbulentSim();
    const before = (['r', 'g', 'b', 'u', 'v'] as const).map((k) => sim[k].slice());
    renderFluidPixels(sim, new Uint8ClampedArray(sim.n * 4), 3, createFluidColorizer('ember'));
    (['r', 'g', 'b', 'u', 'v'] as const).forEach((k, i) => expect(sim[k]).toEqual(before[i]));
  });
});
