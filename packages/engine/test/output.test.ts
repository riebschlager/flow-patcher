// Offline audio renders of the Output stage, on a native OfflineAudioContext.
import { describe, expect, it } from 'vitest';
import { OUTPUT_CEILING, createOutputStage, masterLevel, type AudioContextLike } from '../src';
import { blockLoudness, peak, renderOffline } from '../../../tools/lib/audio';
import { expectGoldenClose } from '../../../test-support/golden';

/** Two detuned oscillators at `gain` through the Output stage at full level. */
function tone(gain: number) {
  return (context: AudioContextLike) => {
    const stage = createOutputStage(context, 1);
    const sum = context.createGain();
    sum.gain.value = gain;
    for (const frequency of [220, 331]) {
      const osc = context.createOscillator();
      osc.frequency.value = frequency;
      osc.connect(sum);
      osc.start(0);
    }
    sum.connect(stage.input);
    stage.output.connect(context.destination);
  };
}

describe('Output stage', () => {
  it('never exceeds the ceiling, however hot the input', async () => {
    const audio = await renderOffline(1, tone(4));
    expect(peak(audio)).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-6);
  });

  it('is linear for quiet material', async () => {
    // The compressor adds its own fixed makeup gain, so compare two quiet levels
    // rather than input against output.
    const [soft, louder] = await Promise.all([renderOffline(0.5, tone(0.01)), renderOffline(0.5, tone(0.02))]);
    const ratio = blockLoudness(louder, 0.5)[0]! / blockLoudness(soft, 0.5)[0]!;
    expect(Math.abs(ratio - 2)).toBeLessThan(0.02);
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
