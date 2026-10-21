import { canonicalDyes, getPalette } from '../flow/palettes.js';
import { menu } from '../menu';
import type { NodeType, SpikeEvent } from '../registry';
import { stats } from '../stats';
import type { FieldWriter } from './fluid';

const MAX_PENDING = 256; // the per-node event budget
const STALE = 0.25; // seconds; events this far behind the frame (a hidden tab) are dropped, not splashed at once

/**
 * Dye and impulse at each event's position and time. Events arrive with the scheduler's lookahead (or 10 ms
 * ahead, from the canvas) and wait here until the Fluid's frame reaches their time.
 */
export const splat: NodeType = {
  type: 'splat',
  label: 'Splat',
  inputs: [{ name: 'at', label: 'At', type: 'event' }],
  outputs: [{ name: 'write', label: 'Write', type: 'field' }],
  knobs: [
    // Flow's drop size, .018 + dropSize% × .06.
    { name: 'size', label: 'Size', min: 0.01, max: 0.08, default: 0.035 },
    menu('color', 'Color', getPalette('classic').colors.map((c: { name: string }) => c.name)),
    // Where events without x/y land.
    { name: 'x', label: 'X', min: 0, max: 1, default: 0.5 },
    { name: 'y', label: 'Y', min: 0, max: 1, default: 0.5 },
  ],
  create() {
    const knobs = { size: 0.035, color: 0, x: 0.5, y: 0.5 };
    let pending: SpikeEvent[] = [];
    const write: FieldWriter = (sim, t) => {
      const due = pending.filter((e) => e.time < t);
      if (!due.length) return;
      pending = pending.filter((e) => e.time >= t);
      const dye = canonicalDyes[knobs.color] as number[];
      for (const e of due) {
        if (e.time < t - STALE) continue;
        const lag = (t - e.time) * 1000;
        stats.splatLag.count++;
        stats.splatLag.total += lag;
        stats.splatLag.max = Math.max(stats.splatLag.max, lag);
        const x = typeof e.x === 'number' ? e.x : knobs.x;
        const y = typeof e.y === 'number' ? e.y : knobs.y;
        const velocity = typeof e.velocity === 'number' ? e.velocity : 1;
        // A landing drop's push, Flow's [±7, 13–25] without the randomness.
        sim.splat(x, y, dye.map((c) => c * velocity), knobs.size, 0, 19);
      }
    };
    return {
      fields: { write },
      query(_t0, _t1, inputs) {
        pending.push(...inputs.events('at'));
        if (pending.length > MAX_PENDING) {
          console.log(`[spike] Splat dropped ${pending.length - MAX_PENDING} events over the budget`);
          pending = pending.slice(-MAX_PENDING);
        }
      },
      set(knob, value) {
        if (knob in knobs) knobs[knob as keyof typeof knobs] = value;
      },
      dispose() {},
    };
  },
};
