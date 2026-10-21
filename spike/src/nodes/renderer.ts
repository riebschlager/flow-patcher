import { createFluidColorizer, renderFluidPixels } from '../flow/fluid-renderer.js';
import type { NodeType } from '../registry';
import { stage } from '../stage';
import type { Sim } from './fluid';

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

    const clear = () => {
      const canvas = stage();
      canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    };

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
        ctx.fillStyle = BACKGROUND;
        ctx.fillRect(0, 0, bw, bh);
        const sim = inputs.fields('field')[0] as Sim | undefined;
        if (!sim) return;
        if (ink.width !== sim.w || ink.height !== sim.h || !pixels) {
          ink.width = sim.w;
          ink.height = sim.h;
          pixels = inkCtx.createImageData(sim.w, sim.h);
        }
        renderFluidPixels(sim, pixels.data, performance.now() / 1000, colorize);
        inkCtx.putImageData(pixels, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(ink, 0, 0, bw, bh);
      },
      set() {},
      dispose: clear,
    };
  },
};
