import { describe, expect, it } from 'vitest';
import type { AudioContextLike, AudioInstance } from '@flow-patcher/engine';
import { gain } from '../src/gain';
import { maxDifference, peak, renderOffline, RENDER_TOLERANCE } from '../../../tools/lib/audio';
import { audioSetup, busRms, sine, swapRun, type ContextOptions } from './helpers';

const SINE = 0.5 / Math.SQRT2;

/** A Gain fed a 440 Hz sine (or a hard-panned pair, 0.5 left and 0.25 right), into the destination. */
function build(context: AudioContextLike, options: ContextOptions = {}, stereo = false): AudioInstance {
  const instance = gain.audio!(audioSetup(gain, context, options));
  if (stereo) {
    sine(context, 440, 0.5, -1).connect(instance.inputs!.in!);
    sine(context, 660, 0.25, 1).connect(instance.inputs!.in!);
  } else sine(context, 440).connect(instance.inputs!.in!);
  instance.outputs!.out!.connect(context.destination);
  return instance;
}

const level = async (options: ContextOptions) => busRms(await renderOffline(0.3, (context) => build(context, options).automate!(0, 0.3)), 0.1, 0.2);

describe('gain', () => {
  it('scales the bus by its knob, unity by default', async () => {
    const [unity, half, double, zero] = await Promise.all([level({}), level({ params: { gain: 0.5 } }), level({ params: { gain: 2 } }), level({ params: { gain: 0 } })]);
    expect(unity / SINE).toBeCloseTo(1, 3);
    expect(half / SINE).toBeCloseTo(0.5, 3);
    expect(double / SINE).toBeCloseTo(2, 3);
    expect(zero).toBe(0);
  });

  it('scales both channels of a stereo bus alike, keeping them apart', async () => {
    const audio = await renderOffline(0.3, (context) => build(context, { params: { gain: 0.5 } }, true));
    expect(busRms(audio, 0.1, 0.2, 0) / SINE).toBeCloseTo(0.5, 3);
    expect(busRms(audio, 0.1, 0.2, 1) / SINE).toBeCloseTo(0.25, 3);
  });

  it('follows a cabled gain in automate, ramping between grid points', async () => {
    // Base 0.2, plus 0.8 from 0.5 s on.
    const mods = { gain: [{ depth: 0.8, signal: (t: number) => (t >= 0.5 ? 1 : 0) }] };
    const audio = await renderOffline(1, (context) => build(context, { params: { gain: 0.2 }, mods }).automate!(0, 1));
    expect(busRms(audio, 0.2, 0.2) / SINE).toBeCloseTo(0.2, 2);
    expect(busRms(audio, 0.7, 0.2) / SINE).toBeCloseTo(1, 2);
    // The ramp runs over the grid step before 0.5 s: halfway through it, about halfway up.
    const mid = busRms(audio, 0.5 - 1 / 120 - 0.002, 0.004) / SINE;
    expect(mid).toBeGreaterThan(0.45);
    expect(mid).toBeLessThan(0.75);
  });

  it('gives the same audio however automate is split, and after a re-run over a stretch already covered', async () => {
    const mods = { gain: [{ depth: 0.6, signal: (t: number) => Math.sin(2 * Math.PI * 2 * t) }] };
    const render = (calls: [number, number][]) =>
      renderOffline(1, (context) => {
        const instance = build(context, { params: { gain: 0.7 }, mods }, true);
        for (const [t0, t1] of calls) instance.automate!(t0, t1);
      });
    const [one, split, rerun] = await Promise.all([render([[0, 1]]), render([[0, 0.2], [0.2, 0.71], [0.71, 1]]), render([[0, 0.5], [0.25, 0.5], [0.5, 1], [0.9, 1]])]);
    expect(peak(one)).toBeGreaterThan(0.4);
    expect(maxDifference(one, split)).toBeLessThan(RENDER_TOLERANCE);
    expect(maxDifference(one, rerun)).toBeLessThan(RENDER_TOLERANCE);
  });

  it('clamps modulation to its range and gives defined audio for NaN and out-of-range input', async () => {
    const [nan, huge, negative, nanSignal] = await Promise.all([
      level({ params: { gain: NaN } }),
      level({ params: { gain: 1e9 } }),
      level({ params: { gain: 0.5 }, mods: { gain: [{ depth: -10, signal: () => 1 }] } }),
      level({ params: { gain: 0.5 }, mods: { gain: [{ depth: 1, signal: () => NaN }] } }),
    ]);
    expect(nan / SINE).toBeCloseTo(1, 3); // the default
    expect(huge / SINE).toBeCloseTo(2, 3); // the knob's max
    expect(negative).toBe(0); // the knob's min, not an inverted signal
    expect(nanSignal / SINE).toBeCloseTo(0.5, 3); // a NaN cable counts as 0
  });

  it('ramps a gain edit in place from the swap time instead of jumping', async () => {
    expect(gain.liveParams).toEqual(['gain']);
    let edit: () => void = () => {};
    const audio = await renderOffline(1, (context) => {
      const instance = build(context, { params: { gain: 1 } });
      edit = () => instance.update!({ gain: 0.25 }, 0.5);
    }, { edits: [{ time: 0.4, apply: () => edit() }] });
    expect(busRms(audio, 0.4, 0.1) / SINE).toBeCloseTo(1, 2);
    expect(busRms(audio, 0.6, 0.1) / SINE).toBeCloseTo(0.25, 2);
    // Halfway through the 20 ms ramp, about halfway down.
    const mid = busRms(audio, 0.508, 0.004) / SINE;
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(0.75);
  });

  it('keeps its instance for a gain edit through the runtime', async () => {
    const { reports, built } = await swapRun(gain, [{ gain: 1 }, { gain: 0.3 }, { gain: 1.5 }]);
    expect(reports.map((r) => r.updated)).toEqual([['n'], ['n']]);
    expect(built).toBe(1);
  });
});
