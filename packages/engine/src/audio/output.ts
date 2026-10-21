// Borrowed from Flow's output.js. Ours to change; see docs/decisions/0001.
import type { AudioContextLike, AudioNodeLike } from './types';

export const DEFAULT_MASTER_LEVEL = 0.7;
/** Fixed makeup gain (+4.1 dB) ahead of the limiter: no automatic gain riding. */
export const OUTPUT_MAKEUP = 1.6;
/** No sample leaves the Output node above this absolute value. */
export const OUTPUT_CEILING = 0.9;

export function masterLevel(level: unknown): number {
  const value = Number(level);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_MASTER_LEVEL;
}

export interface OutputStage {
  input: AudioNodeLike;
  output: AudioNodeLike;
  setLevel(level: number): void;
}

/** Makeup gain → limiter → peak guard → master level. */
export function createOutputStage(context: AudioContextLike, level = DEFAULT_MASTER_LEVEL): OutputStage {
  const makeup = context.createGain();
  makeup.gain.value = OUTPUT_MAKEUP;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 3;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  // Web Audio's compressor can overshoot on fast attacks. This final guard is
  // exactly linear below the ceiling and catches only remaining sample peaks.
  const guard = context.createWaveShaper();
  const curve = new Float32Array(4097);
  for (let i = 0; i < curve.length; i++) {
    const x = (2 * i) / (curve.length - 1) - 1;
    curve[i] = Math.max(-OUTPUT_CEILING, Math.min(OUTPUT_CEILING, x));
  }
  guard.curve = curve;
  guard.oversample = 'none';
  const master = context.createGain();
  master.gain.value = masterLevel(level);
  makeup.connect(limiter);
  limiter.connect(guard);
  guard.connect(master);
  return {
    input: makeup,
    output: master,
    setLevel(next) {
      master.gain.setTargetAtTime(masterLevel(next), context.currentTime, 0.02);
    },
  };
}
