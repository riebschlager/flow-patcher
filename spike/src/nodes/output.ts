import { ramp } from '../audio';
import { createOutputStage, DEFAULT_MASTER_VOLUME, masterLevel, OUTPUT_CEILING } from '../flow/output.js';
import type { NodeType } from '../registry';

export { OUTPUT_CEILING };

/**
 * Flow's output stage: In → makeup → limiter → peak guard → master level → speakers.
 * One meter taps after the master gain, so it reads what reaches the speakers; that can't pass the
 * ceiling. The other taps the limiter, before the guard: above the ceiling there, the guard is clipping.
 */
export const output: NodeType = {
  type: 'output',
  label: 'Output',
  unique: true,
  inputs: [{ name: 'in', label: 'In', type: 'audio' }],
  outputs: [],
  knobs: [{ name: 'level', label: 'Level', min: 0, max: 100, default: DEFAULT_MASTER_VOLUME, step: 1, unit: '%' }],
  create(ctx) {
    const input = new GainNode(ctx);
    const master = new GainNode(ctx, { gain: masterLevel(DEFAULT_MASTER_VOLUME) });
    const stage = createOutputStage(ctx, input, master);
    master.connect(ctx.destination);
    const taps = { speakers: tap(ctx, master), preGuard: tap(ctx, stage.limiter) };
    meter = taps;
    return {
      inputs: { in: input },
      set(knob, value) {
        if (knob === 'level') ramp(master.gain, masterLevel(value));
      },
      dispose() {
        for (const n of [input, stage.makeup, stage.limiter, stage.guard, master, taps.speakers.splitter, taps.preGuard.splitter]) n.disconnect();
        if (meter === taps) meter = null;
      },
    };
  },
};

/**
 * Per-channel analysers on a node: one fed the stereo bus would downmix it and understate a one-sided peak.
 * 32,768 samples (about 0.7 s) is longer than the meter's poll interval, so every sample gets read.
 */
function tap(ctx: AudioContext, node: AudioNode) {
  const splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  const channels = [0, 1].map((ch) => {
    const a = new AnalyserNode(ctx, { fftSize: 32768 });
    splitter.connect(a, ch);
    return a;
  });
  node.connect(splitter);
  return { splitter, channels };
}

// The meters of the patch's one Output.
let meter: { speakers: ReturnType<typeof tap>; preGuard: ReturnType<typeof tap> } | null = null;
const buf = new Float32Array(32768);

/** RMS of the louder channel and sample peak over the last ~0.7 s; the louder channel so mono isn't read 3 dB low. */
function read({ channels }: ReturnType<typeof tap>) {
  let level = 0, peak = 0;
  for (const a of channels) {
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) {
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    level = Math.max(level, Math.sqrt(sum / buf.length));
  }
  return { level, peak };
}

/** What reaches the speakers, plus the limiter's peak before the guard; all 0 without an Output. */
export function readOutput() {
  if (!meter) return { level: 0, peak: 0, preGuard: 0 };
  return { ...read(meter.speakers), preGuard: read(meter.preGuard).peak };
}

export const outputLevel = () => readOutput().level;
