// Interim shape: until Field cables exist (M1), the Fluid node takes splat
// events directly. The Splat, Force and Probe nodes replace this input.
import {
  Fluid,
  canonicalDyes,
  colorPalettes,
  createFluidColorizer,
  randomAt,
  renderFluidPixels,
  timeKey,
  type NodeDefinition,
  type NodeState,
} from '@flow-patcher/engine';

export const FLUID_GRID = { w: 128, h: 72 };

interface FluidState extends NodeState {
  sim?: Fluid;
  time?: number;
}

const field = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;

export const fluid: NodeDefinition = {
  type: 'fluid',
  version: 1,
  label: 'Fluid',
  category: 'visual',
  description: 'The fluid simulation (CPU solver). Each splat event drops dye at its x/y.',
  ports: [{ name: 'splat', type: 'event', direction: 'in', label: 'Splat' }],
  params: [
    { name: 'swirl', kind: 'number', min: 0, max: 1, default: 0.6, label: 'Vorticity' },
    { name: 'persistence', kind: 'number', min: 0, max: 1, default: 0.7, label: 'Persistence' },
    { name: 'size', kind: 'number', min: 0.01, max: 0.2, default: 0.05, label: 'Splat size' },
    { name: 'palette', kind: 'enum', options: Object.keys(colorPalettes), default: 'classic', label: 'Palette' },
  ],
  frame({ inputs, params, state, seed, nodeId, t1, dt }) {
    const s = state as FluidState;
    const sim = (s.sim ??= new Fluid(FLUID_GRID.w, FLUID_GRID.h));
    sim.swirl = params.swirl as number;
    sim.persistence = params.persistence as number;
    for (const e of inputs.splat ?? []) {
      // Events without a position land at a seeded point.
      const key = timeKey(e.time);
      const x = field(e.x, 0.15 + 0.7 * randomAt(seed, nodeId, key, e.channel, 'x'));
      const y = field(e.y, 0.15 + 0.7 * randomAt(seed, nodeId, key, e.channel, 'y'));
      const dye = canonicalDyes[(typeof e.index === 'number' ? e.index : e.channel) & 3]!;
      sim.splat(x, y, dye, params.size as number);
    }
    sim.step(dt);
    s.time = t1;
  },
  image(state, params) {
    const s = state as FluidState;
    if (!s.sim) return null;
    const pixels = new Uint8ClampedArray(s.sim.n * 4);
    renderFluidPixels(s.sim, pixels, s.time ?? 0, createFluidColorizer(params.palette));
    return { width: s.sim.w, height: s.sim.h, pixels };
  },
};
