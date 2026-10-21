import { describe, expect, it } from 'vitest';
import { OUTPUT_CEILING, resolveParams } from '@flow-patcher/engine';
import { output } from '../src';
import { blockLoudness, peak, renderOffline } from '../../../tools/lib/audio';

function render(level: number, gain: number) {
  return renderOffline(0.5, (context) => {
    const instance = output.audio!({ audio: context, params: resolveParams(output, { level }), state: {} });
    const osc = context.createOscillator(), amp = context.createGain();
    amp.gain.value = gain;
    osc.connect(amp);
    amp.connect(instance.inputs!.audio!);
    osc.start(0);
  });
}

describe('output', () => {
  it('reaches the destination and scales with level', async () => {
    const [half, full] = await Promise.all([render(0.5, 0.05), render(1, 0.05)]);
    const ratio = blockLoudness(full, 0.5)[0]! / blockLoudness(half, 0.5)[0]!;
    expect(Math.abs(ratio - 2)).toBeLessThan(0.02);
  });

  it('holds the ceiling on a hot input', async () => {
    expect(peak(await render(1, 10))).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-6);
  });

  it('is silent at level 0', async () => {
    expect(peak(await render(0, 1))).toBe(0);
  });
});
