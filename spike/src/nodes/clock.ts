import type { NodeType, SpikeEvent } from '../registry';

/**
 * Ticks at BPM × division per beat, computed from absolute audio time: tick k sits at origin + k × period,
 * odd ticks pushed late by swing. Knob changes wait for the next window and keep the phase, so the beat never jumps.
 */
export const clock: NodeType = {
  type: 'clock',
  label: 'Clock',
  inputs: [],
  outputs: [
    { name: 'tick', label: 'Tick', type: 'event' },
    { name: 'phase', label: 'Phase', type: 'signal' },
  ],
  knobs: [
    { name: 'bpm', label: 'BPM', min: 40, max: 240, default: 120, step: 1 },
    { name: 'division', label: 'Div', min: 1, max: 8, default: 4, step: 1, unit: '/beat' },
    { name: 'swing', label: 'Swing', min: 0, max: 1, default: 0 },
  ],
  create() {
    const knobs = { bpm: 120, division: 4, swing: 0 };
    let pending = { ...knobs };
    let origin = 0; // ticks are counted from audio time 0 until a tempo change re-anchors them
    let period = 60 / knobs.bpm / knobs.division;
    let lastStep = -Infinity; // guards against re-emitting a tick that moved across a window edge
    // beat = beatBase + (k - stepBase) / division; re-anchored on a Div change so the beat count carries on.
    let beatBase = 0, stepBase = 0;

    const timeOf = (k: number) => origin + k * period + (k % 2 !== 0 ? knobs.swing * period * 0.5 : 0);

    return {
      query(t0, t1) {
        const next = 60 / pending.bpm / pending.division;
        if (next !== period) {
          // Keep the phase at t0 so tick numbering carries on at the new tempo.
          const steps = (t0 - origin) / period;
          if (pending.division !== knobs.division) {
            beatBase += (steps - stepBase) / knobs.division;
            stepBase = steps;
          }
          origin = t0 - steps * next;
          period = next;
        }
        // A swing change waits for an even step: moving an unplayed odd tick earlier could put it before t0 and drop it.
        const nextOdd = Number.isFinite(lastStep) && (lastStep + 1) % 2 !== 0;
        Object.assign(knobs, { ...pending, swing: nextOdd ? knobs.swing : pending.swing });
        const tick: SpikeEvent[] = [];
        for (let k = Math.floor((t0 - origin) / period) - 1; k <= Math.ceil((t1 - origin) / period); k++) {
          const time = timeOf(k);
          if (time >= t0 && time < t1 && k > lastStep) {
            // beat lets Progression count beats across tempo and Div changes. Rounded, because re-anchoring
            // leaves float drift (5.99999…) that would move a chord change one tick late.
            const beat = Math.round((beatBase + (k - stepBase) / knobs.division) * 1e6) / 1e6;
            tick.push({ time, step: k, beat });
            lastStep = k;
          }
        }
        return { tick };
      },
      signals: {
        phase: (t) => (((t - origin) / period) % 1 + 1) % 1,
      },
      set(knob, value) {
        pending = { ...pending, [knob]: value };
      },
      dispose() {},
    };
  },
};
