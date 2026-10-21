// Borrowed from Flow's fluid.js. Ours to change; see docs/decisions/0001.
// This CPU solver is the test reference and fallback for the GPU port (ADR 0003).
// Changes to the arithmetic change golden/fluid-frames.json; say why in the PR.
import { resampleFluidState } from './viewport';

export type Dye = readonly [number, number, number];

const FIELDS = ['u', 'v', 'u0', 'v0', 'r', 'g', 'b', 'tmp', 'p', 'p0', 'div', 'curl'] as const;
export type FluidFieldName = (typeof FIELDS)[number];

export const MAX_FLUID_CELLS = 50000;

// Incompressible, semi-Lagrangian fluid on a collocated grid.
// Pressure projection, velocity/dye advection, and vorticity confinement.
export class Fluid {
  w: number;
  h: number;
  n: number;
  /** Vorticity confinement strength. */
  swirl = 0.6;
  /** Dye persistence, 0–1: higher keeps color longer. */
  persistence = 0.7;
  u!: Float32Array;
  v!: Float32Array;
  u0!: Float32Array;
  v0!: Float32Array;
  r!: Float32Array;
  g!: Float32Array;
  b!: Float32Array;
  tmp!: Float32Array;
  p!: Float32Array;
  p0!: Float32Array;
  div!: Float32Array;
  curl!: Float32Array;

  constructor(w = 144, h = 100) {
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.allocate();
  }

  private allocate(): void {
    for (const key of FIELDS) this[key] = new Float32Array(this.n);
  }

  resize(w: number, h: number): boolean {
    if (w === this.w && h === this.h) return false;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 8 || h < 8 || w * h > MAX_FLUID_CELLS) {
      throw new Error('Invalid fluid grid dimensions.');
    }
    const previous = { w: this.w, h: this.h, u: this.u, v: this.v, r: this.r, g: this.g, b: this.b };
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.allocate();
    resampleFluidState(previous, this);
    return true;
  }

  clear(): void {
    for (const key of FIELDS) this[key].fill(0);
  }

  // A shared dye cap preserves hue when repeated droplets build up.
  splat(x: number, y: number, color: Dye, size = 0.05, dx = 0, dy = 0): void {
    const { w, h } = this;
    const cx = x * w, cy = y * h, rad = size * Math.min(w, h);
    for (let j = Math.max(1, Math.floor(cy - rad * 3)); j < Math.min(h - 1, cy + rad * 3); j++) {
      for (let i = Math.max(1, Math.floor(cx - rad * 3)); i < Math.min(w - 1, cx + rad * 3); i++) {
        const a = i - cx, b = j - cy, k = i + j * w, f = Math.exp(-(a * a + b * b) / (rad * rad));
        const r = this.r[k] + color[0] * f * 1.65;
        const g = this.g[k] + color[1] * f * 1.65;
        const blue = this.b[k] + color[2] * f * 1.65;
        const scale = 5 / Math.max(5, r, g, blue);
        this.r[k] = r * scale;
        this.g[k] = g * scale;
        this.b[k] = blue * scale;
        this.u[k] += (dx - b * 1.8) * f;
        this.v[k] += (dy + a * 1.8) * f;
      }
    }
  }

  // Local vortices add momentum without injecting any dye.
  pulse(x: number, y: number, strength = 0.5, radius = 0.08, direction = 1): void {
    const { w, h } = this, cx = x * w, cy = y * h, rad = radius * Math.min(w, h);
    for (let j = Math.max(1, Math.floor(cy - rad * 3)); j < Math.min(h - 1, cy + rad * 3); j++) {
      for (let i = Math.max(1, Math.floor(cx - rad * 3)); i < Math.min(w - 1, cx + rad * 3); i++) {
        const a = (i - cx) / rad, b = (j - cy) / rad, k = i + j * w;
        const f = Math.exp(-(a * a + b * b)) * strength * 45;
        this.u[k] += -b * f * direction;
        this.v[k] += a * f * direction;
      }
    }
  }

  force(x: number, y: number, dx: number, dy: number, radius = 0.04): void {
    const { w, h } = this, cx = x * w, cy = y * h, rad = radius * Math.min(w, h);
    for (let j = Math.max(1, Math.floor(cy - rad * 3)); j < Math.min(h - 1, cy + rad * 3); j++) {
      for (let i = Math.max(1, Math.floor(cx - rad * 3)); i < Math.min(w - 1, cx + rad * 3); i++) {
        const k = i + j * w, f = Math.exp(-((i - cx) ** 2 + (j - cy) ** 2) / (rad * rad));
        this.u[k] = Math.max(-180, Math.min(180, this.u[k] + dx * f));
        this.v[k] = Math.max(-180, Math.min(180, this.v[k] + dy * f));
      }
    }
  }

  /** Bilinear sample of a field at grid coordinates. */
  sample(field: Float32Array, x: number, y: number): number {
    x = Math.max(0.5, Math.min(this.w - 1.5, x));
    y = Math.max(0.5, Math.min(this.h - 1.5, y));
    const i = x | 0, j = y | 0, fx = x - i, fy = y - j, k = i + j * this.w;
    return (1 - fy) * ((1 - fx) * field[k] + fx * field[k + 1]) + fy * ((1 - fx) * field[k + this.w] + fx * field[k + this.w + 1]);
  }

  // Velocity components share a backtrace; dye channels share another one.
  // Preserve the interpolation arithmetic and boundary update order.
  private advectVelocity(dt: number, decay: number): void {
    const { w, h, u, v, u0, v0 } = this;
    for (let j = 1; j < h - 1; j++) {
      for (let i = 1; i < w - 1; i++) {
        const k = i + j * w;
        const x = Math.max(0.5, Math.min(w - 1.5, i - dt * u0[k]));
        const y = Math.max(0.5, Math.min(h - 1.5, j - dt * v0[k]));
        const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, n = ix + iy * w;
        u[k] = ((1 - fy) * ((1 - fx) * u0[n] + fx * u0[n + 1]) + fy * ((1 - fx) * u0[n + w] + fx * u0[n + w + 1])) * decay;
        v[k] = ((1 - fy) * ((1 - fx) * v0[n] + fx * v0[n + 1]) + fy * ((1 - fx) * v0[n + w] + fx * v0[n + w + 1])) * decay;
      }
    }
    this.edges(u);
    this.edges(v);
  }

  private advectDye(dt: number, decay: number): void {
    // u0/v0/tmp are free after projection and hold the previous dye.
    const { w, h, u, v, r, g, b, u0: r0, v0: g0, tmp: b0 } = this;
    r0.set(r);
    g0.set(g);
    b0.set(b);
    for (let j = 1; j < h - 1; j++) {
      for (let i = 1; i < w - 1; i++) {
        const k = i + j * w;
        const x = Math.max(0.5, Math.min(w - 1.5, i - dt * u[k]));
        const y = Math.max(0.5, Math.min(h - 1.5, j - dt * v[k]));
        const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, n = ix + iy * w;
        r[k] = ((1 - fy) * ((1 - fx) * r0[n] + fx * r0[n + 1]) + fy * ((1 - fx) * r0[n + w] + fx * r0[n + w + 1])) * decay;
        g[k] = ((1 - fy) * ((1 - fx) * g0[n] + fx * g0[n + 1]) + fy * ((1 - fx) * g0[n + w] + fx * g0[n + w + 1])) * decay;
        b[k] = ((1 - fy) * ((1 - fx) * b0[n] + fx * b0[n + 1]) + fy * ((1 - fx) * b0[n + w] + fx * b0[n + w + 1])) * decay;
      }
    }
    this.edges(r);
    this.edges(g);
    this.edges(b);
  }

  /** Boundary copy; axis 1 negates at the left/right walls, axis 2 at the top/bottom. */
  private edges(a: Float32Array, axis = 0): void {
    const { w, h } = this;
    for (let x = 1; x < w - 1; x++) {
      a[x] = axis === 2 ? -a[x + w] : a[x + w];
      a[x + (h - 1) * w] = axis === 2 ? -a[x + (h - 2) * w] : a[x + (h - 2) * w];
    }
    for (let y = 0; y < h; y++) {
      a[y * w] = axis === 1 ? -a[y * w + 1] : a[y * w + 1];
      a[y * w + w - 1] = axis === 1 ? -a[y * w + w - 2] : a[y * w + w - 2];
    }
  }

  private project(): void {
    const { w, h, u, v, div, p } = this;
    p.fill(0);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const k = x + y * w;
        div[k] = 0.5 * (u[k + 1] - u[k - 1] + v[k + w] - v[k - w]);
      }
    }
    this.edges(div);
    for (let z = 0; z < 20; z++) {
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const k = x + y * w;
          p[k] = (p[k - 1] + p[k + 1] + p[k - w] + p[k + w] - div[k]) * 0.25;
        }
      }
      this.edges(p);
    }
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const k = x + y * w;
        u[k] -= 0.5 * (p[k + 1] - p[k - 1]);
        v[k] -= 0.5 * (p[k + w] - p[k - w]);
      }
    }
    this.edges(u, 1);
    this.edges(v, 2);
  }

  step(dt = 1 / 60): void {
    const { w, h, u, v, u0, v0, curl } = this;
    dt = Math.min(dt, 0.035);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const k = x + y * w;
        curl[k] = 0.5 * (v[k + 1] - v[k - 1] - u[k + w] + u[k - w]);
      }
    }
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const k = x + y * w;
        const gx = Math.abs(curl[k + 1]) - Math.abs(curl[k - 1]);
        const gy = Math.abs(curl[k + w]) - Math.abs(curl[k - w]);
        const len = Math.hypot(gx, gy) + 1e-5, force = dt * this.swirl * 7 * curl[k];
        u[k] += (gy / len) * force;
        v[k] -= (gx / len) * force;
      }
    }
    u0.set(u);
    v0.set(v);
    const drag = Math.pow(0.994, dt * 60);
    this.advectVelocity(dt, drag);
    this.project();
    const fade = Math.pow(0.981 + this.persistence * 0.017, dt * 60);
    this.advectDye(dt, fade);
  }
}
