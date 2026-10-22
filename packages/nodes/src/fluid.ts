// Fluid: Flow's CPU solver, stepped by the host's fluid backend (ADR 0016).
// In the browser that is a Worker (FluidHost); headless and in tests it is
// in process, in lockstep, so output stays bit-exact. Writers (Splat, later
// Force and Stir) cable their Write output into Writers; readers (Renderer)
// read the Field output, which gives the step latched at the frame's start.
// The writer contract is in packages/engine/src/fluid/field.ts.
import {
  colorPalettes,
  createInProcessFluid,
  fluidSolverParams,
  isFluidWriter,
  type FluidBackend,
  type FluidField,
  type FluidTarget,
  type NodeDefinition,
  type NodeState,
  type SplatArgs,
} from '@flow-patcher/engine';

/** Fixed for M1; the grid budget knob comes with the GPU solver. */
export const FLUID_GRID = { w: 128, h: 72 };
/** Splat size when a writer gives none: Fluid.splat's default. */
const DEFAULT_SIZE = 0.05;

/** Frame-only state (Fluid has no query, so it is never snapshotted and may hold handles). */
interface FluidState extends NodeState {
  backend?: FluidBackend;
  field?: FluidField;
}

const unit = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

export const fluid: NodeDefinition = {
  type: 'fluid',
  version: 3,
  label: 'Fluid',
  category: 'visual',
  description: 'The fluid simulation (CPU solver). Writers splat into it; its Field feeds the Renderer.',
  ports: [
    { name: 'writers', type: 'field', direction: 'in', label: 'Writers', fieldKind: 'write' },
    { name: 'field', type: 'field', direction: 'out', label: 'Field' },
  ],
  params: [
    { name: 'vorticity', kind: 'number', min: 0, max: 1, default: 0.6, label: 'Vorticity' },
    // Flow's persistence upside down: 0.3 is Flow's default of 0.7.
    { name: 'dissipation', kind: 'number', min: 0, max: 1, default: 0.3, label: 'Dissipation' },
    // Velocity drag per 1/60 s, from Flow's 0.994 at 0 to 0.934 at 1.
    { name: 'viscosity', kind: 'number', min: 0, max: 1, default: 0, label: 'Viscosity' },
    { name: 'palette', kind: 'enum', options: Object.keys(colorPalettes), default: 'classic', label: 'Palette' },
  ],
  field(ctx) {
    const s = ctx.state as FluidState;
    return (s.field ??= { kind: 'fluid', image: () => s.backend?.latched() ?? null });
  },
  // No image(): the Renderer shows the Field, and headless runs write its frame.
  frame({ params, state, services, fields, t1, dt }) {
    const s = state as FluidState;
    if (!s.backend) {
      // A fresh node (added, or its state reset by an edit) starts from still water.
      s.backend = services.fluid ?? createInProcessFluid();
      s.backend.reset();
    }
    // Readers this frame see the last step that finished before it.
    s.backend.latch();
    const splats: SplatArgs[] = [];
    const target: FluidTarget = {
      splat(x, y, color, size = DEFAULT_SIZE, dx = 0, dy = 0) {
        // A NaN anywhere would spread through every cell for good.
        const dye = [0, 1, 2].map((i) => Math.max(0, finite(color[i], 0)));
        splats.push([unit(x, 0.5), unit(y, 0.5), dye[0]!, dye[1]!, dye[2]!, Math.max(0, finite(size, DEFAULT_SIZE)), finite(dx, 0), finite(dy, 0)]);
      },
    };
    for (const writer of fields('writers')) if (isFluidWriter(writer)) writer.write(target);
    s.backend.step({
      dt,
      grid: FLUID_GRID,
      params: fluidSolverParams(params.vorticity as number, params.dissipation as number, params.viscosity as number),
      palette: params.palette as string,
      splats,
      time: t1,
    });
  },
};
