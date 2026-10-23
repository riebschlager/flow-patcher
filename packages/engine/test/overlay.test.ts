// Overlay drawing (ADR 0030): the pure-TS rasterizer overlays draw with, and
// the upscale the Renderer composes them over. Byte-exact golden renders.
import { describe, expect, it } from 'vitest';
import { createRng, fillOpaque, isOverlayDrawer, overlayScale, strokeEllipse, upscaleInto, type EllipseStroke, type OverlayTarget } from '../src';
import { expectGolden, sha256 } from '../../../test-support/golden';

const W = 160, H = 90;
function blank(width = W, height = H): OverlayTarget {
  const pixels = new Uint8ClampedArray(width * height * 4);
  fillOpaque(pixels, [7, 10, 17]);
  return { width, height, pixels };
}
const ring = (over: Partial<EllipseStroke> = {}): EllipseStroke => ({ cx: 80, cy: 45, rx: 30, ry: 14.4, rotation: 0, lineWidth: 1.4, color: [0.72, 0.63, 1], alpha: 0.5, ...over });
const at = (t: OverlayTarget, x: number, y: number) => [...t.pixels.slice((y * t.width + x) * 4, (y * t.width + x) * 4 + 4)];

/**
 * strokeEllipse as first written: every pixel of the bounding box, no per-row spans. The real one
 * must give the same bytes; its spans only skip pixels this would leave untouched.
 */
function bruteForceEllipse(target: OverlayTarget, stroke: EllipseStroke): void {
  const { cx, cy, rx, ry, rotation, lineWidth, color } = stroke;
  if (![cx, cy, rx, ry, rotation, lineWidth, stroke.alpha, ...color].every(Number.isFinite)) return;
  const alpha = Math.min(1, stroke.alpha);
  if (rx <= 0 || ry <= 0 || lineWidth <= 0 || alpha <= 0) return;
  const { width, height, pixels } = target;
  const half = lineWidth / 2;
  const reach = Math.max(rx, ry) + half + 1;
  const x0 = Math.max(0, Math.floor(cx - reach)), x1 = Math.min(width, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach)), y1 = Math.min(height, Math.ceil(cy + reach));
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const rgb = color.map((c) => Math.max(0, Math.min(1, c)) * 255);
  const rx2 = rx * rx, ry2 = ry * ry;
  for (let y = y0; y < y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx;
      const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
      const k0 = Math.hypot(u / rx, v / ry);
      const k1 = Math.hypot(u / rx2, v / ry2);
      const distance = k1 > 0 ? (k0 * (k0 - 1)) / k1 : Math.min(rx, ry);
      const coverage = Math.min(1, half + 0.5 - Math.abs(distance));
      if (coverage <= 0) continue;
      const a = alpha * coverage, k = (y * width + x) * 4;
      pixels[k] = pixels[k]! + (rgb[0]! - pixels[k]!) * a;
      pixels[k + 1] = pixels[k + 1]! + (rgb[1]! - pixels[k + 1]!) * a;
      pixels[k + 2] = pixels[k + 2]! + (rgb[2]! - pixels[k + 2]!) * a;
    }
  }
}

describe('overlay drawing', () => {
  it('gives the same bytes as a brute-force walk of the whole box, for random strokes', () => {
    const rng = createRng(20261023);
    const r = () => rng.next();
    const kinds = ['any', 'thin', 'flat', 'rotated', 'off-canvas', 'tiny', 'thick'] as const;
    let compared = 0;
    for (let n = 0; n < 420; n++) {
      const kind = kinds[n % kinds.length]!;
      const w = 64 + Math.floor(r() * 140), h = 48 + Math.floor(r() * 100);
      let rx = 1 + r() * 80, ry = 1 + r() * 80, lineWidth = 0.3 + r() * 4, cx = r() * w, cy = r() * h;
      let rotation = (r() - 0.5) * 8;
      if (kind === 'thin') lineWidth = 0.05 + r() * 0.5;
      if (kind === 'flat') ry = 0.2 + r() * 2;
      if (kind === 'rotated') rotation = Math.PI / 4 + (r() - 0.5) * 0.2 + Math.floor(r() * 4) * (Math.PI / 2);
      if (kind === 'off-canvas') {
        cx = r() < 0.5 ? -rx * r() : w + rx * r();
        cy = (r() - 0.25) * h * 1.5;
      }
      if (kind === 'tiny') {
        rx = 1e-3 + r() * 0.6;
        ry = 1e-3 + r() * 0.6;
      }
      if (kind === 'thick') lineWidth = 10 + r() * 60;
      const stroke: EllipseStroke = { cx, cy, rx, ry, rotation, lineWidth, color: [r(), r(), r()], alpha: 0.05 + r() };
      const fast = blank(w, h), slow = blank(w, h);
      strokeEllipse(fast, stroke);
      bruteForceEllipse(slow, stroke);
      if (!fast.pixels.every((v, i) => v === slow.pixels[i])) throw new Error(`stroke ${n} (${kind}) differs: ${JSON.stringify(stroke)}`);
      compared++;
    }
    expect(compared).toBe(420);
  });

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

  it('refuses a target that isn’t exactly the scaled size, so no pixel is left unwritten', () => {
    const src = { width: 2, height: 1, pixels: new Uint8ClampedArray(8) };
    const target = (width: number, height: number, length = width * height * 4) => ({ width, height, pixels: new Uint8ClampedArray(length) });
    for (const [out, scale] of [[target(9, 4), 4], [target(8, 5), 4], [target(4, 2), 4], [target(8, 4, 16), 4], [target(8, 4), 3.5], [target(0, 0), 0]] as const) {
      expect(() => upscaleInto(src, scale, out), `${out.width} × ${out.height} by ${scale}`).toThrow(RangeError);
    }
    expect(() => upscaleInto({ width: 2, height: 1, pixels: new Uint8ClampedArray(4) }, 1, target(2, 1))).toThrow(RangeError);
    expect(() => upscaleInto(src, 4, target(8, 4))).not.toThrow();
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
