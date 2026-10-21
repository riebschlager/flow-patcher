// Borrowed from Flow's fluid-renderer.js. Ours to change; see docs/decisions/0001.
// CPU reference renderer: writes RGBA pixels, one per solver cell.
// Changes here change golden/palette-renders.json; say why in the PR.
import { canonicalDyes, getPalette, hexRGB, type RGB } from './palettes';

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

type Point = [number, number];

// Interpret the RGB dye as a point in the four-color palette polygon.
// Capped solver channels can drift outside that polygon. Project those mixtures
// onto its nearest edge, rather than extrapolating negative colors and clipping.
const vertices: Point[] = canonicalDyes.map((c) => {
  const sum = c[0] + c[1] + c[2];
  return [c[0] / sum, c[1] / sum];
});
const triangles = [[0, 1, 3], [0, 3, 2]].map((indices) => {
  const [a, b, c] = indices.map((i) => vertices[i]) as [Point, Point, Point];
  const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  return { indices: indices as [number, number, number], a, b, c, den };
});
const edges = [[0, 1], [1, 3], [3, 2], [2, 0]].map(([a, b]) => {
  const start = vertices[a as number] as Point;
  const end = vertices[b as number] as Point;
  const dx = end[0] - start[0], dy = end[1] - start[1];
  return { a: a as number, b: b as number, start, dx, dy, length: dx * dx + dy * dy };
});

type PigmentMapper = (r: number, g: number, b: number, out: number[]) => void;

function createPigmentMapper(palette: unknown): PigmentMapper {
  const colors = getPalette(palette).colors.map((c) => hexRGB(c.hex));
  return (r, g, b, out) => {
    const sum = r + g + b, x = r / sum, y = g / sum;
    for (const { indices, a, b, c, den } of triangles) {
      const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den;
      const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den;
      const w = 1 - u - v;
      if (u >= 0 && v >= 0 && w >= 0) {
        const [c0, c1, c2] = indices.map((i) => colors[i]) as [RGB, RGB, RGB];
        for (let j = 0; j < 3; j++) out[j] = c0[j] * u + c1[j] * v + c2[j] * w;
        return;
      }
    }
    let distance = Infinity, bestEdge = edges[0]!, bestT = 0;
    for (const edge of edges) {
      const { start, dx, dy, length } = edge;
      const t = clamp(((x - start[0]) * dx + (y - start[1]) * dy) / length, 0, 1);
      const ex = x - start[0] - t * dx, ey = y - start[1] - t * dy, d = ex * ex + ey * ey;
      if (d < distance) {
        distance = d;
        bestEdge = edge;
        bestT = t;
      }
    }
    const from = colors[bestEdge.a] as RGB, to = colors[bestEdge.b] as RGB;
    for (let j = 0; j < 3; j++) out[j] = from[j] * (1 - bestT) + to[j] * bestT;
  };
}

export type Colorizer = (
  r: number, g: number, b: number, lighting: number, gradient: number,
  out: number[] | Uint8ClampedArray, offset?: number,
) => void;

/** Background color where there is no dye, in 0–255 sRGB. */
export const FLUID_BACKGROUND: RGB = [7, 10, 17];

// Palette colors are already display-ready sRGB. Keep their channel ratios and
// saturation; density only controls coverage over the dark background.
export function createFluidColorizer(palette: unknown): Colorizer {
  const mapDye = createPigmentMapper(palette), mapped = [0, 0, 0];
  const [bgR, bgG, bgB] = FLUID_BACKGROUND;
  return function colorize(r, g, b, lighting, gradient, out, offset = 0) {
    const density = Math.max(r, g, b);
    if (density < 1e-10) {
      out[offset] = bgR;
      out[offset + 1] = bgG;
      out[offset + 2] = bgB;
      return;
    }
    mapDye(r, g, b, mapped);
    const coverage = -Math.expm1(-density * 1.65), ridge = Math.max(0, gradient);
    // Lighting can gently darken pigment or recover its original brightness. It
    // cannot oversaturate a swatch, normalize its channels, or add white to it.
    const brightness = Math.min(1, 0.84 + 0.16 * clamp(lighting, 0, 1) + (0.02 * ridge) / (1 + ridge));
    const scale = 255 * coverage * brightness, remaining = 1 - coverage;
    out[offset] = bgR * remaining + mapped[0]! * scale;
    out[offset + 1] = bgG * remaining + mapped[1]! * scale;
    out[offset + 2] = bgB * remaining + mapped[2]! * scale;
  };
}

export interface DyeGrid {
  w: number;
  h: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

// A one-cell Gaussian reconstruction softens solver-grid boundaries before
// nonlinear density/color mapping.
function smooth(field: Float32Array, i: number, left: number, right: number, up: number, down: number): number {
  return (
    (field[i] * 4 +
      (field[i + left] + field[i + right] + field[i + up] + field[i + down]) * 2 +
      field[i + up + left] + field[i + up + right] + field[i + down + left] + field[i + down + right]) / 16
  );
}

/** Renders one RGBA pixel per cell. Never mutates the grid. */
export function renderFluidPixels(
  sim: DyeGrid, pixels: Uint8ClampedArray, time: number, colorize: Colorizer, { luminance = 1 } = {},
): Uint8ClampedArray {
  const { w, h } = sim;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = x + y * w, left = x > 0 ? -1 : 0, right = x < w - 1 ? 1 : 0, up = y > 0 ? -w : 0, down = y < h - 1 ? w : 0;
      const r = smooth(sim.r, i, left, right, up, down);
      const g = smooth(sim.g, i, left, right, up, down);
      const b = smooth(sim.b, i, left, right, up, down);
      const gradient = sim.r[i + right] + sim.g[i + right] + sim.b[i + right] - (sim.r[i + left] + sim.g[i + left] + sim.b[i + left]);
      const lighting = (0.82 + 0.18 * Math.sin(x * 0.035 + y * 0.03 + time * 0.12)) * luminance;
      colorize(r, g, b, lighting, gradient, pixels, i * 4);
      pixels[i * 4 + 3] = 255;
    }
  }
  return pixels;
}
