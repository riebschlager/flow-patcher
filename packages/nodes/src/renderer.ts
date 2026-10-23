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
//
// Overlays (ADR 0030): while an overlay cabled into Overlays shows anything,
// the picture is the Renderer's own buffer instead: the fluid's pixels scaled
// up by `overlayScale` (or FLUID_BACKGROUND without a fluid picture), with
// each visible overlay drawn over it in cable order. The buffer is reused, so
// the same no-copy rule holds. While every overlay is idle, the fluid's
// picture passes through as with none, and nothing is composed.
import {
  FLUID_BACKGROUND,
  fillOpaque,
  isFluidField,
  isOverlayDrawer,
  OVERLAY_SIZE,
  overlayScale,
  overlayVisible,
  planUpscale,
  upscaleInto,
  type FluidImage,
  type OverlayDrawer,
  type UpscalePlan,
  type NodeDefinition,
  type NodeImage,
  type NodeState,
} from '@flow-patcher/engine';

/** Frame-only state (Renderer has no query, so it is never snapshotted and may hold the backend's buffer). */
interface RendererState extends NodeState {
  shown?: FluidImage | null;
  /** The buffer overlays draw into, and the upscale's tables, kept between frames. */
  composed?: FluidImage;
  plan?: UpscalePlan;
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
  version: 2,
  label: 'Renderer',
  category: 'visual',
  // One per patch: one canvas (ADR 0005).
  unique: true,
  description: 'Draws the fluid’s Field on the canvas, with any Overlays on top. One per patch.',
  ports: [
    { name: 'field', type: 'field', direction: 'in', label: 'Field', fieldKind: 'fluid' },
    { name: 'overlays', type: 'field', direction: 'in', label: 'Overlays', fieldKind: 'overlay' },
  ],
  params: [],
  frame({ state, fields }) {
    const s = state as RendererState;
    // The first Fluid on the input; anything else cabled here draws nothing.
    const field = fields('field').find(isFluidField);
    const image = field?.image();
    const fluid = usable(image) ? image : null;
    const overlays = fields('overlays').filter((o): o is OverlayDrawer => isOverlayDrawer(o) && overlayVisible(o));
    if (!overlays.length) {
      s.shown = fluid;
      return;
    }
    const scale = fluid ? overlayScale(fluid.width, fluid.height) : 1;
    const width = fluid ? fluid.width * scale : OVERLAY_SIZE.width;
    const height = fluid ? fluid.height * scale : OVERLAY_SIZE.height;
    let composed = s.composed;
    if (composed?.width !== width || composed.height !== height) composed = s.composed = { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
    if (fluid) {
      const plan = s.plan;
      if (plan?.width !== fluid.width || plan.height !== fluid.height || plan.scale !== scale) s.plan = planUpscale(fluid.width, fluid.height, scale);
      upscaleInto(fluid, scale, composed, s.plan);
    }
    else fillOpaque(composed.pixels, FLUID_BACKGROUND);
    for (const overlay of overlays) overlay.draw(composed);
    s.shown = composed;
  },
  /** A copy of the last frame's picture, safe to keep. Call it between frames. */
  image(state): NodeImage | null {
    const shown = rendererImage(state);
    return shown ? { width: shown.width, height: shown.height, pixels: shown.pixels.slice() } : null;
  },
};
