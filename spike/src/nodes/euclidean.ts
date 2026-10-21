import { rotatePattern } from '../flow/rhythm.js';
import type { NodeType, SpikeEvent } from '../registry';

/**
 * Flow's euclidean(), which is fixed at 16 steps, for any step count: hit i when (i × hits) mod steps < hits,
 * downbeats (every 4th step) accented.
 */
const pattern = (hits: number, steps: number, rotate: number): number[] =>
  rotatePattern(Array.from({ length: steps }, (_, i) => ((i * hits) % steps < hits ? (i % 4 === 0 ? 1 : 0.65) : 0)), rotate);

/**
 * Passes the ticks that land on a hit. A tick's place in the pattern is its absolute step number mod Steps,
 * so the rhythm doesn't depend on window edges, and a knob change applies from the next window on.
 */
export const euclidean: NodeType = {
  type: 'euclidean',
  label: 'Euclidean',
  inputs: [{ name: 'tick', label: 'Tick', type: 'event' }],
  outputs: [{ name: 'hit', label: 'Hit', type: 'event' }],
  knobs: [
    { name: 'hits', label: 'Hits', min: 0, max: 32, default: 5, step: 1 },
    { name: 'steps', label: 'Steps', min: 1, max: 32, default: 16, step: 1 },
    { name: 'rotate', label: 'Rotate', min: 0, max: 31, default: 0, step: 1 },
  ],
  create() {
    const knobs = { hits: 5, steps: 16, rotate: 0 };
    let warned = false;
    return {
      query(_t0, _t1, inputs) {
        const steps = Math.round(knobs.steps);
        const levels = pattern(Math.min(Math.round(knobs.hits), steps), steps, knobs.rotate);
        const hit: SpikeEvent[] = [];
        for (const tick of inputs.events('tick')) {
          if (typeof tick.step !== 'number') {
            if (!warned) console.log('[spike] ticks dropped: Euclidean needs Clock ticks, which carry a step number');
            warned = true;
            continue;
          }
          const level = levels[((tick.step % steps) + steps) % steps];
          if (level > 0) hit.push({ ...tick, velocity: level });
        }
        return { hit };
      },
      set(knob, value) {
        if (knob in knobs) knobs[knob as keyof typeof knobs] = value;
      },
      dispose() {},
    };
  },
};
