// Borrowed from Flow's palettes check.
import { describe, expect, it } from 'vitest';
import { canonicalDyes, colorPalettes, createDyeMapper, hexRGB, normalizePalette } from '../src';

describe('palettes', () => {
  it('has eight four-color palettes on the canonical dye basis', () => {
    expect(Object.keys(colorPalettes)).toHaveLength(8);
    for (const palette of Object.values(colorPalettes)) {
      expect(palette.colors).toHaveLength(4);
      expect(new Set(palette.colors.map((c) => c.hex)).size).toBe(4);
      palette.colors.forEach((c, i) => {
        expect(c.hex).toMatch(/^#[a-f0-9]{6}$/);
        expect(c.rgb).toEqual(canonicalDyes[i]);
      });
    }
  });

  it('normalizes unknown ids to classic', () => {
    for (const id of ['unknown', '__proto__', {}, null, 3]) expect(normalizePalette(id)).toBe('classic');
  });

  for (const palette of Object.values(colorPalettes)) {
    it(`${palette.id}: maps anchors exactly, blends continuously and stays bounded`, () => {
      const mapper = createDyeMapper(palette.id), out = [0, 0, 0];
      for (let i = 0; i < 4; i++) {
        const dye = canonicalDyes[i]!;
        mapper(dye[0], dye[1], dye[2], out);
        const expected = palette.id === 'classic' ? dye : hexRGB(palette.colors[i]!.hex).map((v) => v ** 2.2);
        out.forEach((v, j) => expect(Math.abs(v - expected[j]!)).toBeLessThan(1e-6));
      }
      // Both triangle transforms agree on their shared violet-to-amber edge.
      for (let t = 0; t <= 1; t += 0.05) {
        const dye = canonicalDyes[0]!.map((v, j) => v * (1 - t) + canonicalDyes[3]![j]! * t);
        const a = mapper(...(dye.map((v, j) => v + canonicalDyes[1]![j]! * 1e-6) as [number, number, number]), []);
        const b = mapper(...(dye.map((v, j) => v + canonicalDyes[2]![j]! * 1e-6) as [number, number, number]), []);
        a.forEach((v, j) => expect(Math.abs(v - b[j]!)).toBeLessThan(1e-5));
      }
      for (let i = 0; i < 500; i++) {
        const dye = [0, 1, 2].map((j) => Math.abs(Math.sin(i * 1.618 + j)) * 12) as [number, number, number];
        mapper(...dye, out);
        expect(out.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
        if (palette.id === 'classic') expect(out).toEqual(dye);
      }
    });
  }
});
