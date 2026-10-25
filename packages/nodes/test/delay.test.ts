import { describe, expect, it } from 'vitest';
import {
  createTransport,
  readTransport,
  retune,
  type AudioContextLike,
  type AudioInstance,
  type AudioNodeLike,
  type AudioParamLike,
  type Transport,
} from '@flow-patcher/engine';
import {
  cappedFeedback,
  clampDelay,
  DEFAULT_DIVISION,
  delay,
  DELAY_DIVISIONS,
  DELAY_GLIDE,
  delaySeconds,
  divisionBeats,
  FEEDBACK_CAP,
  GLIDE_LEAD,
  MAX_DELAY,
} from '../src/delay';
import { blockLoudness, maxDifference, peak, renderOffline, RENDER_TOLERANCE, type RenderedAudio } from '../../../tools/lib/audio';
import { expectGoldenClose } from '../../../test-support/golden';
import { audioSetup, busRms, sine, swapRun, type ContextOptions } from './helpers';

const DEFAULTS = { division: DEFAULT_DIVISION, time: 0.4, feedback: 0.36, tone: 3100, mix: 0.35 };

/** A 5 ms burst of a 1 kHz sine at 0.5, from each of `times`. */
function bursts(context: AudioContextLike, ...times: number[]): AudioNodeLike {
  const osc = context.createOscillator(), amp = context.createGain();
  osc.frequency.value = 1000;
  amp.gain.value = 0;
  for (const at of times) {
    amp.gain.setValueAtTime(0.5, at);
    amp.gain.setValueAtTime(0, at + 0.005);
  }
  osc.connect(amp);
  osc.start(0);
  return amp;
}

/** A transport cable at `bpm` (beats per second bpm / 60) from 0, as a Clock's Transport output. */
function transport(bpm: number): Transport {
  return createTransport({ beatsPerSecond: bpm / 60, stepBeats: 0.25, swing: 0 }, 0);
}
const cable = (t: Transport) => ({ transport: (time: number) => readTransport(t, time) });

/** A Delay fed `source`, into the destination, automated over [0, seconds) as the runtime would. */
function build(context: AudioContextLike, source: (c: AudioContextLike) => AudioNodeLike, options: ContextOptions = {}, seconds?: number): AudioInstance {
  const instance = delay.audio!(audioSetup(delay, context, options));
  source(context).connect(instance.inputs!.in!);
  instance.outputs!.out!.connect(context.destination);
  if (seconds !== undefined) instance.automate!(0, seconds, -Infinity);
  return instance;
}

/** Times (s) where the bus first passes `level` after each quiet stretch of 50 ms, from `from`. */
function onsets(audio: RenderedAudio, level = 0.01, from = 0): number[] {
  const found: number[] = [];
  let quiet = Infinity;
  const data = audio.channels[0]!;
  for (let i = Math.round(from * audio.sampleRate); i < data.length; i++) {
    if (Math.abs(data[i]!) >= level) {
      if (quiet >= 0.05 * audio.sampleRate) found.push(i / audio.sampleRate);
      quiet = 0;
    } else quiet++;
  }
  return found;
}

/** Largest |sample| over [t, t + width) on channel 0. */
function peakIn(audio: RenderedAudio, t: number, width: number): number {
  const data = audio.channels[0]!;
  let max = 0;
  for (let i = Math.round(t * audio.sampleRate); i < Math.min(data.length, Math.round((t + width) * audio.sampleRate)); i++) max = Math.max(max, Math.abs(data[i]!));
  return max;
}

/** Largest sample-to-sample step on any channel over [t, t + width). */
function largestStep(audio: RenderedAudio, t: number, width: number): number {
  const from = Math.max(1, Math.round(t * audio.sampleRate)), to = Math.round((t + width) * audio.sampleRate);
  let max = 0;
  for (const data of audio.channels) for (let i = from; i < Math.min(to, data.length); i++) max = Math.max(max, Math.abs(data[i]! - data[i - 1]!));
  return max;
}

/**
 * The largest click over [t, t + width): how far one sample-to-sample step stands out from the steps
 * two samples either side. A steep but smooth wave (a pitch bend) moves alike from step to step and
 * scores near 0; a discontinuity scores its own height.
 */
function largestClick(audio: RenderedAudio, t: number, width: number): number {
  const from = Math.max(3, Math.round(t * audio.sampleRate)), to = Math.round((t + width) * audio.sampleRate);
  let max = 0;
  for (const data of audio.channels) {
    const step = (i: number) => Math.abs(data[i]! - data[i - 1]!);
    for (let i = from; i < Math.min(to, data.length - 2); i++) max = Math.max(max, step(i) - Math.max(step(i - 2), step(i + 2)));
  }
  return max;
}

describe('delay timing (Flow checks/delay-sync.test.mjs)', () => {
  it('gives every division its exact length at every tempo and rate, within the 32 s ceiling', () => {
    const beats = Object.values(DELAY_DIVISIONS);
    expect(beats).toHaveLength(21);
    expect(beats[0]).toBe(1 / 16);
    expect(beats.at(-1)).toBe(8);
    expect([...beats].sort((a, b) => a - b)).toEqual(beats);
    for (const bpm of [30, 56, 100]) {
      for (const rate of [0.5, 1, 2]) {
        for (const b of beats) {
          const seconds = delaySeconds(b, (bpm / 60) * rate);
          // Flow checked it against its step clock: delayBeats × 4 sixteenth steps.
          expect(Math.abs(seconds - (60 / bpm / rate) * b)).toBeLessThan(1e-10);
          expect(seconds).toBeLessThanOrEqual(MAX_DELAY);
        }
      }
    }
    expect(delaySeconds(1, 0.25)).toBe(4); // 30 bpm, half speed, a quarter
    expect(delaySeconds(0.5, (100 / 60) * 2)).toBeCloseTo(0.15, 12);
    expect(delaySeconds(8, 0.25)).toBe(32); // two bars at 30 bpm, half speed: Flow's ceiling
    expect(delaySeconds(1 / 16, (100 / 60) * 2)).toBeCloseTo(0.01875, 12);
    // Slower than Flow allowed (Clock goes to 20 bpm at a quarter rate): clamped to the ceiling.
    expect(delaySeconds(8, (20 / 60) * 0.25)).toBe(MAX_DELAY);
  });

  it('falls back to a dotted eighth for an unknown division, as Flow did for a bad saved value', () => {
    expect(DELAY_DIVISIONS[DEFAULT_DIVISION]).toBe(0.75);
    for (const bad of [-1, 0, Infinity, 'bad', 9, undefined, '__proto__', 'toString']) expect(divisionBeats(bad)).toBe(0.75);
    expect(divisionBeats('2/1')).toBe(8);
    expect(clampDelay(NaN)).toBeGreaterThan(0);
    expect(clampDelay(Infinity)).toBe(MAX_DELAY);
  });

  it('caps feedback at 0.42 whatever it is given (Flow: bounded feedback)', () => {
    expect(cappedFeedback(0.3)).toBe(0.3);
    expect(cappedFeedback(0.9)).toBe(FEEDBACK_CAP);
    expect(cappedFeedback(Infinity)).toBe(FEEDBACK_CAP);
    expect(cappedFeedback(-1)).toBe(0);
    expect(cappedFeedback(NaN)).toBe(0);
    expect(delay.params.find((p) => p.name === 'feedback')).toMatchObject({ min: 0, max: FEEDBACK_CAP });
  });
});

describe('delay', () => {
  it('echoes on the transport: a dotted eighth at 120 bpm is 0.375 s, repeat after repeat', async () => {
    const audio = await renderOffline(1.5, (context) => build(context, (c) => bursts(c, 0.1), { params: { mix: 1 }, values: cable(transport(120)) }, 1.5));
    const echoes = onsets(audio, 0.005);
    expect(echoes.length).toBeGreaterThanOrEqual(3);
    echoes.slice(0, 3).forEach((t, i) => expect(t).toBeCloseTo(0.1 + 0.375 * (i + 1), 2));
  });

  it('follows the transport\'s exact tempo across a tempo change', async () => {
    // 120 bpm, then 240 bpm from 1 s: a quarter is 0.5 s, then 0.25 s.
    const t = transport(120);
    retune(t, 1, { beatsPerSecond: 4, stepBeats: 0.25, swing: 0 });
    const audio = await renderOffline(2.2, (context) => build(context, (c) => bursts(c, 0.2, 1.5), { params: { mix: 1, division: '1/4', feedback: 0 }, values: cable(t) }, 2.2));
    const echoes = onsets(audio, 0.005);
    expect(echoes).toHaveLength(2);
    expect(echoes[0]).toBeCloseTo(0.7, 2);
    expect(echoes[1]).toBeCloseTo(1.75, 2);
  });

  it('runs on free time in seconds with no transport, and says so on the input', async () => {
    expect(delay.ports.find((p) => p.name === 'transport')?.unwiredHint).toMatch(/free time/);
    const audio = await renderOffline(1, (context) => build(context, (c) => bursts(c, 0.1), { params: { mix: 1, time: 0.3, feedback: 0 } }, 1));
    expect(onsets(audio, 0.005)).toHaveLength(1);
    expect(onsets(audio, 0.005)[0]).toBeCloseTo(0.4, 2);
    // A reading with no usable tempo is no transport either.
    const junk = await renderOffline(1, (context) => build(context, (c) => bursts(c, 0.1), { params: { mix: 1, time: 0.3, feedback: 0 }, values: { transport: () => ({ beat: 1, beatsPerSecond: -1 }) } }, 1));
    expect(maxDifference(audio, junk)).toBeLessThan(RENDER_TOLERANCE);
  });

  it('reads a cable into Time in octaves (ADR 0032): depth 1 doubles 0.2 s', async () => {
    expect(delay.params.find((p) => p.name === 'time')).toMatchObject({ scale: 'log', unit: 's' });
    expect(delay.params.find((p) => p.name === 'tone')).toMatchObject({ scale: 'log', unit: 'Hz' });
    const audio = await renderOffline(1, (context) => build(context, (c) => bursts(c, 0.1), { params: { mix: 1, time: 0.2, feedback: 0 }, mods: { time: [{ depth: 1, signal: () => 1 }] } }, 1));
    expect(onsets(audio, 0.005)[0]).toBeCloseTo(0.5, 2);
  });

  it('keeps each repeat at most 0.42 of the one before, however far a cable pushes Feedback', async () => {
    // Tone wide open, so the loop's gain is the feedback alone.
    const render = (options: ContextOptions, bypassClamp = false) =>
      renderOffline(2, (context) => {
        const setup = audioSetup(delay, context, options);
        // Past the engine's own clamp to the knob's range: the node caps it itself.
        const ctx = bypassClamp ? { ...setup, param: (name: string, t: number) => (name === 'feedback' ? 5 : setup.param(name, t)) } : setup;
        const instance = delay.audio!(ctx);
        bursts(context, 0.1).connect(instance.inputs!.in!);
        instance.outputs!.out!.connect(context.destination);
        instance.automate!(0, 2, -Infinity);
      });
    const params = { mix: 1, time: 0.25, tone: 20000, feedback: 0.4 };
    const [modulated, bypassed] = await Promise.all([
      render({ params, mods: { feedback: [{ depth: 10, signal: () => 1 }] } }),
      render({ params, mods: { feedback: [{ depth: 1, signal: () => 1 }] } }, true),
    ]);
    for (const audio of [modulated, bypassed]) {
      const repeats = [0, 1, 2, 3].map((i) => peakIn(audio, 0.35 + 0.25 * i - 0.01, 0.03));
      for (let i = 1; i < repeats.length; i++) {
        expect(repeats[i]! / repeats[i - 1]!).toBeLessThan(FEEDBACK_CAP + 0.01);
        expect(repeats[i]! / repeats[i - 1]!).toBeGreaterThan(FEEDBACK_CAP - 0.03);
      }
    }
  });

  it('caps a Feedback edit at 0.42 too', async () => {
    let edit: () => void = () => {};
    const audio = await renderOffline(2, (context) => {
      const instance = build(context, (c) => bursts(c, 0.6), { params: { mix: 1, time: 0.25, tone: 20000, feedback: 0 } }, 2);
      edit = () => instance.update!({ ...DEFAULTS, mix: 1, time: 0.25, tone: 20000, feedback: 0.95 }, 0.5);
    }, { edits: [{ time: 0.4, apply: () => edit() }], attempts: 3 });
    const repeats = [0, 1, 2].map((i) => peakIn(audio, 0.85 + 0.25 * i - 0.01, 0.03));
    expect(repeats[1]! / repeats[0]!).toBeCloseTo(FEEDBACK_CAP, 1);
    expect(repeats[2]! / repeats[1]!).toBeLessThan(FEEDBACK_CAP + 0.01);
  });

  it('darkens each repeat by Tone, the wet taken after the filter as in Flow\'s gesture echo', async () => {
    const level = async (tone: number) => {
      const audio = await renderOffline(0.8, (context) => build(context, (c) => sine(c, 6000), { params: { mix: 1, time: 0.1, tone, feedback: 0 } }, 0.8));
      return busRms(audio, 0.4, 0.3);
    };
    const [open, dark] = await Promise.all([level(20000), level(1000)]);
    // Even the first repeat goes through the low-pass: 6 kHz is over two octaves above 1 kHz.
    expect(dark).toBeLessThan(open * 0.1);
  });

  it('delays both channels of a stereo bus, each on its own', async () => {
    const audio = await renderOffline(1, (context) => {
      const instance = delay.audio!(audioSetup(delay, context, { params: { mix: 1, time: 0.3, feedback: 0, tone: 20000 } }));
      sine(context, 440, 0.5, -1).connect(instance.inputs!.in!);
      instance.outputs!.out!.connect(context.destination);
      instance.automate!(0, 1, -Infinity);
    });
    // Silent until the first repeat, then left only.
    expect(busRms(audio, 0, 0.29)).toBeLessThan(1e-6);
    expect(busRms(audio, 0.5, 0.3, 0)).toBeGreaterThan(0.2);
    expect(busRms(audio, 0.5, 0.3, 1)).toBeLessThan(1e-6);
  });

  it('gives the same audio however automate is split, and after a re-run over a stretch already covered', async () => {
    const t = transport(100);
    retune(t, 0.4, { beatsPerSecond: 2.5, stepBeats: 0.25, swing: 0 });
    const mods = { feedback: [{ depth: 0.2, signal: (s: number) => s }], tone: [{ depth: 2, signal: (s: number) => Math.sin(2 * Math.PI * s) }], mix: [{ depth: 0.5, signal: (s: number) => s }] };
    const render = (calls: [number, number][]) =>
      renderOffline(1, (context) => {
        const instance = build(context, (c) => sine(c, 440), { params: { division: '1/16', feedback: 0.1, tone: 2000, mix: 0.3 }, mods, values: cable(t) });
        for (const [t0, t1] of calls) instance.automate!(t0, t1, -Infinity);
      });
    const [one, split, rerun] = await Promise.all([render([[0, 1]]), render([[0, 0.23], [0.23, 0.61], [0.61, 1]]), render([[0, 0.5], [0.3, 0.5], [0.5, 1], [0.8, 1]])]);
    expect(peak(one)).toBeGreaterThan(0.1);
    expect(maxDifference(one, split)).toBeLessThan(RENDER_TOLERANCE);
    expect(maxDifference(one, rerun)).toBeLessThan(RENDER_TOLERANCE);
  });

  it('gives defined audio for weird params, modulation and transport readings', async () => {
    const cases: ContextOptions[] = [
      { params: { division: 'nope', time: NaN, feedback: NaN, tone: NaN, mix: NaN } },
      { params: { time: -5, feedback: 9, tone: 1e9, mix: -1 } },
      { params: {}, mods: { time: [{ depth: 1e300, signal: () => 1e300 }], feedback: [{ depth: 1, signal: () => NaN }], tone: [{ depth: -1e6, signal: () => 1 }] } },
      { params: {}, values: { transport: () => 'x' } },
      { params: {}, values: { transport: () => ({ beat: NaN, beatsPerSecond: Infinity, stepBeats: 0.25, swing: 0, since: 0 }) } },
      { params: { division: '2/1' }, values: cable(createTransport({ beatsPerSecond: 1 / 600, stepBeats: 0.25, swing: 0 })) },
    ];
    const renders = await Promise.all(cases.map((options) => renderOffline(0.5, (context) => build(context, (c) => sine(c, 440), options, 0.5))));
    for (const audio of renders) {
      for (const data of audio.channels) expect(data.every(Number.isFinite)).toBe(true);
      expect(peak(audio)).toBeLessThan(2);
    }
  });

  it('glides a Division edit: holds until the re-run\'s kept ramps are over, then 40 ms in a line', () => {
    const fake = fakeContext();
    const instance = delay.audio!(audioSetup(delay, fake.context, { params: { division: '1/8' }, values: cable(transport(120)) }));
    instance.automate!(0, 0.5, -Infinity);
    expect(fake.delayTime.value).toBe(0.25);
    instance.update!({ ...DEFAULTS, division: '1/4' }, 0.5);
    // The swap's re-run from the edit time.
    instance.automate!(0.5, 1, -Infinity);
    const after = fake.delayTime.points.filter((p) => p.time >= 0.5);
    const start = 0.5 + GLIDE_LEAD, end = start + DELAY_GLIDE;
    for (const { time, value } of after) {
      if (time <= start) expect(value).toBe(0.25);
      else if (time >= end) expect(value).toBe(0.5);
      else expect(value).toBeCloseTo(0.25 + (0.25 * (time - start)) / DELAY_GLIDE, 9);
    }
    // At least one grid point inside the glide: it is a line, not a step.
    expect(after.some(({ time }) => time > start && time < end)).toBe(true);
    // A Time edit with a transport changes nothing: the division rules.
    const before = fake.delayTime.points.length;
    instance.update!({ ...DEFAULTS, division: '1/4', time: 2 }, 1);
    instance.automate!(1, 1.5, -Infinity);
    expect(fake.delayTime.points.slice(before).every((p) => p.value === 0.5)).toBe(true);
  });

  it('changes Division while it plays without a click: the echo bends, where a jump would step', async () => {
    // No feedback and the tone wide open, so the wet signal is the delayed sine alone (amplitude 0.5). At 330 Hz
    // the 0.25 s change is 82.5 cycles, so a jump lands half a cycle off.
    let edit: () => void = () => {};
    const glided = await renderOffline(1, (context) => {
      const instance = build(context, (c) => sine(c, 330), { params: { mix: 1, division: '1/8', feedback: 0, tone: 20000 }, values: cable(transport(120)) }, 1);
      edit = () => {
        instance.update!({ ...DEFAULTS, mix: 1, division: '1/4', feedback: 0, tone: 20000 }, 0.5);
        instance.automate!(0.5, 1, context.currentTime);
      };
    }, { edits: [{ time: 0.45, apply: () => edit() }], attempts: 3 });
    // The same change made as a jump, on a bare delay line.
    const jumped = await renderOffline(1, (context) => {
      const line = context.createDelay(1);
      line.delayTime.setValueAtTime(0.25, 0);
      // At a crest of the delayed sine, 0.25 + 104.25 periods: half a cycle later it is at a trough.
      line.delayTime.setValueAtTime(0.5, 0.25 + 104.25 / 330);
      sine(context, 330).connect(line);
      line.connect(context.destination);
    });
    const window = [0.5, 0.2] as const;
    // While the delay grows by 0.25 s over 40 ms the echo plays back at 1 − 0.25 / 0.04 = −5.25 times its speed,
    // a tape-style bend as Flow's glide gave: steep, but no step stands out from its neighbours.
    const steepest = (2 * Math.PI * 330 * 0.5) / 48000;
    expect(largestStep(glided, ...window)).toBeGreaterThan(steepest * 3);
    // Measured 0.023 where the glide's slope turns at a grid point, against about 1 for the jump.
    expect(largestClick(glided, ...window)).toBeLessThan(0.05);
    // A jump lands half a cycle off at once.
    expect(largestClick(jumped, ...window)).toBeGreaterThan(0.8);
    // Afterwards, a quarter: a sine delayed by 0.5 s.
    expect(busRms(glided, 0.7, 0.3)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('keeps its instance through the runtime for every knob, Division included', async () => {
    const { reports, built } = await swapRun(delay, [{ time: 0.2 }, { time: 0.3 }, { time: 0.3, division: '1/4' }, { time: 0.3, division: '1/4', feedback: 0.2, tone: 900, mix: 0.6 }]);
    expect(reports.map((r) => r.updated)).toEqual([['n'], ['n'], ['n']]);
    expect(built).toBe(1);
  });

  it('matches the golden loudness of a burst echoing at 120 bpm', async () => {
    const audio = await renderOffline(2.5, (context) => build(context, (c) => bursts(c, 0.1), { params: { mix: 0.5 }, values: cable(transport(120)) }, 2.5));
    expectGoldenClose('delay-loudness', { echoes: blockLoudness(audio, 0.05) }, 1e-3);
  });
});

interface RecordedParam extends AudioParamLike {
  points: { time: number; value: number }[];
}

/** A context that makes nothing audible and records the delay line's delayTime ramps. */
function fakeContext() {
  const param = (): RecordedParam => {
    const p: RecordedParam = {
      value: 0, points: [],
      setValueAtTime: () => p,
      linearRampToValueAtTime: (value: number, time: number) => (p.points.push({ time, value }), p),
      exponentialRampToValueAtTime: () => p,
      setTargetAtTime: () => p,
      cancelScheduledValues: (time: number) => ((p.points = p.points.filter((q) => q.time < time)), p),
    };
    return p;
  };
  const node = () => ({ connect: () => undefined, disconnect: () => undefined });
  const delayTime = param();
  const context = {
    currentTime: 0,
    sampleRate: 8000,
    destination: node(),
    createGain: () => ({ ...node(), gain: param() }),
    createBiquadFilter: () => ({ ...node(), type: 'lowpass', frequency: param(), Q: param() }),
    createDelay: () => ({ ...node(), delayTime }),
  } as unknown as AudioContextLike;
  return { context, delayTime };
}
