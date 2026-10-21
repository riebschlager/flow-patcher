import { ramp } from '../audio';
import type { NodeType } from '../registry';
import { recordSunk, stats } from '../stats';

/** Placeholder event-to-audio voice: a short triangle blip per event, until Sampled Voice lands. */
export const blip: NodeType = {
  type: 'blip',
  label: 'Blip',
  inputs: [{ name: 'in', label: 'In', type: 'event' }],
  outputs: [{ name: 'out', label: 'Out', type: 'audio' }],
  knobs: [
    { name: 'pitch', label: 'Pitch', min: 100, max: 4000, default: 880, curve: 'log', unit: 'Hz' },
    { name: 'decay', label: 'Decay', min: 0.01, max: 1, default: 0.08, curve: 'log', unit: 's' },
    { name: 'level', label: 'Level', min: 0, max: 1, default: 0.4 },
  ],
  create(ctx) {
    const out = new GainNode(ctx, { gain: 0.4 });
    let pitch = 880, decay = 0.08;
    return {
      outputs: { out },
      query(_t0, _t1, inputs) {
        for (const event of inputs.events('in')) {
          let when = event.time;
          if (when < ctx.currentTime) {
            stats.late++;
            console.log('[spike] late event', (ctx.currentTime - when).toFixed(4), 's');
            when = ctx.currentTime;
          }
          recordSunk(when);
          const osc = new OscillatorNode(ctx, { type: 'triangle', frequency: pitch });
          const env = new GainNode(ctx, { gain: 0 });
          env.gain.setValueAtTime(0, when);
          env.gain.linearRampToValueAtTime(1, when + 0.002);
          env.gain.setTargetAtTime(0, when + 0.002, decay / 3);
          osc.connect(env).connect(out);
          osc.start(when);
          osc.stop(when + decay * 2 + 0.05);
          osc.onended = () => env.disconnect();
        }
      },
      set(knob, value) {
        if (knob === 'pitch') pitch = value;
        if (knob === 'decay') decay = value;
        if (knob === 'level') ramp(out.gain, value);
      },
      dispose() {
        out.disconnect();
      },
    };
  },
};
