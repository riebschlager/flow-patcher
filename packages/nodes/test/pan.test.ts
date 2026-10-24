import { describe, expect, it } from 'vitest';
import type { AudioContextLike, AudioInstance } from '@flow-patcher/engine';
import { pan } from '../src/pan';
import { maxDifference, renderOffline, RENDER_TOLERANCE } from '../../../tools/lib/audio';
import { audioSetup, busRms, sine, swapRun, type ContextOptions } from './helpers';

const SINE = 0.5 / Math.SQRT2;

/** A Pan fed a mono 440 Hz sine (or a hard-panned pair, 0.5 left and 0.25 right), into the destination. */
function build(context: AudioContextLike, options: ContextOptions = {}, stereo = false): AudioInstance {
  const instance = pan.audio!(audioSetup(pan, context, options));
  if (stereo) {
    sine(context, 440, 0.5, -1).connect(instance.inputs!.in!);
    sine(context, 660, 0.25, 1).connect(instance.inputs!.in!);
  } else sine(context, 440).connect(instance.inputs!.in!);
  instance.outputs!.out!.connect(context.destination);
  return instance;
}

/** Left and right RMS over [t, t + width), relative to the input sine's. */
const sides = (audio: Awaited<ReturnType<typeof renderOffline>>, t: number, width: number) => [busRms(audio, t, width, 0) / SINE, busRms(audio, t, width, 1) / SINE];

const render = (options: ContextOptions, stereo = false) => renderOffline(0.3, (context) => build(context, options, stereo).automate!(0, 0.3, -Infinity));

describe('pan', () => {
  it('places a mono bus left, centre or right, equal-power', async () => {
    const [left, centre, right, quarter] = await Promise.all([render({ params: { pan: -1 } }), render({}), render({ params: { pan: 1 } }), render({ params: { pan: 0.5 } })]);
    const near = ([l, r]: number[], [el, er]: number[]) => {
      expect(l).toBeCloseTo(el, 3);
      expect(r).toBeCloseTo(er, 3);
    };
    near(sides(left, 0.1, 0.2), [1, 0]);
    near(sides(centre, 0.1, 0.2), [Math.SQRT1_2, Math.SQRT1_2]);
    near(sides(right, 0.1, 0.2), [0, 1]);
    // Equal power: x = (pan + 1) / 2 = 0.75, gains cos(x·π/2) and sin(x·π/2).
    near(sides(quarter, 0.1, 0.2), [Math.cos((0.75 * Math.PI) / 2), Math.sin((0.75 * Math.PI) / 2)]);
  });

  it('moves a stereo bus without mixing its channels at centre, and folds it to one side at the end', async () => {
    const [centre, right] = await Promise.all([render({}, true), render({ params: { pan: 1 } }, true)]);
    const [l, r] = sides(centre, 0.1, 0.2);
    expect(l).toBeCloseTo(1, 3);
    expect(r).toBeCloseTo(0.5, 3);
    // Hard right: the left channel goes over to the right, the 440 and 660 Hz sines summed there.
    const [l2, r2] = sides(right, 0.1, 0.2);
    expect(l2).toBeCloseTo(0, 3);
    expect(r2).toBeCloseTo(Math.hypot(1, 0.5), 2);
  });

  it('follows a cabled pan in automate: a sweep from left to right', async () => {
    const mods = { pan: [{ depth: 2, signal: (t: number) => t }] };
    const audio = await renderOffline(1, (context) => build(context, { params: { pan: -1 }, mods }).automate!(0, 1, -Infinity));
    const [l0, r0] = sides(audio, 0.02, 0.03), [lm, rm] = sides(audio, 0.48, 0.04), [l1, r1] = sides(audio, 0.95, 0.03);
    expect(l0).toBeGreaterThan(0.99);
    expect(r0).toBeLessThan(0.1);
    expect(lm).toBeCloseTo(Math.SQRT1_2, 1);
    expect(rm).toBeCloseTo(Math.SQRT1_2, 1);
    expect(l1).toBeLessThan(0.1);
    expect(r1).toBeGreaterThan(0.99);
  });

  it('gives the same audio however automate is split, and after a re-run over a stretch already covered', async () => {
    const mods = { pan: [{ depth: 1, signal: (t: number) => Math.sin(2 * Math.PI * 1.5 * t) }] };
    const renderCalls = (calls: [number, number][]) =>
      renderOffline(1, (context) => {
        const instance = build(context, { mods });
        for (const [t0, t1] of calls) instance.automate!(t0, t1, -Infinity);
      });
    const [one, split, rerun] = await Promise.all([renderCalls([[0, 1]]), renderCalls([[0, 0.333], [0.333, 0.6], [0.6, 1]]), renderCalls([[0, 0.7], [0.1, 0.7], [0.7, 1], [0.7, 1]])]);
    expect(maxDifference(one, split)).toBeLessThan(RENDER_TOLERANCE);
    expect(maxDifference(one, rerun)).toBeLessThan(RENDER_TOLERANCE);
  });

  it('clamps out-of-range pan and modulation and falls back to centre for NaN', async () => {
    const [nan, far, pushed, nanSignal] = await Promise.all([
      render({ params: { pan: NaN } }),
      render({ params: { pan: -40 } }),
      render({ params: { pan: 0.5 }, mods: { pan: [{ depth: 100, signal: () => 1 }] } }),
      render({ params: { pan: 1 }, mods: { pan: [{ depth: 1, signal: () => NaN }] } }),
    ]);
    expect(sides(nan, 0.1, 0.2)[0]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(sides(far, 0.1, 0.2)).toEqual([expect.closeTo(1, 3), expect.closeTo(0, 3)]);
    expect(sides(pushed, 0.1, 0.2)).toEqual([expect.closeTo(0, 3), expect.closeTo(1, 3)]);
    expect(sides(nanSignal, 0.1, 0.2)).toEqual([expect.closeTo(0, 3), expect.closeTo(1, 3)]);
  });

  it('ramps a pan edit in place from the swap time instead of jumping', async () => {
    expect(pan.liveParams).toEqual(['pan']);
    let edit: () => void = () => {};
    const audio = await renderOffline(1, (context) => {
      const instance = build(context, { params: { pan: -1 } });
      edit = () => instance.update!({ pan: 1 }, 0.5);
    }, { edits: [{ time: 0.4, apply: () => edit() }], attempts: 3 });
    expect(sides(audio, 0.4, 0.1)).toEqual([expect.closeTo(1, 3), expect.closeTo(0, 3)]);
    expect(sides(audio, 0.6, 0.1)).toEqual([expect.closeTo(0, 3), expect.closeTo(1, 3)]);
    // Halfway through the 20 ms ramp the bus is near the centre, on both sides at once.
    const [l, r] = sides(audio, 0.508, 0.004);
    expect(l).toBeGreaterThan(0.4);
    expect(r).toBeGreaterThan(0.4);
  });

  it('keeps its instance for a pan edit through the runtime', async () => {
    const { reports, built } = await swapRun(pan, [{ pan: 0 }, { pan: -0.5 }, { pan: 0.8 }]);
    expect(reports.map((r) => r.updated)).toEqual([['n'], ['n']]);
    expect(built).toBe(1);
  });
});
