// Overlays (ADR 0030): pictures drawn over the fluid, such as Orbit Rings.
// An overlay node's Overlay output (fieldKind 'overlay') returns an
// `OverlayDrawer` from `field()`, cabled into the Renderer's Overlays input.
// The contract:
//   1. The overlay is a visual node: its frame() updates its state from its
//      inputs (signals, events, params) on the frame clock. Drawing reads that
//      state and changes nothing, so state and drawing stay apart
//      (docs/nodes/visual.md).
//   2. The Renderer's frame() runs after every overlay's (the Overlays cable
//      orders the plan). It copies the fluid's picture into a buffer of its
//      own, scaled up by `overlayScale`, and calls `draw(target)` on each
//      drawer in cable order, so later cables draw on top.
//   3. `draw` blends into the target's pixels in pure TS: no Canvas2D, no DOM.
//      The same patch, seed and frames give the same bytes, headless or live.
//      Sizes are in target pixels; scale them from min(width, height) so a
//      bigger target draws the same picture, sharper.
//   4. Reduced motion (`HostServices.reducedMotion`): an overlay keeps its
//      color and drops the motion it adds (ADR 0012).
import type { RGB } from './palettes';

/** What an overlay draws into: the Renderer's picture for this frame. */
export interface OverlayTarget {
  readonly width: number;
  readonly height: number;
  /** Opaque RGBA, row-major, top row first. Blend into it; leave alpha at 255. */
  readonly pixels: Uint8ClampedArray;
}

/** An overlay's Overlay output. */
export interface OverlayDrawer {
  readonly kind: 'overlay';
  /** Draws the overlay's current state into `target`. Called once per frame; must not change state. */
  draw(target: OverlayTarget): void;
}

export const isOverlayDrawer = (value: unknown): value is OverlayDrawer =>
  typeof value === 'object' && value !== null && (value as OverlayDrawer).kind === 'overlay' && typeof (value as OverlayDrawer).draw === 'function';

/** About how many pixels the Renderer composes overlays into: 512 × 288, four times M1's 128 × 72 fluid grid each way. */
export const OVERLAY_PIXELS = 512 * 288;
/** The picture overlays draw into when no fluid picture is there to size it. */
export const OVERLAY_SIZE = { width: 512, height: 288 } as const;

/** The whole-number factor the Renderer scales a w × h fluid picture by before overlays draw: at most OVERLAY_PIXELS, at least 1. */
export function overlayScale(width: number, height: number): number {
  return Math.max(1, Math.floor(Math.sqrt(OVERLAY_PIXELS / Math.max(1, width * height))));
}

interface Picture {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

/**
 * Bilinear upscale of `src` by `scale` into `out` (scale × the size), sampling
 * at pixel centers with edges clamped, as a browser's smoothed drawImage does.
 */
export function upscaleInto(src: Picture, scale: number, out: Picture): void {
  const { width: w, height: h, pixels: from } = src;
  const W = out.width, H = out.height, to = out.pixels;
  const axis = (size: number, n: number) => {
    const i0 = new Int32Array(n), i1 = new Int32Array(n), f = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const s = Math.max(0, Math.min(size - 1, (k + 0.5) / scale - 0.5));
      i0[k] = Math.floor(s);
      i1[k] = Math.min(size - 1, i0[k]! + 1);
      f[k] = s - i0[k]!;
    }
    return { i0, i1, f };
  };
  const cols = axis(w, W), rows = axis(h, H);
  for (let y = 0; y < H; y++) {
    const r0 = rows.i0[y]! * w, r1 = rows.i1[y]! * w, fy = rows.f[y]!;
    let o = y * W * 4;
    for (let x = 0; x < W; x++, o += 4) {
      const a = (r0 + cols.i0[x]!) * 4, b = (r0 + cols.i1[x]!) * 4, c = (r1 + cols.i0[x]!) * 4, d = (r1 + cols.i1[x]!) * 4;
      const fx = cols.f[x]!;
      // Unrolled over the four channels: this runs for every pixel of every frame with overlays.
      let top = from[a]! + (from[b]! - from[a]!) * fx, bottom = from[c]! + (from[d]! - from[c]!) * fx;
      to[o] = top + (bottom - top) * fy;
      top = from[a + 1]! + (from[b + 1]! - from[a + 1]!) * fx;
      bottom = from[c + 1]! + (from[d + 1]! - from[c + 1]!) * fx;
      to[o + 1] = top + (bottom - top) * fy;
      top = from[a + 2]! + (from[b + 2]! - from[a + 2]!) * fx;
      bottom = from[c + 2]! + (from[d + 2]! - from[c + 2]!) * fx;
      to[o + 2] = top + (bottom - top) * fy;
      top = from[a + 3]! + (from[b + 3]! - from[a + 3]!) * fx;
      bottom = from[c + 3]! + (from[d + 3]! - from[c + 3]!) * fx;
      to[o + 3] = top + (bottom - top) * fy;
    }
  }
}

/** Fills an RGBA buffer with one opaque color (0–255 channels). */
export function fillOpaque(pixels: Uint8ClampedArray, rgb: readonly [number, number, number]): void {
  for (let k = 0; k < pixels.length; k += 4) {
    pixels[k] = rgb[0];
    pixels[k + 1] = rgb[1];
    pixels[k + 2] = rgb[2];
    pixels[k + 3] = 255;
  }
}

/** One ellipse outline, in target pixels. */
export interface EllipseStroke {
  cx: number;
  cy: number;
  /** Semi-axes before rotation: rx along x, ry along y. */
  rx: number;
  ry: number;
  /** Radians, clockwise on screen (y down), as Canvas2D's ellipse(). */
  rotation: number;
  lineWidth: number;
  /** 0–1 channels. */
  color: RGB;
  /** 0–1: the stroke's opacity where it covers a pixel fully. */
  alpha: number;
}

const finite = (value: number) => Number.isFinite(value);

/**
 * Blends an antialiased ellipse outline into `target`, source-over. Coverage
 * comes from an approximate distance to the ellipse, so the line keeps its
 * width all the way round. Non-finite or empty strokes draw nothing.
 */
export function strokeEllipse(target: OverlayTarget, stroke: EllipseStroke): void {
  const { cx, cy, rx, ry, rotation, lineWidth, color } = stroke;
  if (![cx, cy, rx, ry, rotation, lineWidth, stroke.alpha, ...color].every(finite)) return;
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
      // Into the ellipse's own frame (undo the rotation).
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
