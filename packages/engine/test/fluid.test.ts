// Borrowed from Flow's performance-equivalence and fluid-renderer checks, now
// compared against golden files generated in this repo.
import { describe, expect, it } from 'vitest';
import { Fluid, canonicalDyes, fluidGridSize, type FluidFieldName } from '../src';
import { expectGolden, sha256 } from '../../../test-support/golden';

const FIELDS: FluidFieldName[] = ['u', 'v', 'r', 'g', 'b', 'p', 'div', 'curl'];
const SIZES = [[8, 8], [61, 43], [111, 145], [241, 144]] as const;

/** Turbulent gestures, resize and clear, with varied dt. */
function runScenario(w: number, h: number, onFrame: (sim: Fluid, frame: number) => void): Fluid {
  const sim = new Fluid(w, h);
  for (let frame = 0; frame < 44; frame++) {
    sim.swirl = (frame % 9) / 8;
    sim.persistence = (frame % 7) / 6;
    if (frame % 3 === 0) sim.splat(0.14 + (frame % 7) * 0.1, 0.18 + (frame % 5) * 0.13, canonicalDyes[frame % 4]!, 0.06, Math.sin(frame) * 45, Math.cos(frame) * 32);
    if (frame % 4 === 0) sim.pulse(0.3, 0.7, 0.8, 0.2, frame % 8 ? -1 : 1);
    if (frame % 5 === 0) sim.force(0.75, 0.3, 100, -60, 0.12);
    if (frame === 22) sim.resize(h, w);
    if (frame === 33) sim.clear();
    sim.step([0, 1 / 120, 1 / 60, 0.033, 0.05][frame % 5]);
    onFrame(sim, frame);
  }
  return sim;
}

describe('Fluid (CPU reference)', () => {
  it('matches golden frames bit for bit', () => {
    const hashes: Record<string, string[]> = {};
    for (const [w, h] of SIZES) {
      const frames: string[] = (hashes[`${w}x${h}`] = []);
      runScenario(w, h, (sim) => frames.push(sha256(FIELDS.map((key) => sha256(sim[key])).join(''))));
    }
    expectGolden('fluid-frames', hashes);
  });

  it('is deterministic run to run', () => {
    const a = runScenario(61, 43, () => {});
    const b = runScenario(61, 43, () => {});
    for (const key of FIELDS) expect(a[key]).toEqual(b[key]);
  });

  it('keeps a locked hue at the shared dye cap', () => {
    for (const dye of canonicalDyes) {
      const sim = new Fluid(32, 24), i = 16 + 12 * sim.w;
      for (let n = 0; n < 80; n++) sim.splat(0.5, 0.5, dye, 0.06);
      const cell = [sim.r[i]!, sim.g[i]!, sim.b[i]!];
      const peak = Math.max(...cell);
      expect(peak).toBeLessThanOrEqual(5);
      cell.forEach((v, j) => expect(Math.abs(v / peak - dye[j]! / Math.max(...dye))).toBeLessThan(1e-6));
    }
  });

  it('rejects invalid grid sizes and keeps state on a no-op resize', () => {
    const sim = new Fluid(16, 16);
    sim.splat(0.5, 0.5, canonicalDyes[0]!);
    const before = sim.r.slice();
    expect(sim.resize(16, 16)).toBe(false);
    expect(sim.r).toEqual(before);
    expect(() => sim.resize(4, 4)).toThrow();
    expect(() => sim.resize(400, 400)).toThrow();
  });

  it('stays finite under hostile input', () => {
    const sim = new Fluid(24, 24);
    sim.splat(0.5, 0.5, canonicalDyes[1]!, 0.2, 1e6, -1e6);
    sim.force(0.5, 0.5, 1e9, 1e9, 0.5);
    for (let i = 0; i < 30; i++) sim.step(1);
    for (const key of FIELDS) expect(sim[key].every(Number.isFinite), key).toBe(true);
  });

  it('sizes the grid to the cell budget', () => {
    const desktop = fluidGridSize(1920, 1080)!;
    expect(desktop.w * desktop.h).toBeLessThanOrEqual(35000);
    const mobile = fluidGridSize(390, 844, { mobile: true })!;
    expect(mobile.w * mobile.h).toBeLessThanOrEqual(16128);
    expect(fluidGridSize(0, 100)).toBeNull();
    expect(fluidGridSize(NaN, 100)).toBeNull();
  });
});
