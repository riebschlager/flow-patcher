// Overlay drawing (ADR 0030): the pure-TS rasterizer overlays draw with, and
// the upscale the Renderer composes them over. Byte-exact golden renders.
import { describe, expect, it } from 'vitest';
import { fillOpaque, isOverlayDrawer, overlayScale, strokeEllipse, upscaleInto, type EllipseStroke, type OverlayTarget } from '../src';
import { expectGolden, sha256 } from '../../../test-support/golden';

const W = 160, H = 90;
function blank(width = W, height = H): OverlayTarget {
  const pixels = new Uint8ClampedArray(width * height * 4);
  fillOpaque(pixels, [7, 10, 17]);
  return { width, height, pixels };
}
const ring = (over: Partial<EllipseStroke> = {}): EllipseStroke => ({ cx: 80, cy: 45, rx: 30, ry: 14.4, rotation: 0, lineWidth: 1.4, color: [0.72, 0.63, 1], alpha: 0.5, ...over });
const at = (t: OverlayTarget, x: number, y: number) => [...t.pixels.slice((y * t.width + x) * 4, (y * t.width + x) * 4 + 4)];

describe('overlay drawing', () => {
  it('matches golden renders byte for byte', () => {
    const renders: Record<string, string> = {};
    const cases: Record<string, EllipseStroke[]> = {
      level: [ring()],
      tilted: [ring({ rotation: 0.6 })],
      'three rings': [0, 1, 2].map((i) => ring({ rx: 30 + i * 6, ry: (30 + i * 6) * 0.48, rotation: -0.3, alpha: 0.3 })),
      'thick, opaque, clipped': [ring({ cx: 5, cy: 80, rx: 40, ry: 25, lineWidth: 4, alpha: 1, color: [1, 0.19, 0.26] })],
    };
    for (const [name, strokes] of Object.entries(cases)) {
      const target = blank();
      for (const stroke of strokes) strokeEllipse(target, stroke);
      renders[name] = sha256(target.pixels);
    }
    const small = { width: 3, height: 2, pixels: new Uint8ClampedArray([0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 9, 9, 9, 255]) };
    const big = { width: 12, height: 8, pixels: new Uint8ClampedArray(12 * 8 * 4) };
    upscaleInto(small, 4, big);
    renders.upscale = sha256(big.pixels);
    expectGolden('overlay-renders', renders);
  });

  it('strokes the outline and leaves the inside and outside alone', () => {
    const target = blank();
    strokeEllipse(target, ring({ alpha: 1, lineWidth: 2 }));
    const background = [7, 10, 17, 255];
    expect(at(target, 80, 45)).toEqual(background);
    expect(at(target, 5, 5)).toEqual(background);
    // On the outline at the ends of both axes: lilac, fully covered.
    for (const [x, y] of [[110, 45], [49, 45], [80, 30], [80, 59]] as const) {
      const [r, g, b, a] = at(target, x, y);
      expect(a).toBe(255);
      expect(b! > 200 && r! > 120 && g! > 100, `${x},${y}: ${[r, g, b]}`).toBe(true);
    }
    // Alpha stays 255 everywhere: the target is opaque.
    for (let k = 3; k < target.pixels.length; k += 4) if (target.pixels[k] !== 255) throw new Error(`alpha at ${k}`);
  });

  it('blends by alpha: half alpha lands halfway between background and color', () => {
    const target = blank();
    strokeEllipse(target, ring({ alpha: 0.5, lineWidth: 3 }));
    const [r] = at(target, 110, 45);
    expect(Math.abs(r! - (7 + (0.72 * 255 - 7) * 0.5))).toBeLessThan(1);
  });

  it('rotates clockwise on screen, as Canvas2D does', () => {
    const level = blank(), turned = blank();
    strokeEllipse(level, ring({ alpha: 1, lineWidth: 2 }));
    strokeEllipse(turned, ring({ alpha: 1, lineWidth: 2, rotation: Math.PI / 2 }));
    // A quarter turn puts the long axis upright: the outline reaches 30 px below the center.
    expect(at(level, 80, 75)).toEqual([7, 10, 17, 255]);
    expect(at(turned, 80, 74)[2]).toBeGreaterThan(200);
    expect(at(turned, 110, 45)).toEqual([7, 10, 17, 255]);
  });

  it('draws nothing for empty or non-finite strokes', () => {
    const before = blank().pixels;
    for (const bad of [
      { rx: 0 }, { ry: -3 }, { lineWidth: 0 }, { alpha: 0 }, { alpha: -1 }, { cx: NaN }, { rotation: Infinity }, { color: [NaN, 0, 0] as [number, number, number] }, { cx: -500 }, { cy: 1e6 },
    ]) {
      const target = blank();
      strokeEllipse(target, ring(bad));
      expect(target.pixels, JSON.stringify(bad)).toEqual(before);
    }
  });

  it('clamps alpha and color to 0–1', () => {
    const over = blank(), full = blank();
    strokeEllipse(over, ring({ alpha: 7, color: [3, -1, 1] }));
    strokeEllipse(full, ring({ alpha: 1, color: [1, 0, 1] }));
    expect(over.pixels).toEqual(full.pixels);
  });

  it('upscales by pixel centers with clamped edges, and is the identity at scale 1', () => {
    const src = { width: 2, height: 1, pixels: new Uint8ClampedArray([0, 0, 0, 255, 200, 100, 40, 255]) };
    const same = { width: 2, height: 1, pixels: new Uint8ClampedArray(8) };
    upscaleInto(src, 1, same);
    expect(same.pixels).toEqual(src.pixels);
    const out = { width: 8, height: 4, pixels: new Uint8ClampedArray(8 * 4 * 4) };
    upscaleInto(src, 4, out);
    const row = (y: number) => Array.from({ length: 8 }, (_, x) => out.pixels[(y * 8 + x) * 4]);
    // The outer two columns on each side clamp to the edge pixels; the middle four ramp.
    expect(row(0)).toEqual([0, 0, 25, 75, 125, 175, 200, 200]);
    expect(row(3)).toEqual(row(0));
  });

  it('scales a picture up to about OVERLAY_PIXELS by a whole number', () => {
    expect(overlayScale(128, 72)).toBe(4);
    expect(overlayScale(250, 140)).toBe(2);
    expect(overlayScale(1000, 1000)).toBe(1);
    expect(overlayScale(0, 0)).toBeGreaterThanOrEqual(1);
  });

  it('knows a drawer by kind and draw()', () => {
    expect(isOverlayDrawer({ kind: 'overlay', draw() {} })).toBe(true);
    for (const bad of [null, 3, { kind: 'overlay' }, { draw() {} }, { kind: 'fluid', draw() {} }]) expect(isOverlayDrawer(bad)).toBe(false);
  });
});
