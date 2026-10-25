import { describe, expect, it } from 'vitest';
import { createRng, type AudioContextLike, type AudioInstance, type AudioNodeLike, type AudioParamLike } from '@flow-patcher/engine';
import { mixGains } from '../src/mix';
import { IMPULSE_CROSSFADE, MAX_TAILS, reverb, reverbImpulse } from '../src/reverb';
import { blockLoudness, maxDifference, peak, renderOffline, RENDER_TOLERANCE, type RenderedAudio } from '../../../tools/lib/audio';
import { expectGoldenClose } from '../../../test-support/golden';
import { audioSetup, busRms, sine, swapRun, tailRun, type ContextOptions } from './helpers';

const SINE = 0.5 / Math.SQRT2;
const RATE = 48000;
const DEFAULTS = { decay: 3, damping: 0.6, predelay: 0, variant: 0 };
const KEY = { seed: 1, nodeId: 'n' };

/** A 10 ms burst of a 440 Hz sine at 0.5, from `at`. */
function burst(context: AudioContextLike, at: number): AudioNodeLike {
  const osc = context.createOscillator(), amp = context.createGain();
  osc.frequency.value = 440;
  amp.gain.value = 0;
  amp.gain.setValueAtTime(0.5, at);
  amp.gain.setValueAtTime(0, at + 0.01);
  osc.connect(amp);
  osc.start(0);
  return amp;
}

/** White noise at ±0.5 from 0 s, seeded. */
function noise(context: AudioContextLike, seconds: number): AudioNodeLike {
  const buffer = context.createBuffer(1, Math.round(seconds * context.sampleRate), context.sampleRate);
  const data = buffer.getChannelData(0), rng = createRng(5);
  for (let i = 0; i < data.length; i++) data[i] = (rng.next() * 2 - 1) * 0.5;
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.start(0);
  return source;
}

/** The noise through a two-pole filter: low-pass or high-pass at `hz`. */
function band(context: AudioContextLike, type: 'lowpass' | 'highpass', hz: number): AudioNodeLike {
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = hz;
  noise(context, 6).connect(filter);
  return filter;
}

/** The samples of [from, to) seconds, every channel. */
const slice = (audio: RenderedAudio, from: number, to: number): RenderedAudio => ({
  sampleRate: audio.sampleRate,
  channels: audio.channels.map((data) => data.slice(Math.round(from * audio.sampleRate), Math.round(to * audio.sampleRate))),
});

/** A Reverb fed `source`, into the destination. */
function build(context: AudioContextLike, source: (c: AudioContextLike) => AudioNodeLike, options: ContextOptions = {}): AudioInstance {
  const instance = reverb.audio!(audioSetup(reverb, context, options));
  source(context).connect(instance.inputs!.in!);
  instance.outputs!.out!.connect(context.destination);
  return instance;
}

/** Steady-state RMS of `source` through a Reverb at mix 1 over its mix 0 (the dry level). */
async function wetOverDry(source: (c: AudioContextLike) => AudioNodeLike, params: Record<string, unknown>): Promise<number> {
  const seconds = (params.decay as number) + 1.5;
  const [dry, wet] = await Promise.all([0, 1].map((mix) => renderOffline(seconds, (context) => build(context, source, { params: { ...params, mix } }))));
  return busRms(wet!, seconds - 1, 1) / busRms(dry!, seconds - 1, 1);
}

/** Largest sample-to-sample step on any channel over [t, t + width). */
function largestStep(audio: RenderedAudio, t: number, width: number): number {
  const from = Math.max(1, Math.round(t * audio.sampleRate)), to = Math.round((t + width) * audio.sampleRate);
  let max = 0;
  for (const data of audio.channels) for (let i = from; i < Math.min(to, data.length); i++) max = Math.max(max, Math.abs(data[i]! - data[i - 1]!));
  return max;
}

describe('reverbImpulse', () => {
  it('is deterministic: the same seed, node and options give the same samples; another seed, node or Variant other noise', () => {
    const a = reverbImpulse(RATE, KEY, DEFAULTS), b = reverbImpulse(RATE, { ...KEY }, { ...DEFAULTS });
    expect(a).toEqual(b);
    for (const other of [reverbImpulse(RATE, KEY, { ...DEFAULTS, variant: 1 }), reverbImpulse(RATE, { ...KEY, seed: 2 }, DEFAULTS), reverbImpulse(RATE, { ...KEY, nodeId: 'm' }, DEFAULTS)]) {
      expect(other[0]!.length).toBe(a[0]!.length);
      expect(other[0]).not.toEqual(a[0]);
    }
    // Two independent streams, so a mono input comes back wide.
    expect(a[1]).not.toEqual(a[0]);
  });

  it('runs Predelay + Decay, starting silent, fading in over 20 ms and falling to nothing', () => {
    const [left] = reverbImpulse(RATE, KEY, { ...DEFAULTS, decay: 2, predelay: 0.1 });
    expect(left!.length).toBe(Math.round(2.1 * RATE));
    expect(left!.subarray(0, 0.1 * RATE).every((v) => v === 0)).toBe(true);
    const rms = (from: number, to: number) => Math.sqrt(left!.subarray(Math.round(from * RATE), Math.round(to * RATE)).reduce((s, v) => s + v * v, 0) / ((to - from) * RATE));
    // Fade-in: the first 2 ms are well under the 20–40 ms after them.
    expect(rms(0.1, 0.102)).toBeLessThan(rms(0.12, 0.14) * 0.3);
    // Flow's (1 − t / decay)^2.8: the last tenth is more than 60 dB under the first.
    expect(rms(1.9, 2.1)).toBeLessThan(rms(0.12, 0.32) * 1e-3);
    expect(left!.at(-1)).toBeCloseTo(0, 6);
  });

  it('scales to unit energy times (1 − a) / (1 + a), so low tones keep their level at any Decay', () => {
    for (const [decay, damping] of [[0.3, 0], [3, 0.6], [8, 0.95]] as const) {
      for (const channel of reverbImpulse(RATE, KEY, { ...DEFAULTS, decay, damping })) {
        const energy = channel.reduce((s, v) => s + v * v, 0);
        expect(energy).toBeCloseTo((1 - damping) / (1 + damping), 4);
      }
    }
  });

  it('gives a defined impulse for bad options: clamped to the ranges, NaN takes the default', () => {
    expect(reverbImpulse(RATE, KEY, { decay: NaN, damping: NaN, predelay: NaN, variant: NaN })).toEqual(reverbImpulse(RATE, KEY, DEFAULTS));
    expect(reverbImpulse(RATE, KEY, { decay: 100, damping: 5, predelay: -1, variant: 0 })).toEqual(reverbImpulse(RATE, KEY, { decay: 8, damping: 0.95, predelay: 0, variant: 0 }));
    expect(reverbImpulse(RATE, KEY, { ...DEFAULTS, decay: 0 })[0]!.length).toBe(Math.round(0.3 * RATE));
    // A bad sample rate falls back to 48 kHz.
    expect(reverbImpulse(NaN, KEY, DEFAULTS)).toEqual(reverbImpulse(RATE, KEY, DEFAULTS));
    for (const channel of reverbImpulse(RATE, KEY, { decay: Infinity, damping: -Infinity, predelay: Infinity, variant: 1e12 })) expect(channel.every(Number.isFinite)).toBe(true);
  });
});

describe('reverb', () => {
  it('mixes equal-power, clamping the mix (Flow clamped its reverb amount to 0–100 %)', () => {
    expect(mixGains(0)).toEqual({ dry: 1, wet: 0 });
    expect(mixGains(1).dry).toBeCloseTo(0, 12);
    expect(mixGains(1).wet).toBe(1);
    const half = mixGains(0.5);
    expect(half.dry ** 2 + half.wet ** 2).toBeCloseTo(1, 12);
    expect(mixGains(1.4)).toEqual(mixGains(1));
    expect(mixGains(-0.1)).toEqual(mixGains(0));
    expect(mixGains(NaN)).toEqual(mixGains(0));
  });

  it('keys its impulse by the patch seed and its node id: the same pair renders the same tail, another pair another', async () => {
    const render = (seed: number, nodeId: string) => renderOffline(1, (context) => build(context, (c) => burst(c, 0.1), { params: { mix: 1, decay: 0.5 }, seed, nodeId }));
    const [a, again, otherSeed, otherNode] = await Promise.all([render(7, 'room'), render(7, 'room'), render(8, 'room'), render(7, 'hall')]);
    expect(maxDifference(a, again)).toBe(0);
    expect(maxDifference(a, otherSeed)).toBeGreaterThan(1e-3);
    expect(maxDifference(a, otherNode)).toBeGreaterThan(1e-3);
  });

  it('passes the input untouched at mix 0', async () => {
    const [through, direct] = await Promise.all([
      renderOffline(0.5, (context) => build(context, (c) => sine(c, 440), { params: { mix: 0 } })),
      renderOffline(0.5, (context) => sine(context, 440).connect(context.destination)),
    ]);
    expect(maxDifference(through, direct)).toBeLessThan(RENDER_TOLERANCE);
  });

  it('gives back low tones and white noise at their own level when wet, with Damping taking off highs', async () => {
    // Band noise, not sines: one frequency through a noise impulse gets a random gain, a band the average.
    const [low, flatNoise, darkHigh, brightHigh] = await Promise.all([
      wetOverDry((c) => band(c, 'lowpass', 150), { decay: 1 }),
      wetOverDry((c) => noise(c, 4), { decay: 1, damping: 0 }),
      wetOverDry((c) => band(c, 'highpass', 3000), { decay: 1, damping: 0.95 }),
      wetOverDry((c) => band(c, 'highpass', 3000), { decay: 1, damping: 0 }),
    ]);
    expect(low).toBeGreaterThan(0.8);
    expect(low).toBeLessThan(1.1);
    expect(flatNoise).toBeCloseTo(1, 1);
    expect(darkHigh).toBeLessThan(brightHigh * 0.3);
  });

  it('rings for Decay after a burst, wide on both channels, then falls silent', async () => {
    const audio = await renderOffline(2, (context) => build(context, (c) => burst(c, 0.1), { params: { mix: 1, decay: 1 } }));
    expect(busRms(audio, 0, 0.1)).toBeLessThan(1e-6);
    expect(busRms(audio, 0.3, 0.1, 0)).toBeGreaterThan(0.005);
    expect(busRms(audio, 0.3, 0.1, 1)).toBeGreaterThan(0.005);
    expect(busRms(audio, 0.3, 0.1)).toBeGreaterThan(busRms(audio, 0.8, 0.1) * 5);
    expect(busRms(audio, 1.2, 0.8)).toBeLessThan(1e-6);
    // Two noise streams: the channels are far from equal.
    const [left, right] = audio.channels;
    let dot = 0;
    for (let i = 0.12 * RATE; i < 0.6 * RATE; i++) dot += left![i]! * right![i]!;
    const correlation = dot / (busRms(audio, 0.12, 0.48, 0) * busRms(audio, 0.12, 0.48, 1) * 0.48 * RATE);
    expect(Math.abs(correlation)).toBeLessThan(0.3);
  });

  it('holds the tail back by Predelay', async () => {
    const audio = await renderOffline(0.6, (context) => build(context, (c) => burst(c, 0.1), { params: { mix: 1, decay: 0.5, predelay: 0.15 } }));
    // The burst ends at 0.11 s; with no dry signal nothing comes out until 0.25 s.
    expect(busRms(audio, 0, 0.245)).toBeLessThan(1e-6);
    expect(busRms(audio, 0.26, 0.05)).toBeGreaterThan(0.005);
  });

  it('follows a cabled mix in automate, the same however it is split and after a re-run', async () => {
    // Mix 0 plus a cable that opens it fully from 0.5 s on: dry before, then the wet render's samples.
    const step = { mix: [{ depth: 1, signal: (t: number) => (t >= 0.5 ? 1 : 0) }] };
    const [stepped, wet] = await Promise.all([
      renderOffline(1, (context) => build(context, (c) => sine(c, 440), { params: { mix: 0, decay: 0.3 }, mods: step }).automate!(0, 1, -Infinity)),
      renderOffline(1, (context) => build(context, (c) => sine(c, 440), { params: { mix: 1, decay: 0.3 } })),
    ]);
    expect(busRms(stepped, 0.3, 0.1) / SINE).toBeCloseTo(1, 3);
    expect(maxDifference(slice(stepped, 0.51, 1), slice(wet, 0.51, 1))).toBeLessThan(1e-5);
    const mods = { mix: [{ depth: 0.8, signal: (t: number) => 0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * t) }] };
    const render = (calls: [number, number][]) =>
      renderOffline(1, (context) => {
        const instance = build(context, (c) => sine(c, 440), { params: { mix: 0.1, decay: 0.5 }, mods });
        for (const [t0, t1] of calls) instance.automate!(t0, t1, -Infinity);
      });
    const [one, split, rerun] = await Promise.all([render([[0, 1]]), render([[0, 0.31], [0.31, 0.62], [0.62, 1]]), render([[0, 0.6], [0.2, 0.6], [0.6, 1], [0.75, 1]])]);
    expect(peak(one)).toBeGreaterThan(0.2);
    expect(maxDifference(one, split)).toBeLessThan(RENDER_TOLERANCE);
    expect(maxDifference(one, rerun)).toBeLessThan(RENDER_TOLERANCE);
  });

  it('leaves an uncabled mix alone in automate', async () => {
    const [still, automated] = await Promise.all([
      renderOffline(0.5, (context) => build(context, (c) => sine(c, 440), { params: { decay: 0.3 } })),
      renderOffline(0.5, (context) => build(context, (c) => sine(c, 440), { params: { decay: 0.3 } }).automate!(0, 0.5, -Infinity)),
    ]);
    expect(maxDifference(still, automated)).toBeLessThan(RENDER_TOLERANCE);
  });

  it('gives defined audio for weird params and modulation: NaN, out of range, huge depth, NaN signal', async () => {
    const cases: ContextOptions[] = [
      { params: { decay: NaN, damping: NaN, predelay: NaN, mix: NaN, variant: NaN } },
      { params: { decay: -5, damping: 9, predelay: 7, mix: 1e9, variant: -3 } },
      { params: { decay: 0.3 }, mods: { mix: [{ depth: 1e300, signal: () => 1e300 }] } },
      { params: { decay: 0.3 }, mods: { mix: [{ depth: 1, signal: () => NaN }] } },
    ];
    const renders = await Promise.all(cases.map((options) => renderOffline(0.5, (context) => build(context, (c) => sine(c, 440), options).automate!(0, 0.5, -Infinity))));
    for (const audio of renders) {
      for (const data of audio.channels) expect(data.every(Number.isFinite)).toBe(true);
      expect(peak(audio)).toBeLessThan(2);
    }
  });

  it('ramps a mix edit in place from the swap time instead of jumping', async () => {
    expect(reverb.liveParams).toEqual(['decay', 'damping', 'predelay', 'mix', 'variant']);
    let edit: () => void = () => {};
    const [audio, wet] = await Promise.all([
      renderOffline(1, (context) => {
        const instance = build(context, (c) => sine(c, 440), { params: { mix: 0, decay: 0.3 } });
        edit = () => instance.update!({ ...DEFAULTS, decay: 0.3, mix: 1 }, 0.5);
      }, { edits: [{ time: 0.4, apply: () => edit() }], attempts: 3 }),
      renderOffline(1, (context) => build(context, (c) => sine(c, 440), { params: { mix: 1, decay: 0.3 } })),
    ]);
    // Dry until 0.5 s, then the wet render's samples once the 20 ms ramp is over.
    expect(busRms(audio, 0.4, 0.1) / SINE).toBeCloseTo(1, 3);
    expect(maxDifference(slice(audio, 0.521, 1), slice(wet, 0.521, 1))).toBeLessThan(1e-5);
    // No step: through the ramp the signal moves no faster than the dry sine or the wet signal do on their own.
    expect(largestStep(audio, 0.495, 0.03)).toBeLessThan(Math.max(largestStep(audio, 0.3, 0.1), largestStep(audio, 0.6, 0.3)) * 1.5);
  });

  it('crossfades a Decay edit in place: no click, the old tail rings on, the new one takes over', async () => {
    // A steady sine at mix 1, Decay 0.3 → 4 at 0.5 s; the sine stops at 1.5 s.
    const render = (from: number, to: number | null) => {
      let edit: () => void = () => {};
      return renderOffline(2.6, (context) => {
        const instance = build(context, (c) => {
          const tone = sine(c, 440) as unknown as { gain: AudioParamLike } & AudioNodeLike;
          tone.gain.setValueAtTime(0, 1.5);
          return tone;
        }, { params: { mix: 1, decay: from } });
        edit = () => instance.update!({ ...DEFAULTS, mix: 1, decay: to ?? from }, 0.5);
      }, { edits: to === null ? [] : [{ time: 0.45, apply: () => edit() }], attempts: 3 });
    };
    const [lengthened, short, shortened] = await Promise.all([render(0.3, 4), render(0.3, null), render(4, 0.3)]);
    // No click: around the crossfade the signal moves no faster than it did before.
    expect(largestStep(lengthened, 0.49, 0.07)).toBeLessThan(largestStep(lengthened, 0.3, 0.15) * 1.5);
    expect(largestStep(shortened, 0.49, 0.07)).toBeLessThan(largestStep(shortened, 0.3, 0.15) * 1.5);
    // The level doesn't dip through the crossfade.
    expect(busRms(lengthened, 0.5, IMPULSE_CROSSFADE)).toBeGreaterThan(busRms(lengthened, 0.4, 0.05) * 0.7);
    // The new 4 s tail is playing: half a second after the sine stops it still rings, where 0.3 s is long gone.
    expect(busRms(short, 2, 0.3)).toBeLessThan(1e-6);
    expect(busRms(lengthened, 2, 0.3)).toBeGreaterThan(0.01);
    // Shortened: the old 4 s tail keeps what came in before 0.55 s and rings on rather than being cut,
    // past where the 0.3 s tail of the sine (stopped at 1.5 s) is long gone.
    expect(busRms(short, 1.85, 0.3)).toBeLessThan(1e-6);
    expect(busRms(shortened, 1.85, 0.3)).toBeGreaterThan(1e-3);
  });

  it('builds at most one impulse per crossfade while a knob is dragged, and the latest value wins', () => {
    const fake = fakeContext();
    const instance = reverb.audio!(audioSetup(reverb, fake.context, { params: { decay: 1 } }));
    // A knob dragged through ten values in 100 ms (one edit a 10 ms).
    const decays = Array.from({ length: 10 }, (_, i) => 1.05 + i * 0.1);
    decays.forEach((decay, i) => instance.update!({ ...DEFAULTS, decay }, 0.01 * i));
    // Builds at 0 s (1.05) and 0.05 s (1.55); the rest wait for the next crossfade slot.
    expect(fake.buffers).toEqual([1, 1.05, 1.55].map((d) => Math.round(d * 8000)));
    // Too soon: nothing new.
    instance.automate!(0.09, 0.1, 0.09);
    expect(fake.buffers).toHaveLength(3);
    // Once the last crossfade is over, the latest wanted value, not the ones in between.
    instance.automate!(0.1, 0.125, 0.1);
    expect(fake.buffers.at(-1)).toBe(Math.round(decays.at(-1)! * 8000));
    expect(fake.buffers).toHaveLength(4);
    // A Mix edit alone builds no impulse.
    instance.update!({ ...DEFAULTS, decay: decays.at(-1)!, mix: 0.8 }, 0.2);
    expect(fake.buffers).toHaveLength(4);
  });

  it('keeps at most MAX_TAILS convolvers ringing, fades out exactly the extra ones and disposes tails once silent', () => {
    const fake = fakeContext();
    const instance = reverb.audio!(audioSetup(reverb, fake.context, { params: { decay: 1 } }));
    // Seven edits a crossfade apart: eight impulses, so the oldest four fade out on their returns.
    for (let i = 0; i < 7; i++) instance.update!({ ...DEFAULTS, decay: 1.1 + i * 0.1 }, 0.1 * i);
    expect(fake.convolvers).toHaveLength(8);
    const returns = fake.gains.filter((g) => g.kind === 'ret' && g.ramps.some((r) => r.value === 0));
    expect(returns).toHaveLength(8 - MAX_TAILS);
    // At no time do more than MAX_TAILS sound, plus the one fading out on its return for one crossfade.
    // Past every evicted fade but inside the ringing tails: only the evicted are gone.
    fake.now = 0.7;
    instance.automate!(0.7, 0.725, 0.7);
    expect(fake.convolvers.filter((c) => c.disconnected)).toHaveLength(8 - MAX_TAILS);
    // Past every tail: only the playing one is left.
    fake.now = 10;
    instance.automate!(10, 10.1, 10);
    expect(fake.convolvers.filter((c) => !c.disconnected)).toHaveLength(1);
    expect(fake.convolvers.at(-1)!.disconnected).toBe(false);
  });

  it('rings out its tail after a rebuild: a cable into Mix mid-tail doesn\'t cut it', async () => {
    // A burst at 0.05 s into a 4 s Reverb; at 0.31 s a cable into Mix rebuilds the node.
    const { reports, built, audio } = await tailRun(reverb, { mix: 1, decay: 4 }, 'mix', 2);
    expect(reports[0]!.updated).toEqual([]);
    expect(built).toBe(2);
    // The new instance never heard the burst; the old one keeps ringing until its idleAt.
    expect(busRms(audio, 1.3, 0.2)).toBeGreaterThan(1e-3);
    const fake = fakeContext();
    const instance = reverb.audio!(audioSetup(reverb, fake.context, { params: { decay: 4 } }));
    instance.automate!(0, 0.4, 0);
    expect(instance.idleAt!()).toBeCloseTo(0.4 + IMPULSE_CROSSFADE + 4, 9);
  });

  it('keeps its instance through the runtime for every knob, Decay and Variant included', async () => {
    const { reports, built } = await swapRun(reverb, [{ decay: 0.5 }, { decay: 0.5, mix: 0.8 }, { decay: 1.2, mix: 0.8 }, { decay: 1.2, mix: 0.8, variant: 3, damping: 0.2, predelay: 0.05 }]);
    expect(reports.map((r) => r.updated)).toEqual([['n'], ['n'], ['n']]);
    expect(built).toBe(1);
  });

  it('matches the golden loudness of a burst and of noise through the default Reverb', async () => {
    const [tail, wash] = await Promise.all([
      renderOffline(3.5, (context) => build(context, (c) => burst(c, 0.1), { params: { mix: 1 } })),
      renderOffline(1, (context) => build(context, (c) => noise(c, 1))),
    ]);
    expectGoldenClose('reverb-loudness', { tail: blockLoudness(tail, 0.1), wash: blockLoudness(wash) }, 1e-3);
  });
});

interface FakeParam extends AudioParamLike {
  kind: string;
  ramps: { value: number }[];
}

/** A context that builds nothing audible, recording convolvers and gain ramps, with a settable clock. */
function fakeContext() {
  const convolvers: { disconnected: boolean }[] = [];
  const gains: FakeParam[] = [];
  /** The length in frames of each impulse built. */
  const buffers: number[] = [];
  const state = { now: 0 };
  // The n-th gain made after the shared ones (input, dry, wet, out) alternates send, return.
  let made = 0;
  const param = (kind: string): FakeParam => {
    const p: FakeParam = {
      value: 1, kind, ramps: [],
      setValueAtTime: () => p,
      linearRampToValueAtTime: (value: number) => (p.ramps.push({ value }), p),
      exponentialRampToValueAtTime: () => p,
      setTargetAtTime: () => p,
      cancelScheduledValues: () => p,
    };
    return p;
  };
  const node = () => ({ connect: () => undefined, disconnect: () => undefined });
  const context = {
    get currentTime() {
      return state.now;
    },
    sampleRate: 8000,
    destination: node(),
    createGain: () => {
      const index = made++;
      const gain = param(index < 4 ? 'bus' : (index - 4) % 2 === 0 ? 'send' : 'ret');
      gains.push(gain);
      return { ...node(), gain };
    },
    createConvolver: () => {
      const convolver = { buffer: null, normalize: true, disconnected: false, connect: () => undefined, disconnect: () => void (convolver.disconnected = true) };
      convolvers.push(convolver);
      return convolver;
    },
    createBuffer: (channels: number, length: number, sampleRate: number) => {
      buffers.push(length);
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { sampleRate, length, duration: length / sampleRate, numberOfChannels: channels, getChannelData: (i: number) => data[i]! };
    },
  } as unknown as AudioContextLike;
  return {
    context, convolvers, gains, buffers,
    set now(t: number) {
      state.now = t;
    },
  };
}
