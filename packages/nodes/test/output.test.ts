import { describe, expect, it } from 'vitest';
import { OUTPUT_CEILING } from '@flow-patcher/engine';
import { output } from '../src';
import { blockLoudness, peak, renderOffline } from '../../../tools/lib/audio';
import { audioSetup } from './helpers';

function render(level: number, gain: number) {
  return renderOffline(0.5, (context) => {
    const instance = output.audio!(audioSetup(output, context, { params: { level } }));
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

  it('takes a level edit in place and ramps to it from the swap time (ADR 0031)', async () => {
    expect(output.liveParams).toEqual(['level']);
    let instances = 0;
    const audio = await renderOffline(1, (context) => {
      const instance = output.audio!(audioSetup(output, context, { params: { level: 1 } }));
      instances++;
      const osc = context.createOscillator(), amp = context.createGain();
      amp.gain.value = 0.05;
      osc.connect(amp);
      amp.connect(instance.inputs!.audio!);
      osc.start(0);
      setUpdate = (level) => instance.update!({ level }, 0.5);
    }, { edits: [{ time: 0.4, apply: () => setUpdate(0.5) }] });
    const blocks = blockLoudness(audio, 0.05);
    const before = blocks[8]!, ramping = blocks[10]!, after = blocks[14]!;
    expect(instances).toBe(1);
    expect(Math.abs(before / after - 2)).toBeLessThan(0.02);
    // A ramp, not a jump: the first block after the swap time is between the two levels.
    expect(ramping).toBeLessThan(before * 0.95);
    expect(ramping).toBeGreaterThan(after * 1.05);
  });
});
let setUpdate: (level: number) => void = () => {};
