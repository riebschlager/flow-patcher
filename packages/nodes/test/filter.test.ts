import { describe, expect, it } from 'vitest';
import { automationTimes, type AudioContextLike, type AudioInstance } from '@flow-patcher/engine';
import { biquadQ, filter } from '../src/filter';
import { maxDifference, peak, renderOffline, RENDER_TOLERANCE } from '../../../tools/lib/audio';
import { audioSetup, busRms, sine, swapRun, type ContextOptions } from './helpers';

/** A Filter fed a sine at `hz` (left) and, if given, another at `rightHz` (right), into the destination. */
function build(context: AudioContextLike, hz: number, options: ContextOptions = {}, rightHz?: number): AudioInstance {
  const instance = filter.audio!(audioSetup(filter, context, options));
  if (rightHz === undefined) sine(context, hz).connect(instance.inputs!.in!);
  else {
    sine(context, hz, 0.5, -1).connect(instance.inputs!.in!);
    sine(context, rightHz, 0.5, 1).connect(instance.inputs!.in!);
  }
  instance.outputs!.out!.connect(context.destination);
  return instance;
}

/** Steady-state RMS of a sine at `hz` through a Filter with `params`. */
async function through(hz: number, params: Record<string, unknown>): Promise<number> {
  const audio = await renderOffline(0.3, (context) => build(context, hz, { params }));
  return busRms(audio, 0.2, 0.1);
}

const SINE = 0.5 / Math.SQRT2;

describe('filter', () => {
  it('passes or cuts by mode around the cutoff', async () => {
    const [lowLo, lowHi, highLo, highHi, bandLo, bandMid, bandHi] = await Promise.all([
      through(100, { mode: 'lowpass', cutoff: 1000 }),
      through(8000, { mode: 'lowpass', cutoff: 1000 }),
      through(100, { mode: 'highpass', cutoff: 1000 }),
      through(8000, { mode: 'highpass', cutoff: 1000 }),
      through(100, { mode: 'bandpass', cutoff: 1000, q: 2 }),
      through(1000, { mode: 'bandpass', cutoff: 1000, q: 2 }),
      through(8000, { mode: 'bandpass', cutoff: 1000, q: 2 }),
    ]);
    // Two-pole slopes: three octaves past the cutoff is about −36 dB.
    expect(lowLo).toBeGreaterThan(SINE * 0.95);
    expect(lowHi).toBeLessThan(SINE * 0.03);
    expect(highHi).toBeGreaterThan(SINE * 0.95);
    expect(highLo).toBeLessThan(SINE * 0.03);
    expect(bandMid).toBeGreaterThan(SINE * 0.95);
    expect(bandLo).toBeLessThan(SINE * 0.1);
    expect(bandHi).toBeLessThan(SINE * 0.1);
  });

  it('reads Q as a plain ratio in every mode: 0.71 is flat at a pass filter\'s cutoff, higher Q peaks', async () => {
    expect(biquadQ('lowpass', 1)).toBe(0);
    expect(biquadQ('bandpass', 4)).toBe(4);
    const [flat, peaked] = await Promise.all([through(1000, { cutoff: 1000, q: 0.71 }), through(1000, { cutoff: 1000, q: 4 })]);
    // A Butterworth pole pair is −3 dB at the cutoff; Q = 4 is about +12 dB.
    expect(flat / SINE).toBeCloseTo(Math.SQRT1_2, 1);
    expect(peaked / SINE).toBeGreaterThan(3.5);
  });

  it('filters both channels of a stereo bus, each on its own', async () => {
    const audio = await renderOffline(0.3, (context) => build(context, 100, { params: { cutoff: 1000 } }, 8000));
    // Left carries the 100 Hz sine, right the 8 kHz one, each panned hard.
    expect(busRms(audio, 0.2, 0.1, 0)).toBeGreaterThan(SINE * 0.95);
    expect(busRms(audio, 0.2, 0.1, 1)).toBeLessThan(SINE * 0.03);
  });

  it('follows a cabled cutoff in automate, sweeping a sine that is already sounding', async () => {
    // Cutoff 200 Hz, plus 4800 Hz from 0.5 s on: a 2 kHz sine is cut, then passes.
    const mods = { cutoff: [{ depth: 4800, signal: (t: number) => (t >= 0.5 ? 1 : 0) }] };
    const audio = await renderOffline(1, (context) => build(context, 2000, { params: { cutoff: 200 }, mods }).automate!(0, 1));
    expect(busRms(audio, 0.3, 0.1)).toBeLessThan(SINE * 0.03);
    expect(busRms(audio, 0.8, 0.1)).toBeGreaterThan(SINE * 0.95);
    // The ramp runs between the grid points either side of 0.5 s, not a jump at a window edge.
    const before = busRms(audio, 0.5 - 1 / 60, 1 / 60), after = busRms(audio, 0.5 + 1 / 60, 1 / 60);
    expect(before).toBeGreaterThan(busRms(audio, 0.3, 0.1) * 2);
    expect(before).toBeLessThan(after);
  });

  it('gives the same audio however automate is split, and after a re-run over a stretch already covered', async () => {
    const mods = { cutoff: [{ depth: 3000, signal: (t: number) => 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t) }], q: [{ depth: 4, signal: (t: number) => t }] };
    const render = (calls: [number, number][]) =>
      renderOffline(1, (context) => {
        const instance = build(context, 1500, { params: { cutoff: 300, mode: 'bandpass' }, mods });
        for (const [t0, t1] of calls) instance.automate!(t0, t1);
      });
    const [one, split, rerun] = await Promise.all([
      render([[0, 1]]),
      render([[0, 0.123], [0.123, 0.5], [0.5, 1]]),
      render([[0, 0.6], [0.31, 0.6], [0.6, 1], [0.55, 1]]),
    ]);
    expect(peak(one)).toBeGreaterThan(0.1);
    expect(maxDifference(one, split)).toBeLessThan(RENDER_TOLERANCE);
    expect(maxDifference(one, rerun)).toBeLessThan(RENDER_TOLERANCE);
  });

  it('leaves an uncabled cutoff alone in automate', async () => {
    const [still, automated] = await Promise.all([
      renderOffline(0.5, (context) => build(context, 2000, { params: { cutoff: 400 } })),
      renderOffline(0.5, (context) => build(context, 2000, { params: { cutoff: 400 } }).automate!(0, 0.5)),
    ]);
    expect(maxDifference(still, automated)).toBeLessThan(RENDER_TOLERANCE);
  });

  it('gives defined audio for weird params and modulation: NaN, out of range, huge depth, NaN signal', async () => {
    const cases: ContextOptions[] = [
      { params: { cutoff: NaN, q: NaN, mode: 'notch' } },
      { params: { cutoff: -5, q: 1e9 } },
      { params: { cutoff: 1e12, q: -1 } },
      { params: { cutoff: 500 }, mods: { cutoff: [{ depth: 1e300, signal: () => 1e300 }], q: [{ depth: 1, signal: () => NaN }] } },
      { params: { cutoff: 500 }, mods: { cutoff: [{ depth: -1e6, signal: () => 1 }] } },
    ];
    const renders = await Promise.all(cases.map((options) => renderOffline(0.3, (context) => build(context, 440, options).automate!(0, 0.3))));
    for (const audio of renders) {
      for (const data of audio.channels) expect(data.every(Number.isFinite)).toBe(true);
      expect(peak(audio)).toBeLessThan(10);
    }
    // NaN params fall back to the defaults: a low-pass at 1200 Hz passes 440 Hz.
    expect(busRms(renders[0]!, 0.2, 0.1)).toBeGreaterThan(SINE * 0.95);
    // A cutoff pushed below its range sits at 20 Hz, so 440 Hz is cut.
    expect(busRms(renders[4]!, 0.2, 0.1)).toBeLessThan(SINE * 0.01);
    // Automating an empty or backwards window does nothing.
    expect(automationTimes(0.3, 0.3)).toEqual([]);
  });

  it('ramps a cutoff edit in place from the swap time instead of jumping', async () => {
    expect(filter.liveParams).toEqual(['cutoff', 'q']);
    let edit: () => void = () => {};
    const audio = await renderOffline(1, (context) => {
      const instance = build(context, 2000, { params: { cutoff: 200 } });
      edit = () => instance.update!({ mode: 'lowpass', cutoff: 8000, q: 0.71 }, 0.5);
    }, { edits: [{ time: 0.4, apply: () => edit() }] });
    const cut = busRms(audio, 0.45, 0.05), open = busRms(audio, 0.6, 0.1);
    expect(cut).toBeLessThan(SINE * 0.03);
    expect(open).toBeGreaterThan(SINE * 0.95);
    // Still held until 0.5 s; the 20 ms ramp passes 2 kHz about 5 ms in, so the first 5 ms stay below half open.
    expect(busRms(audio, 0.49, 0.01)).toBeLessThan(SINE * 0.03);
    expect(busRms(audio, 0.5, 0.004)).toBeLessThan(open * 0.5);
    expect(busRms(audio, 0.53, 0.01)).toBeGreaterThan(open * 0.9);
  });

  it('ramps a Q edit in place: a low-pass at Q 0.71 edited to 4 ends about +12 dB at the cutoff', async () => {
    let edit: () => void = () => {};
    const audio = await renderOffline(1, (context) => {
      const instance = build(context, 1000, { params: { cutoff: 1000, q: 0.71 } });
      edit = () => instance.update!({ mode: 'lowpass', cutoff: 1000, q: 4 }, 0.5);
    }, { edits: [{ time: 0.4, apply: () => edit() }] });
    const flat = busRms(audio, 0.4, 0.1) / SINE, peaked = busRms(audio, 0.7, 0.1) / SINE;
    expect(flat).toBeCloseTo(Math.SQRT1_2, 1);
    // Q 4 is +12 dB at the cutoff: about 4× the input.
    expect(20 * Math.log10(peaked)).toBeGreaterThan(11);
    expect(20 * Math.log10(peaked)).toBeLessThan(13);
    // Not a jump: in the first 5 ms after the edit time the resonance is still building.
    expect(busRms(audio, 0.5, 0.005) / SINE).toBeLessThan(peaked * 0.75);
  });

  it('keeps its instance for a cutoff or Q edit through the runtime, and rebuilds for a mode change', async () => {
    const { reports, built } = await swapRun(filter, [{ cutoff: 1200 }, { cutoff: 3000 }, { cutoff: 3000, q: 4 }, { cutoff: 3000, q: 4, mode: 'highpass' }]);
    expect(reports.map((r) => r.updated)).toEqual([['n'], ['n'], []]);
    // One from attachAudio, one for the mode change.
    expect(built).toBe(2);
  });
});
