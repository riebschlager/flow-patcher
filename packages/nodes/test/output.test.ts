import { describe, expect, it } from 'vitest';
import { compilePatch, OUTPUT_CEILING, Runtime, type NodeDefinition, type Patch, type SwapReport } from '@flow-patcher/engine';
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
    let setUpdate: (level: number) => void = () => {};
    const audio = await renderOffline(1, (context) => {
      const instance = output.audio!(audioSetup(output, context, { params: { level: 1 } }));
      const osc = context.createOscillator(), amp = context.createGain();
      amp.gain.value = 0.05;
      osc.connect(amp);
      amp.connect(instance.inputs!.audio!);
      osc.start(0);
      setUpdate = (level) => instance.update!({ level }, 0.5);
    }, { edits: [{ time: 0.4, apply: () => setUpdate(0.5) }], attempts: 3 });
    const blocks = blockLoudness(audio, 0.05);
    const before = blocks[8]!, ramping = blocks[10]!, after = blocks[14]!;
    expect(Math.abs(before / after - 2)).toBeLessThan(0.02);
    // A ramp, not a jump: the first block after the swap time is between the two levels.
    expect(ramping).toBeLessThan(before * 0.95);
    expect(ramping).toBeGreaterThan(after * 1.05);
  });

  it('keeps its instance when a swap edits level through the runtime, and across a seed change (ADR 0035)', async () => {
    let built = 0;
    const counted: NodeDefinition = { ...output, audio: (ctx) => (built++, output.audio!(ctx)) };
    const definitions = new Map([['output', counted]]);
    const patch = (level: number, seed = 1): Patch => ({
      format: 'flowpatch', version: 1, seed,
      nodes: [{ id: 'out', type: 'output', typeVersion: output.version, params: { level }, position: { x: 0, y: 0 } }],
      cables: [],
    });
    const compile = (p: Patch) => {
      const compiled = compilePatch(p, definitions);
      if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
      return compiled.plan;
    };
    const reports: SwapReport[] = [];
    let setSwap: (p: Patch) => void = () => {};
    await renderOffline(1, (context) => {
      built = 0;
      const runtime = new Runtime(compile(patch(1)));
      runtime.attachAudio(context);
      runtime.query(0, 0.5);
      reports.length = 0;
      setSwap = (p) => reports.push(runtime.swap(compile(p), { now: context.currentTime }));
    }, { edits: [{ time: 0.3, apply: () => setSwap(patch(0.5)) }, { time: 0.6, apply: () => setSwap(patch(0.5, 2)) }], attempts: 3 });
    const [level, seed] = reports;
    expect(level!.updated).toEqual(['out']);
    expect(level!.changed).toEqual(['out']);
    expect(level!.cancelled).toBe(0);
    // Output reads no seed (ignoresSeed): a seed change leaves it as it is.
    expect(seed!.updated).toEqual([]);
    expect(seed!.changed).toEqual([]);
    // One instance from attachAudio, none for the level edit or the seed change.
    expect(built).toBe(1);
  });
});
