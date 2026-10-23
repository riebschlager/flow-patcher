// The objects behind Field cables (design.md, "The fluid field"). A Field
// cable carries an object shared by reference: `NodeDefinition.field()`
// returns it, and the node at the other end reads it in `frame()` through
// `ctx.fields(port)`. Three kinds of Field port exist (PortSpec.fieldKind);
// the third, an overlay's Overlay output ('overlay'), is in render/overlay.ts.
//
// - Fluid's Field output ('fluid'): a `FluidField`. Readers (Renderer, later
//   Probe) get the step latched at the start of the frame, never the one the
//   frame is computing, so a Field → Signal read returns the previous frame
//   (ADR 0010, ADR 0016).
//
// - A writer's Write output ('write'), cabled into Fluid's Writers input: a
//   `FluidWriter`. The writer contract, for Splat, Force, Stir and Clear:
//   1. The writer is a visual node: Event inputs, a `frame()`, no `query()`.
//      The runtime hands its frame() the events due this frame: scheduled ones
//      once the frame clock (audio time minus output latency) passes them, a
//      tap's own events (ctx.pathOf(e) === 'immediate') on the next frame
//      after it arrives (ADR 0020). It queues what it will write in
//      `ctx.state` (frame-only state, never snapshotted, so handles are fine).
//   2. Its `field(ctx, 'write')` returns a FluidWriter reading that state.
//   3. Fluid's frame() runs after every writer's (the Writers cable orders
//      the plan), calls `write(target)` once on each writer in cable order,
//      then steps. `write` applies what's queued to the target and empties
//      the queue, so each splat lands in exactly one step.
//   4. Coordinates are 0–1 with y down; dye is in the canonical basis
//      (`canonicalDyes`), so the palette recolors it. Clamp positions and
//      drop non-finite values: a NaN in the dye spreads through every cell.
//   5. Splats, forces and pulses reach the solver in the order they were
//      written, across writers too (FluidWrite in backend.ts).
import type { Dye } from './fluid';
import type { FluidImage } from './backend';

/** What a Write output's object writes into: the step about to be taken. */
export interface FluidTarget {
  /** Dye plus an impulse at (x, y), as `Fluid.splat`. */
  splat(x: number, y: number, color: Dye, size?: number, dx?: number, dy?: number): void;
  /** A dye-free push of (dx, dy) around (x, y), as `Fluid.force` (Force). */
  force(x: number, y: number, dx: number, dy: number, radius?: number): void;
  /** A dye-free vortex around (x, y), as `Fluid.pulse`: direction 1 turns clockwise on screen, -1 the other way (Force's whirlpools). */
  pulse(x: number, y: number, strength?: number, radius?: number, direction?: number): void;
}

/** A writer's Write output. */
export interface FluidWriter {
  /** Applies everything queued since the last call to `target`, then forgets it. Called once per frame. */
  write(target: FluidTarget): void;
}

/** Fluid's Field output. */
export interface FluidField {
  readonly kind: 'fluid';
  /** The step latched at this frame's start, colored, or null before the first. Valid until the next frame. */
  image(): FluidImage | null;
}

export const isFluidWriter = (value: unknown): value is FluidWriter =>
  typeof value === 'object' && value !== null && typeof (value as FluidWriter).write === 'function';

export const isFluidField = (value: unknown): value is FluidField =>
  typeof value === 'object' && value !== null && (value as FluidField).kind === 'fluid' && typeof (value as FluidField).image === 'function';
