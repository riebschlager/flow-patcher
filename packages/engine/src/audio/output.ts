// Borrowed from Flow's output.js and reworked for #26: Flow's limiter overshot
// to 1.0–1.3 because Web Audio's compressor adds its own makeup gain, and the
// guard behind it hard-clipped (docs/spike-notes.md, "Output").
//
// Limiter → makeup compensation → soft-knee guard → master level. Material
// below the limiter's threshold passes at unity gain: there is no input makeup,
// and a fixed gain of 1/makeup cancels the compressor's automatic makeup. The
// guard is exactly linear up to OUTPUT_KNEE and bends smoothly towards
// OUTPUT_CEILING above it, so no sample leaves the stage above the ceiling.
import { EDIT_RAMP, rampParam } from './automation';
import type { AudioContextLike, AudioNodeLike } from './types';

export const DEFAULT_MASTER_LEVEL = 0.7;
/** No sample leaves the Output node above this absolute value. */
export const OUTPUT_CEILING = 0.9;
/** The guard is exactly linear up to this absolute value and bends above it. */
export const OUTPUT_KNEE = 0.75;

/** Limiter settings (dB, dB, ratio, seconds, seconds). A 1 ms attack keeps a hot onset under the guard's knee. */
export const LIMITER_THRESHOLD = -9;
/**
 * Hard knee. The spec leaves the knee's shape to the user agent: browsers use
 * WebKit's exponential knee, node-web-audio-api a quadratic one, and their
 * automatic makeup differs by 0.6 dB at a 6 dB knee. With no knee every
 * implementation has the same curve, so the compensation below gives unity
 * gain everywhere.
 */
export const LIMITER_KNEE = 0;
export const LIMITER_RATIO = 20;
export const LIMITER_ATTACK = 0.001;
export const LIMITER_RELEASE = 0.25;

/** Samples in the guard's curve, spanning input -1..1. Odd, so 0 maps to 0 exactly. */
const GUARD_POINTS = 4097;

export function masterLevel(level: unknown): number {
  const value = Number(level);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_MASTER_LEVEL;
}

const dbToLinear = (db: number): number => 10 ** (db / 20);
const linearToDb = (x: number): number => 20 * Math.log10(x);

/**
 * The gain Web Audio's DynamicsCompressorNode adds on its own: its static
 * curve evaluated at 0 dBFS gives fullRangeGain, and the makeup is
 * (1 / fullRangeGain)^0.6 (Web Audio spec, "Computing the makeup gain"). The
 * knee's shape is up to the user agent; this follows WebKit's (and Chromium's
 * and Firefox's) DynamicsCompressorKernel: linearThreshold +
 * (1 − e^(−k(x − linearThreshold)))/k, with k searched so the curve's slope at
 * the knee's end is 1/ratio. node-web-audio-api's knee is quadratic, so for a
 * knee above 0 dB this matches browsers, not headless runs.
 */
export function compressorMakeup(threshold: number, knee: number, ratio: number): number {
  const linearThreshold = dbToLinear(threshold);
  const slope = 1 / ratio;
  const kneeEndDb = threshold + knee;
  const kneeCurve = (x: number, k: number) => (x < linearThreshold ? x : linearThreshold + (1 - Math.exp(-k * (x - linearThreshold))) / k);
  const slopeAt = (x: number, k: number) => {
    if (x < linearThreshold) return 1;
    const x2 = x * 1.001;
    return (linearToDb(kneeCurve(x2, k)) - linearToDb(kneeCurve(x, k))) / (linearToDb(x2) - linearToDb(x));
  };
  // Chromium's search: 15 geometric bisections of k in [0.1, 10000], starting at 5.
  const kneeEnd = dbToLinear(kneeEndDb);
  let minK = 0.1, maxK = 10000, k = 5;
  for (let i = 0; i < 15; i++) {
    if (slopeAt(kneeEnd, k) < slope) maxK = k;
    else minK = k;
    k = Math.sqrt(minK * maxK);
  }
  // The static curve at 1.0 (0 dBFS): the knee curve below the knee's end, constant ratio after it.
  // With no knee the curve meets the threshold exactly, whatever k is.
  const fullRangeGainDb = 1 < kneeEnd
    ? linearToDb(kneeCurve(1, k))
    : linearToDb(kneeCurve(kneeEnd, k)) + slope * (0 - kneeEndDb);
  return dbToLinear(-fullRangeGainDb) ** 0.6;
}

/**
 * The guard's shaping function: the identity up to `knee`, then
 * knee + (ceiling − knee)·tanh((|x| − knee)/(ceiling − knee)), odd-symmetric.
 * It meets the identity with slope 1 at the knee and stays below the ceiling.
 */
export function guardShape(x: number, knee = OUTPUT_KNEE, ceiling = OUTPUT_CEILING): number {
  const magnitude = Math.abs(x);
  if (magnitude <= knee) return x;
  const span = ceiling - knee;
  return Math.sign(x) * (knee + span * Math.tanh((magnitude - knee) / span));
}

/** The guard's WaveShaper curve over input -1..1. WaveShaper holds the end values for input outside ±1. */
export function guardCurve(points = GUARD_POINTS): Float32Array {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) curve[i] = guardShape((2 * i) / (points - 1) - 1);
  return curve;
}

export interface OutputStage {
  input: AudioNodeLike;
  output: AudioNodeLike;
  /** Ramps the master level to `level` from audio-clock `time` (default now), never jumping. */
  setLevel(level: number, time?: number): void;
}

/** Limiter → makeup compensation → soft-knee guard → master level. */
export function createOutputStage(context: AudioContextLike, level = DEFAULT_MASTER_LEVEL): OutputStage {
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = LIMITER_THRESHOLD;
  limiter.knee.value = LIMITER_KNEE;
  limiter.ratio.value = LIMITER_RATIO;
  limiter.attack.value = LIMITER_ATTACK;
  limiter.release.value = LIMITER_RELEASE;
  // Cancels the compressor's automatic makeup, so quiet material passes at unity.
  const compensation = context.createGain();
  compensation.gain.value = 1 / compressorMakeup(LIMITER_THRESHOLD, LIMITER_KNEE, LIMITER_RATIO);
  // The compressor can still overshoot on a fast onset; the guard bends what
  // gets past the knee and never reaches the ceiling.
  const guard = context.createWaveShaper();
  guard.curve = guardCurve();
  guard.oversample = 'none';
  const master = context.createGain();
  master.gain.value = masterLevel(level);
  /** The latest level edit's ramp (EDIT_RAMP long), so the next edit starts from where the gain is. */
  let ramp = { from: masterLevel(level), to: masterLevel(level), start: -Infinity };
  limiter.connect(compensation);
  compensation.connect(guard);
  guard.connect(master);
  return {
    input: limiter,
    output: master,
    setLevel(next, time = context.currentTime) {
      // Where the level is at `time`, partway along an earlier edit's ramp if that is still running.
      const along = Math.min(1, Math.max(0, (time - ramp.start) / EDIT_RAMP));
      const from = ramp.from + (ramp.to - ramp.from) * along;
      ramp = { from, to: masterLevel(next), start: time };
      rampParam(master.gain, from, ramp.to, time);
    },
  };
}
