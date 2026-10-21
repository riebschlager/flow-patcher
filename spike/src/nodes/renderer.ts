import { createFluidColorizer, renderFluidPixels } from '../flow/fluid-renderer.js';
import type { NodeType } from '../registry';
import { dyeOf, FluidProxy } from './fluid';
import { stage } from '../stage';
import { recordRender, stats } from '../stats';

const BACKGROUND = '#070b11'; // Flow's canvas fill

/** Flow's Canvas2D renderer: the Field's dye, colored with the classic palette, drawn into the performance canvas. */
export const renderer: NodeType = {
  type: 'renderer',
  label: 'Renderer',
  unique: true,
  inputs: [{ name: 'field', label: 'Field', type: 'field' }],
  outputs: [],
  knobs: [],
  create() {
    const colorize = createFluidColorizer('classic');
    const ink = document.createElement('canvas');
    const inkCtx = ink.getContext('2d')!;
    let pixels: ImageData | null = null;

    return {
      frame(_t0, _t1, _dt, inputs) {
        const canvas = stage();
        const ctx = canvas?.getContext('2d', { alpha: false });
        if (!canvas || !ctx) return;
        // From Flow's resize(): the backing store follows the CSS size, capped at 1.7× DPR.
        const { width, height } = canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 1.7);
        const bw = Math.round(width * dpr), bh = Math.round(height * dpr);
        if (canvas.width !== bw || canvas.height !== bh) {
          canvas.width = bw;
          canvas.height = bh;
        }
        // Splat's Write is a Field too, so it can be cabled here; only a Fluid draws.
        // The worker path arrives colored; the main-thread path (?fluid=main) is colored here.
        const fields = inputs.fields('field');
        const colored = fields.find((f): f is FluidProxy => f instanceof FluidProxy)?.image;
        const sim = colored ? null : fields.map(dyeOf).find((d) => d !== null);
        const start = performance.now();
        if (!colored && !sim) {
          ctx.fillStyle = BACKGROUND;
          ctx.fillRect(0, 0, bw, bh);
          return;
        }
        const { w, h } = (colored ?? sim)!;
        if (ink.width !== w || ink.height !== h) {
          ink.width = w;
          ink.height = h;
        }
        if (colored) {
          // Wraps the worker's buffer without copying; it goes back to the worker with the next step.
          inkCtx.putImageData(new ImageData(colored.pixels as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
        } else {
          if (pixels?.width !== w || pixels.height !== h) pixels = inkCtx.createImageData(w, h);
          renderFluidPixels(sim, pixels.data, performance.now() / 1000, colorize);
          inkCtx.putImageData(pixels, 0, 0);
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(ink, 0, 0, bw, bh);
        const ms = performance.now() - start;
        stats.render.count++;
        stats.render.total += ms;
        stats.render.max = Math.max(stats.render.max, ms);
        recordRender(ms);
      },
      set() {},
      // Nothing to clear: the next Renderer, or none, owns the canvas from the next frame.
      dispose() {},
    };
  },
};
