// Borrowed from Flow's fluid-viewport.js. Ours to change; see docs/decisions/0001.

export interface GridSize {
  w: number;
  h: number;
}

export interface ResampleSource {
  w: number;
  h: number;
  u: Float32Array;
  v: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

const channels = ['u', 'v', 'r', 'g', 'b'] as const;

export const DESKTOP_CELL_BUDGET = 35000;
export const MOBILE_CELL_BUDGET = 16128;

// Keep solver cells approximately square in CSS space, independently of DPR.
export function fluidGridSize(width: number, height: number, { mobile = false } = {}): GridSize | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const budget = mobile ? MOBILE_CELL_BUDGET : DESKTOP_CELL_BUDGET;
  const maxSide = mobile ? 224 : 384;
  const spacing = Math.max(Math.sqrt((width * height) / budget), width / maxSide, height / maxSide);
  return { w: Math.max(8, Math.floor(width / spacing)), h: Math.max(8, Math.floor(height / spacing)) };
}

// Resample dye smoothly and preserve velocity in normalized canvas units.
// Scratch pressure/advection buffers belong to the destination and stay clear.
export function resampleFluidState(source: ResampleSource, target: ResampleSource): void {
  const sw = source.w, sh = source.h, tw = target.w, th = target.h;
  for (let y = 0; y < th; y++) {
    const sy = Math.max(0, Math.min(sh - 1, ((y + 0.5) * sh) / th - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < tw; x++) {
      const sx = Math.max(0, Math.min(sw - 1, ((x + 0.5) * sw) / tw - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), fx = sx - x0, i = x + y * tw;
      for (const key of channels) {
        const a = source[key];
        const value =
          (a[x0 + y0 * sw] * (1 - fx) + a[x1 + y0 * sw] * fx) * (1 - fy) +
          (a[x0 + y1 * sw] * (1 - fx) + a[x1 + y1 * sw] * fx) * fy;
        target[key][i] =
          key === 'u' ? Math.max(-1000, Math.min(1000, (value * tw) / sw))
          : key === 'v' ? Math.max(-1000, Math.min(1000, (value * th) / sh))
          : value;
      }
    }
  }
}
