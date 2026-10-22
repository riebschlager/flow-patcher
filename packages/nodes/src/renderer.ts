// Renderer (basic, M1): shows the Fluid's Field on the performance canvas
// (docs/nodes/visual.md). Each frame it takes the step Fluid latched at the
// frame's start, already colored by Fluid's palette; it adds no look of its
// own yet (bloom, refraction and grain come in M3). One per patch (ADR 0005).
//
// The latched pixels belong to the fluid backend: they are valid until the
// next frame's latch, then go back to the worker to be reused. frame() keeps
// a reference, not a copy. The browser host draws it in the same frame with
// `rendererImage` (no copy); `image()`, for headless runs, copies it, so call
// it between frames. With nothing to show, the host fills the canvas with
// FLUID_BACKGROUND.
import { isFluidField, type FluidImage, type NodeDefinition, type NodeImage, type NodeState } from '@flow-patcher/engine';

/** Frame-only state (Renderer has no query, so it is never snapshotted and may hold the backend's buffer). */
interface RendererState extends NodeState {
  shown?: FluidImage | null;
}

/** A usable image: positive integer size and exactly width × height RGBA pixels. */
function usable(image: unknown): image is FluidImage {
  if (typeof image !== 'object' || image === null) return false;
  const { width, height, pixels } = image as FluidImage;
  return (
    Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0 &&
    pixels instanceof Uint8ClampedArray && pixels.length === width * height * 4
  );
}

/**
 * The picture the Renderer's last frame took, without copying: the fluid
 * backend's own buffer, valid only until the next frame. Null with nothing to
 * show (no Fluid cabled, or none of its steps finished yet).
 */
export function rendererImage(state: NodeState): FluidImage | null {
  return (state as RendererState).shown ?? null;
}

export const renderer: NodeDefinition = {
  type: 'renderer',
  version: 1,
  label: 'Renderer',
  category: 'visual',
  description: 'Draws the fluid’s Field on the canvas. One per patch.',
  ports: [{ name: 'field', type: 'field', direction: 'in', label: 'Field', fieldKind: 'fluid' }],
  params: [],
  frame({ state, fields }) {
    const s = state as RendererState;
    // The first Fluid on the input; anything else cabled here draws nothing.
    const field = fields('field').find(isFluidField);
    const image = field?.image();
    s.shown = usable(image) ? image : null;
  },
  /** A copy of the last frame's picture, safe to keep. Call it between frames. */
  image(state): NodeImage | null {
    const shown = rendererImage(state);
    return shown ? { width: shown.width, height: shown.height, pixels: shown.pixels.slice() } : null;
  },
};
