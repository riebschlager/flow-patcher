import { describe, expect, it } from 'vitest';
import type { AudioContextLike, AudioInstance } from '@flow-patcher/engine';
import { mixer, MIXER_INPUTS } from '../src/mixer';
import { maxDifference, renderOffline, RENDER_TOLERANCE, type RenderedAudio } from '../../../tools/lib/audio';
import { audioSetup, busRms, sine, swapRun, type ContextOptions } from './helpers';

const SINE = 0.5 / Math.SQRT2;

/**
 * A Mixer with a hard-left 440 Hz sine on In 1 and a hard-right 660 Hz sine on In 3, so each
 * output channel shows one input's level; In 2 and In 4 stay empty.
 */
function build(context: AudioContextLike, options: ContextOptions = {}): AudioInstance {
  const instance = mixer.audio!(audioSetup(mixer, context, options));
  sine(context, 440, 0.5, -1).connect(instance.inputs!.in1!);
  sine(context, 660, 0.5, 1).connect(instance.inputs!.in3!);
  instance.outputs!.out!.connect(context.destination);
  return instance;
}

/** In 1's and In 3's levels at the output over [t, t + width), relative to the input sine. */
const sides = (audio: RenderedAudio, t: number, width = 0.2) => [busRms(audio, t, width, 0) / SINE, busRms(audio, t, width, 1) / SINE];
const render = (options: ContextOptions) => renderOffline(0.3, (context) => build(context, options).automate!(0, 0.3));
const close = (values: number[], expected: number[], digits = 3) => expect(values).toEqual(expected.map((v) => expect.closeTo(v, digits)));

describe('mixer', () => {
  it('has four inputs, each with a level, and a master level', () => {
    expect(mixer.ports.filter((p) => p.direction === 'in').map((p) => p.name)).toEqual(['in1', 'in2', 'in3', 'in4']);
    expect(MIXER_INPUTS).toBe(4);
    expect(mixer.liveParams).toEqual(['level1', 'level2', 'level3', 'level4', 'master']);
  });

  it('sums its inputs, each at its own level, through the master level', async () => {
    const [unity, levels, master] = await Promise.all([
      render({}),
      render({ params: { level1: 0.5, level3: 1.5 } }),
      render({ params: { level1: 0.5, level3: 1.5, master: 0.5 } }),
    ]);
    close(sides(unity, 0.1), [1, 1]);
    close(sides(levels, 0.1), [0.5, 1.5]);
    close(sides(master, 0.1), [0.25, 0.75]);
  });

  it('sums two buses on one input and two inputs on one channel', async () => {
    const audio = await renderOffline(0.3, (context) => {
      const instance = mixer.audio!(audioSetup(mixer, context, { params: { level2: 0.5, level4: 0.25 } }));
      // Two sines, a fifth apart, so their RMS adds as power: on In 2 together, then a third on In 4.
      sine(context, 440).connect(instance.inputs!.in2!);
      sine(context, 660).connect(instance.inputs!.in2!);
      sine(context, 990).connect(instance.inputs!.in4!);
      instance.outputs!.out!.connect(context.destination);
    });
    expect(busRms(audio, 0.1, 0.2, 0) / SINE).toBeCloseTo(Math.hypot(0.5, 0.5, 0.25), 2);
  });

  it('follows cabled levels and master in automate', async () => {
    // In 1 fades out over the second, In 3 holds; master dips to 0.5 after 0.5 s.
    const mods = { level1: [{ depth: -1, signal: (t: number) => t }], master: [{ depth: -0.5, signal: (t: number) => (t >= 0.5 ? 1 : 0) }] };
    const audio = await renderOffline(1, (context) => build(context, { mods }).automate!(0, 1));
    close(sides(audio, 0.24, 0.02), [0.75, 1], 1);
    close(sides(audio, 0.74, 0.02), [0.125, 0.5], 1);
    expect(sides(audio, 0.96, 0.03)[0]).toBeLessThan(0.05);
  });

  it('gives the same audio however automate is split, and after a re-run over a stretch already covered', async () => {
    const mods = {
      level3: [{ depth: 0.8, signal: (t: number) => Math.sin(2 * Math.PI * 2 * t) }],
      master: [{ depth: -0.4, signal: (t: number) => t }],
    };
    const renderCalls = (calls: [number, number][]) =>
      renderOffline(1, (context) => {
        const instance = build(context, { mods });
        for (const [t0, t1] of calls) instance.automate!(t0, t1);
      });
    const [one, split, rerun] = await Promise.all([renderCalls([[0, 1]]), renderCalls([[0, 0.45], [0.45, 0.46], [0.46, 1]]), renderCalls([[0, 0.8], [0.2, 0.8], [0.8, 1], [0.85, 1]])]);
    expect(maxDifference(one, split)).toBeLessThan(RENDER_TOLERANCE);
    expect(maxDifference(one, rerun)).toBeLessThan(RENDER_TOLERANCE);
  });

  it('clamps levels and modulation to their range and falls back to the defaults for NaN', async () => {
    const [nan, out, mods] = await Promise.all([
      render({ params: { level1: NaN, master: NaN } }),
      render({ params: { level1: -3, level3: 1e9 } }),
      render({ params: { level1: 1 }, mods: { level1: [{ depth: 1e300, signal: () => 1e300 }], level3: [{ depth: 1, signal: () => NaN }], master: [{ depth: -5, signal: () => 1 }] } }),
    ]);
    close(sides(nan, 0.1), [1, 1]);
    close(sides(out, 0.1), [0, 2]);
    // Master pushed below 0 sits at 0: silent, not inverted.
    close(sides(mods, 0.1), [0, 0]);
  });

  it('ramps a level edit in place from the swap time, leaving the other inputs alone', async () => {
    let edit: () => void = () => {};
    const audio = await renderOffline(1, (context) => {
      const instance = build(context);
      edit = () => instance.update!({ level1: 0, level2: 1, level3: 1, level4: 1, master: 1 }, 0.5);
    }, { edits: [{ time: 0.4, apply: () => edit() }], attempts: 3 });
    close(sides(audio, 0.4, 0.1), [1, 1]);
    close(sides(audio, 0.6, 0.1), [0, 1]);
    // Halfway through the 20 ms ramp, about halfway down; In 3 never moves (4 ms isn't a whole
    // number of its periods, hence the looser bound).
    const [mid, other] = sides(audio, 0.508, 0.004);
    expect(mid).toBeGreaterThan(0.35);
    expect(mid).toBeLessThan(0.65);
    expect(Math.abs(other! - 1)).toBeLessThan(0.02);
    expect(sides(audio, 0.5, 1 / 33)[1]).toBeCloseTo(1, 3);
  });

  it('keeps its instance for level and master edits through the runtime', async () => {
    const { reports, built } = await swapRun(mixer, [{}, { level2: 0.4 }, { level2: 0.4, master: 1.6 }]);
    expect(reports.map((r) => r.updated)).toEqual([['n'], ['n']]);
    expect(built).toBe(1);
  });
});
