// Overlays (ADR 0030): pictures drawn over the fluid, such as Orbit Rings.
// An overlay node's Overlay output (fieldKind 'overlay') returns an
// `OverlayDrawer` from `field()`, cabled into the Renderer's Overlays input.
// The contract:
//   1. The overlay is a visual node: its frame() updates its state from its
//      inputs (signals, events, params) on the frame clock. Drawing reads that
//      state and changes nothing, so state and drawing stay apart
//      (docs/nodes/visual.md).
//   2. The Renderer's frame() runs after every overlay's (the Overlays cable
//      orders the plan). It asks each drawer whether it shows anything
//      (`visible()`). If none does, it passes the fluid's picture through,
//      as with no overlays. Otherwise it copies the fluid's picture into a
//      buffer of its own, scaled up by `overlayScale`, and calls
//      `draw(target)` on each visible drawer in cable order, so later cables
//      draw on top.
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
  /** Whether `draw` would change any pixel now (Orbit Rings: false while faded out). Absent means always.
   *  Lets the Renderer skip composing while every overlay is idle. Must not change state. */
  visible?(): boolean;
  /** Draws the overlay's current state into `target`. Called at most once per frame; must not change state. */
  draw(target: OverlayTarget): void;
}

/** Whether a drawer shows anything now: `visible()`, or true without one. */
export const overlayVisible = (drawer: OverlayDrawer): boolean => drawer.visible?.() ?? true;

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

/** One axis of an upscale: for each output pixel, the two source pixels and the weight between them. */
interface UpscaleAxis {
  i0: Int32Array;
  i1: Int32Array;
  f: Float64Array;
}

/** The lookup tables for upscaling a width × height picture by `scale`. Keep them while the sizes stay the same. */
export interface UpscalePlan {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly cols: UpscaleAxis;
  readonly rows: UpscaleAxis;
  /** Scratch: each source row upscaled across, RGBA as float64 so the result is the same as lerping in one pass. */
  readonly across: Float64Array;
}

function upscaleAxis(size: number, scale: number): UpscaleAxis {
  const n = size * scale;
  const i0 = new Int32Array(n), i1 = new Int32Array(n), f = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const s = Math.max(0, Math.min(size - 1, (k + 0.5) / scale - 0.5));
    i0[k] = Math.floor(s);
    i1[k] = Math.min(size - 1, i0[k]! + 1);
    f[k] = s - i0[k]!;
  }
  return { i0, i1, f };
}

export function planUpscale(width: number, height: number, scale: number): UpscalePlan {
  return { width, height, scale, cols: upscaleAxis(width, scale), rows: upscaleAxis(height, scale), across: new Float64Array(height * width * scale * 4) };
}

/**
 * Bilinear upscale of `src` by `scale` into `out` (scale × the size), sampling
 * at pixel centers with edges clamped, as a browser's smoothed drawImage does.
 * Pass a `plan` from `planUpscale` for these sizes to skip building its tables.
 */
export function upscaleInto(src: Picture, scale: number, out: Picture, plan?: UpscalePlan): void {
  const { width: w, height: h, pixels: from } = src;
  const W = out.width, H = out.height, to = out.pixels;
  const usable = plan && plan.width === w && plan.height === h && plan.scale === scale ? plan : planUpscale(w, h, scale);
  const { cols, rows, across } = usable;
  // Two passes: across each source row, then down. Each output channel is the same
  // lerp(lerp(a, b, fx), lerp(c, d, fx), fy) as a one-pass bilinear, so the bytes match, but the
  // across-lerps are done once per source row instead of once per output row.
  const n = w * scale;
  const Wn = Math.min(W, n), Hn = Math.min(H, h * scale);
  for (let j = 0; j < h; j++) {
    const row = j * w, base = j * n * 4;
    for (let x = 0; x < Wn; x++) {
      const a = (row + cols.i0[x]!) * 4, b = (row + cols.i1[x]!) * 4, fx = cols.f[x]!, o = base + x * 4;
      across[o] = from[a]! + (from[b]! - from[a]!) * fx;
      across[o + 1] = from[a + 1]! + (from[b + 1]! - from[a + 1]!) * fx;
      across[o + 2] = from[a + 2]! + (from[b + 2]! - from[a + 2]!) * fx;
      across[o + 3] = from[a + 3]! + (from[b + 3]! - from[a + 3]!) * fx;
    }
  }
  for (let y = 0; y < Hn; y++) {
    const top = rows.i0[y]! * n * 4, bottom = rows.i1[y]! * n * 4, fy = rows.f[y]!;
    const o = y * W * 4;
    for (let k = 0; k < Wn * 4; k++) {
      const t = across[top + k]!;
      to[o + k] = t + (across[bottom + k]! - t) * fy;
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
 * For an ellipse with semi-axes a, b turned by (cos, sin): a function giving,
 * for a row dy from the center, the dx range [lo, hi] inside it, or false
 * when the row misses it.
 */
function spanSolver(a: number, b: number, cos: number, sin: number): (dy: number, out: [number, number]) => boolean {
  const ia = 1 / (a * a), ib = 1 / (b * b);
  const A = cos * cos * ia + sin * sin * ib;
  const B1 = 2 * cos * sin * (ia - ib);
  const C1 = sin * sin * ia + cos * cos * ib;
  return (dy, out) => {
    const B = B1 * dy, C = C1 * dy * dy - 1;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return false;
    const root = Math.sqrt(disc);
    out[0] = (-B - root) / (2 * A);
    out[1] = (-B + root) / (2 * A);
    return true;
  };
}

/**
 * Blends an antialiased ellipse outline into `target`, source-over. Coverage
 * comes from an approximate distance to the ellipse, so the line keeps its
 * width all the way round. Non-finite or empty strokes draw nothing.
 */
export function strokeEllipse(target: OverlayTarget, stroke: EllipseStroke): void {
  const { cx, cy, rx, ry, rotation, lineWidth, color } = stroke;
  if (!(finite(cx) && finite(cy) && finite(rx) && finite(ry) && finite(rotation) && finite(lineWidth) && finite(stroke.alpha))) return;
  if (!(finite(color[0]) && finite(color[1]) && finite(color[2]))) return;
  const alpha = Math.min(1, stroke.alpha);
  if (rx <= 0 || ry <= 0 || lineWidth <= 0 || alpha <= 0) return;
  const { width, height, pixels } = target;
  const half = lineWidth / 2;
  const reach = Math.max(rx, ry) + half + 1;
  const x0 = Math.max(0, Math.floor(cx - reach)), x1 = Math.min(width, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach)), y1 = Math.min(height, Math.ceil(cy + reach));
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const cr = Math.max(0, Math.min(1, color[0])) * 255, cg = Math.max(0, Math.min(1, color[1])) * 255, cb = Math.max(0, Math.min(1, color[2])) * 255;
  const rx2 = rx * rx, ry2 = ry * ry;
  // Only pixels near the outline can be covered. With k0 = |(u/rx, v/ry)| and k1 <= k0 / min(rx, ry),
  // the distance below is at least |k0 - 1| × min(rx, ry), so a covered pixel has |k0 - 1| < e with
  // e = (half + 0.5) / min(rx, ry). Per row, that's between the ellipses scaled by 1 + e and 1 - e;
  // the spans are widened by a pixel each way against rounding. It only saves walking the empty
  // middle and corners: every pixel with any coverage is still visited.
  const e = (half + 0.5) / Math.min(rx, ry);
  const outer = spanSolver(rx * (1 + e), ry * (1 + e), cos, sin);
  const inner = e < 1 ? spanSolver(rx * (1 - e), ry * (1 - e), cos, sin) : null;
  const span: [number, number] = [0, 0];
  for (let y = y0; y < y1; y++) {
    const dy = y + 0.5 - cy;
    if (!outer(dy, span)) continue;
    const from = Math.max(x0, Math.floor(cx + span[0] - 1.5)), to = Math.min(x1, Math.ceil(cx + span[1] + 1.5));
    let skipFrom = Infinity, skipTo = -Infinity;
    if (inner?.(dy, span)) {
      skipFrom = span[0] + 1;
      skipTo = span[1] - 1;
    }
    for (let x = from; x < to; x++) {
      const dx = x + 0.5 - cx;
      if (dx > skipFrom && dx < skipTo) continue;
      // Into the ellipse's own frame (undo the rotation).
      const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
      const k0 = Math.hypot(u / rx, v / ry);
      const k1 = Math.hypot(u / rx2, v / ry2);
      const distance = k1 > 0 ? (k0 * (k0 - 1)) / k1 : Math.min(rx, ry);
      const coverage = Math.min(1, half + 0.5 - Math.abs(distance));
      if (coverage <= 0) continue;
      const a = alpha * coverage, k = (y * width + x) * 4;
      pixels[k] = pixels[k]! + (cr - pixels[k]!) * a;
      pixels[k + 1] = pixels[k + 1]! + (cg - pixels[k + 1]!) * a;
      pixels[k + 2] = pixels[k + 2]! + (cb - pixels[k + 2]!) * a;
    }
  }
}
