import { ramp } from './audio';

// The spike's node registry. Each node type declares its ports and knobs and
// builds its own Web Audio graph. Later M0 tasks add their nodes to `registry`.

export type PortDef = { name: string; label: string };
export type KnobDef = { name: string; label: string; min: number; max: number; default: number; curve?: 'lin' | 'log'; unit?: string };

export type Instance = {
  inputs: Record<string, AudioNode>;
  outputs: Record<string, AudioNode>;
  /** Set a knob's value live; implementations ramp, never jump. */
  set(knob: string, value: number): void;
  dispose(): void;
};

export type NodeType = {
  type: string;
  label: string;
  inputs: PortDef[];
  outputs: PortDef[];
  knobs: KnobDef[];
  create(ctx: AudioContext): Instance;
};

/** Placeholder sound source until the real instruments land. */
const tone: NodeType = {
  type: 'tone',
  label: 'Tone',
  inputs: [],
  outputs: [{ name: 'out', label: 'Out' }],
  knobs: [
    { name: 'pitch', label: 'Pitch', min: 40, max: 2000, default: 220, curve: 'log', unit: 'Hz' },
    { name: 'level', label: 'Level', min: 0, max: 1, default: 0.3 },
  ],
  create(ctx) {
    const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: 220 });
    const gain = new GainNode(ctx, { gain: 0.3 });
    osc.connect(gain);
    osc.start();
    return {
      inputs: {},
      outputs: { out: gain },
      set(knob, value) {
        if (knob === 'pitch') ramp(osc.frequency, value);
        if (knob === 'level') ramp(gain.gain, value);
      },
      dispose() {
        osc.stop();
        osc.disconnect();
        gain.disconnect();
      },
    };
  },
};

/** Master gain to the speakers. The analyser feeds the debug level meter (window.spike.level()). */
const output: NodeType = {
  type: 'output',
  label: 'Output',
  inputs: [{ name: 'in', label: 'In' }],
  outputs: [],
  knobs: [{ name: 'level', label: 'Level', min: 0, max: 1, default: 0.5 }],
  create(ctx) {
    const gain = new GainNode(ctx, { gain: 0.5 });
    gain.connect(ctx.destination);
    gain.connect(analyser(ctx));
    return {
      inputs: { in: gain },
      outputs: {},
      set(knob, value) {
        if (knob === 'level') ramp(gain.gain, value);
      },
      dispose() {
        gain.disconnect();
      },
    };
  },
};

export const registry: NodeType[] = [tone, output];
export const nodeType = (type: string) => registry.find((t) => t.type === type)!;

// One analyser shared by every Output node, so the spike can report whether sound is flowing.
let meter: AnalyserNode | null = null;
function analyser(ctx: AudioContext) {
  return (meter ??= new AnalyserNode(ctx, { fftSize: 2048 }));
}

/** RMS of what reaches the Output nodes, 0 when nothing does. */
export function outputLevel() {
  if (!meter) return 0;
  const buf = new Float32Array(meter.fftSize);
  meter.getFloatTimeDomainData(buf);
  return Math.sqrt(buf.reduce((sum, v) => sum + v * v, 0) / buf.length);
}
