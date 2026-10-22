// Offline audio renders of the Output stage, on a native OfflineAudioContext.
import { describe, expect, it } from 'vitest';
import {
  LIMITER_KNEE,
  LIMITER_RATIO,
  LIMITER_THRESHOLD,
  OUTPUT_CEILING,
  OUTPUT_KNEE,
  compressorMakeup,
  createOutputStage,
  guardCurve,
  guardShape,
  masterLevel,
  type AudioContextLike,
  type AudioNodeLike,
} from '../src';
import { blockLoudness, guardFraction, peak, renderOffline } from '../../../tools/lib/audio';
import { expectGoldenClose } from '../../../test-support/golden';

/** Two detuned oscillators summed at `gain`, through the Output stage at full level (or straight out with `bypass`). */
function tone(gain: number, bypass = false) {
  return (context: AudioContextLike) => {
    const sum = context.createGain();
    sum.gain.value = gain;
    for (const frequency of [220, 331]) {
      const osc = context.createOscillator();
      osc.frequency.value = frequency;
      osc.connect(sum);
      osc.start(0);
    }
    if (bypass) {
      sum.connect(context.destination);
      return;
    }
    const stage = createOutputStage(context, 1);
    sum.connect(stage.input);
    stage.output.connect(context.destination);
  };
}

/** The gate's hot patch: four full-scale saws, summed to ±4, from t = 0 so the onset counts. */
function fourSaws(context: AudioContextLike) {
  const stage = createOutputStage(context, 1);
  for (const frequency of [110, 138.6, 164.8, 220]) {
    const osc = context.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = frequency;
    osc.connect(stage.input);
    osc.start(0);
  }
  stage.output.connect(context.destination);
}

interface ConstantSource extends AudioNodeLike {
  readonly offset: { value: number };
  start(when?: number): void;
}

/** The DynamicsCompressorNode's gain on a DC level far below its threshold: its automatic makeup. */
async function measuredMakeup(threshold: number, knee: number, ratio: number): Promise<number> {
  const level = 1e-3;
  const audio = await renderOffline(
    0.5,
    (context) => {
      const source = (context as unknown as { createConstantSource(): ConstantSource }).createConstantSource();
      source.offset.value = level;
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = threshold;
      compressor.knee.value = knee;
      compressor.ratio.value = ratio;
      source.connect(compressor);
      compressor.connect(context.destination);
      source.start(0);
    },
    { channels: 1 },
  );
  const data = audio.channels[0]!;
  return data[data.length - 1]! / level;
}

const dB = (ratio: number) => 20 * Math.log10(ratio);

describe('Output stage', () => {
  it('Output guard gate: four full-scale saws engage the guard on under 0.1 % of samples and never pass the ceiling', async () => {
    const audio = await renderOffline(2, fourSaws);
    expect(guardFraction(audio, OUTPUT_KNEE)).toBeLessThan(0.001);
    expect(peak(audio)).toBeLessThanOrEqual(OUTPUT_CEILING);
  });

  it('never exceeds the ceiling, however hot the input', async () => {
    const audio = await renderOffline(1, tone(4));
    expect(peak(audio)).toBeLessThanOrEqual(OUTPUT_CEILING);
  });

  it('passes quiet material at unity gain', async () => {
    const [input, output] = await Promise.all([renderOffline(0.5, tone(0.05, true)), renderOffline(0.5, tone(0.05))]);
    const ratio = blockLoudness(output, 0.5)[0]! / blockLoudness(input, 0.5)[0]!;
    expect(Math.abs(ratio - 1)).toBeLessThan(0.01);
  });

  it('matches the golden loudness envelope', async () => {
    const hot = await renderOffline(1, tone(4));
    const quiet = await renderOffline(1, tone(0.05));
    expectGoldenClose('output-loudness', { hot: blockLoudness(hot), quiet: blockLoudness(quiet) }, 1e-3);
  });

  it('coerces master levels', () => {
    expect(masterLevel(2)).toBe(1);
    expect(masterLevel(-1)).toBe(0);
    expect(masterLevel('nope')).toBe(0.7);
  });
});

describe('compressorMakeup', () => {
  it('matches the native compressor for hard knees, the limiter included', async () => {
    for (const [threshold, knee, ratio] of [[LIMITER_THRESHOLD, LIMITER_KNEE, LIMITER_RATIO], [-20, 0, 4], [-6, 0, 10]] as const) {
      expect(knee).toBe(0);
      const measured = await measuredMakeup(threshold, knee, ratio);
      expect(Math.abs(dB(compressorMakeup(threshold, knee, ratio) / measured))).toBeLessThan(0.1);
    }
  });

  it("matches Chrome's makeup for soft knees", () => {
    // Measured in Chromium (Playwright) with a DC probe like measuredMakeup's.
    // node-web-audio-api's knee is quadratic, so its soft-knee makeup differs
    // (1.805 at −12/6/20), which is why the limiter uses a hard knee.
    const chrome: [number, number, number, number][] = [[-3, 3, 20, 1.147535], [-12, 6, 20, 1.934731], [-24, 30, 12, 1.52412]];
    for (const [threshold, knee, ratio, measured] of chrome) {
      expect(Math.abs(dB(compressorMakeup(threshold, knee, ratio) / measured))).toBeLessThan(0.01);
    }
  });
});

describe('guard curve', () => {
  const curve = guardCurve();

  it('is the identity up to the knee', () => {
    for (let i = 0; i < curve.length; i++) {
      const x = (2 * i) / (curve.length - 1) - 1;
      if (Math.abs(x) <= OUTPUT_KNEE) expect(curve[i]).toBe(Math.fround(x));
    }
    expect(curve[(curve.length - 1) / 2]).toBe(0);
  });

  it('rises monotonically, odd-symmetric, and ends below the ceiling', () => {
    for (let i = 1; i < curve.length; i++) expect(curve[i]!).toBeGreaterThan(curve[i - 1]!);
    for (let i = 0; i < curve.length; i++) expect(curve[i]! + curve[curve.length - 1 - i]!).toBe(0);
    expect(curve[curve.length - 1]!).toBeLessThan(OUTPUT_CEILING);
    expect(guardShape(1e6)).toBeLessThanOrEqual(OUTPUT_CEILING);
  });

  it('leaves the knee with slope 1', () => {
    const h = 1e-6;
    expect((guardShape(OUTPUT_KNEE + h) - guardShape(OUTPUT_KNEE)) / h).toBeCloseTo(1, 4);
  });
});
