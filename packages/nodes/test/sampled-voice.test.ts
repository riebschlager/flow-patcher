// Sampled Voice on headless node-web-audio-api, with the real vendor/ samples
// through an fs `samples` service. Flow's audio-lifetime.test.mjs (cancelled
// notes stay silent, 64-voice stealing picks the oldest) is covered here
// against the runtime pool instead of WebAudioFont's envelope list.
import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import { VoicePool, type AudioContextLike, type AudioInstance, type NoteEvent } from '@flow-patcher/engine';
import { instrumentCache } from '../src/instruments';
import { sampledVoice, skippedNotes, STEAL_FADE } from '../src/sampled-voice';
import { blockLoudness, type RenderedAudio } from '../../../tools/lib/audio';
import { audioSetup, vendorSamples } from './helpers';

const RATE = 48000;
const samples = vendorSamples();

/** Renders on a fresh context, with `instrument` loaded into the shared cache first (null: nothing preloaded). */
async function render(seconds: number, setup: (context: AudioContextLike) => void, instrument: string | null = 'synthstrings'): Promise<RenderedAudio> {
  const context = new OfflineAudioContext(1, Math.round(seconds * RATE), RATE);
  const like = context as unknown as AudioContextLike;
  if (instrument) await instrumentCache.load(like, instrument, samples);
  setup(like);
  const buffer = await context.startRendering();
  return { sampleRate: RATE, channels: [buffer.getChannelData(0).slice()] };
}

const note = (time: number, pitch = 60, duration = 0.3, channel = 0): NoteEvent => ({ time, channel, pitch, velocity: 1, duration });

function voice(context: AudioContextLike, params: Record<string, unknown> = {}, options: Parameters<typeof audioSetup>[2] = {}): AudioInstance & { state: Record<string, unknown> } {
  const setup = audioSetup(sampledVoice, context, { params: { instrument: 'synthstrings', ...params }, services: { samples }, ...options });
  const instance = sampledVoice.audio!(setup);
  instance.outputs!.audio!.connect(context.destination);
  return Object.assign(instance, { state: setup.state as Record<string, unknown> });
}

/** RMS of `audio` over [t, t + width). */
function rms(audio: RenderedAudio, t: number, width = 0.01): number {
  const data = audio.channels[0]!, from = Math.round(t * RATE), to = Math.round((t + width) * RATE);
  let sum = 0;
  for (let i = from; i < to; i++) sum += data[i]! ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

describe('sampled-voice', () => {
  it('shapes a note with attack, decay, sustain and release', async () => {
    // Divide by the same note under a flat envelope: what's left is the envelope.
    const shaped = await render(1.1, (ctx) => voice(ctx, { attack: 0.1, decay: 0.1, sustain: 0.5, release: 0.3, cutoff: 20000 }).schedule!('note', [note(0.1, 60, 0.5)]));
    const flat = await render(1.1, (ctx) => voice(ctx, { attack: 0, decay: 0, sustain: 1, release: 0, cutoff: 20000 }).schedule!('note', [note(0.1, 60, 2)]));
    const gain = (t: number) => rms(shaped, t - 0.005) / rms(flat, t - 0.005);
    expect(rms(shaped, 0, 0.1)).toBe(0);
    expect(gain(0.15)).toBeCloseTo(0.5, 1); // halfway up the attack
    expect(gain(0.2)).toBeCloseTo(1, 1); // the peak
    expect(gain(0.25)).toBeCloseTo(0.75, 1); // halfway down the decay
    expect(gain(0.45)).toBeCloseTo(0.5, 1); // sustain
    expect(gain(0.75)).toBeCloseTo(0.25, 1); // halfway through the release
    expect(rms(shaped, 0.91, 0.18)).toBe(0); // silent after release
    expect(rms(flat, 0.91, 0.18)).toBeGreaterThan(0.01);
  });

  it('scales by velocity, level and the instrument gain', async () => {
    const at = (params: Record<string, unknown>, velocity: number) => render(0.5, (ctx) => voice(ctx, params).schedule!('note', [{ ...note(0.1), velocity }]));
    const full = rms(await at({}, 1), 0.2, 0.1);
    expect(rms(await at({}, 0.5), 0.2, 0.1) / full).toBeCloseTo(0.5, 2);
    expect(rms(await at({ level: 2 }, 1), 0.2, 0.1) / full).toBeCloseTo(2, 2);
    expect(full).toBeGreaterThan(0.01);
    expect(full).toBeLessThan(0.3);
  });

  it('samples modulated params at each note, on its channel', async () => {
    const signal = (t: number, channel: number) => (t >= 0.5 && channel === 0 ? 1 : 0);
    const audio = await render(1.5, (ctx) => voice(ctx, { level: 0.5, release: 0 }, { mods: { level: [{ depth: 1, signal }] } }).schedule!('note', [note(0.1), note(0.6), note(1.1, 60, 0.3, 1)]));
    expect(rms(audio, 0.2, 0.1) / rms(audio, 0.7, 0.1)).toBeCloseTo(1 / 3, 2);
    expect(rms(audio, 1.2, 0.1) / rms(audio, 0.2, 0.1)).toBeCloseTo(1, 2);
  });

  it('glides playbackRate from the previous note on the channel', async () => {
    const sources: [string, number, number][][] = [];
    await render(1, (ctx) => {
      const create = ctx.createBufferSource.bind(ctx);
      ctx.createBufferSource = () => {
        const source = create(), rate = source.playbackRate, set = rate.setValueAtTime.bind(rate), ramp = rate.exponentialRampToValueAtTime.bind(rate);
        const calls: [string, number, number][] = [];
        sources.push(calls);
        rate.setValueAtTime = (v, t) => (calls.push(['set', v, t]), set(v, t));
        rate.exponentialRampToValueAtTime = (v, t) => (calls.push(['ramp', v, t]), ramp(v, t));
        return source;
      };
      voice(ctx, { glide: 0.5, glideTime: 0.1 }).schedule!('note', [note(0.1, 60), note(0.4, 72), note(0.5, 50, 0.3, 1)]);
    });
    const [first, second, third] = sources;
    // The first note on each channel has nothing to glide from.
    expect(first).toHaveLength(1);
    expect(third).toHaveLength(1);
    // Half of the octave below, then an exponential ramp to the target rate over 0.1 s.
    const target = second![0]![1];
    expect(second).toEqual([['set', target, 0.4], ['set', expect.closeTo(target * 2 ** -0.5, 9), 0.4], ['ramp', target, expect.closeTo(0.5, 9)]]);
  });

  it('sounds different with glide on, and only at the start of the gliding note', async () => {
    const play = (glide: number) => render(1, (ctx) => voice(ctx, { glide, glideTime: 0.2, release: 0 }).schedule!('note', [note(0.1, 48, 0.3), note(0.5, 60, 0.4)]));
    const [plain, bent] = [await play(0), await play(1)];
    const diff = (from: number, to: number) => {
      let max = 0;
      for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) max = Math.max(max, Math.abs(plain.channels[0]![i]! - bent.channels[0]![i]!));
      return max;
    };
    expect(diff(0, 0.5)).toBe(0);
    expect(diff(0.5, 0.7)).toBeGreaterThan(0.01);
  });

  it('steals the earliest voice past 64 and fades it out', async () => {
    const pool: { current?: VoicePool } = {};
    let idle = 0, inUse = 0;
    const audio = await render(1.2, (ctx) => {
      pool.current = new VoicePool(() => ctx.currentTime);
      const first = voice(ctx, {}, { voices: pool.current });
      const rest = sampledVoice.audio!(audioSetup(sampledVoice, ctx, { params: { instrument: 'synthstrings' }, services: { samples }, voices: pool.current }));
      first.schedule!('note', [note(0.1, 60, 0.8)]);
      // 64 more, each a little later, all overlapping the first; their output isn't connected.
      rest.schedule!('note', Array.from({ length: 64 }, (_, i) => note(0.2 + i * 0.001, 40 + (i % 40), 0.8)));
      idle = first.idleAt!();
      inUse = pool.current.inUse();
    });
    const stolenAt = 0.2 + 63 * 0.001;
    expect(idle).toBeCloseTo(stolenAt + STEAL_FADE, 9);
    expect(inUse).toBe(64);
    expect(rms(audio, 0.2, 0.05)).toBeGreaterThan(0.01);
    expect(rms(audio, stolenAt + STEAL_FADE + 0.01, 0.5)).toBe(0);
    // A fade, not a click: the last 10 ms before the stop are much quieter than before the steal.
    expect(rms(audio, stolenAt + 0.03, 0.01)).toBeLessThan(rms(audio, stolenAt - 0.02, 0.01) / 10);
  });

  it('keeps a cancelled note silent and frees its voice', async () => {
    let before = 0, after = 0;
    const audio = await render(1.2, (ctx) => {
      const pool = new VoicePool(() => ctx.currentTime);
      const instance = voice(ctx, { release: 0.05 }, { voices: pool });
      const notes = [note(0.1, 60, 0.2), note(0.6, 60, 0.2)];
      instance.schedule!('note', notes);
      before = pool.inUse();
      // A copy with the same fields isn't the scheduled event, so it cancels nothing.
      instance.cancel!('note', [{ ...notes[0]! }, notes[1]!]);
      after = pool.inUse();
    });
    expect([before, after]).toEqual([2, 1]);
    expect(rms(audio, 0.15, 0.1)).toBeGreaterThan(0.01);
    expect(blockLoudness(audio, 0.1).slice(4).every((v) => v === 0)).toBe(true);
  });

  it('is idle once its last voice has released', async () => {
    const idle: number[] = [];
    await render(0.2, (ctx) => {
      const instance = voice(ctx, { attack: 0.01, release: 0.2 });
      idle.push(instance.idleAt!());
      const notes = [note(0.1, 60, 0.3), note(0.05, 64, 0.1)];
      instance.schedule!('note', notes);
      idle.push(instance.idleAt!());
      instance.cancel!('note', [notes[0]!]);
      idle.push(instance.idleAt!());
    });
    expect(idle[0]).toBe(0);
    expect(idle[1]).toBeCloseTo(0.6, 9);
    expect(idle[2]).toBeCloseTo(0.35, 9);
  });

  it('ends an unlooped sample with the sample, not the envelope', async () => {
    let idle = 0;
    await render(0.2, (ctx) => {
      // Prismatic air is the one instrument with an unlooped zone.
      const instance = voice(ctx, { instrument: 'prismaticair', release: 8 });
      instance.schedule!('note', [note(0.1, 60, 8)]);
      idle = instance.idleAt!();
    }, 'prismaticair');
    expect(idle).toBeGreaterThan(0.2);
    expect(idle).toBeLessThan(0.1 + 8);
  });

  it('shares the cache between instances and across a rebuild', async () => {
    const counted = vendorSamples();
    const context = new OfflineAudioContext(1, RATE, RATE) as unknown as AudioContextLike;
    const make = () => sampledVoice.audio!(audioSetup(sampledVoice, context, { params: { instrument: 'celesta' }, services: { samples: counted } }));
    const a = make(), b = make();
    expect(instrumentCache.status(context, 'celesta')).toBe('loading');
    await instrumentCache.load(context, 'celesta', counted);
    a.dispose!();
    const rebuilt = make();
    expect(instrumentCache.status(context, 'celesta')).toBe('ready');
    expect(counted.calls).toEqual(['0080_FluidR3_GM_sf2_file.js']);
    b.dispose!();
    rebuilt.dispose!();
  });

  it('retries a failed load when the node is built again', async () => {
    const context = new OfflineAudioContext(1, RATE, RATE) as unknown as AudioContextLike;
    let fail = true;
    const flaky = async (file: string) => {
      if (fail) { fail = false; throw new Error('offline'); }
      return samples(file);
    };
    const build = () => sampledVoice.audio!(audioSetup(sampledVoice, context, { params: { instrument: 'musicbox' }, services: { samples: flaky } }));
    build();
    await expect(instrumentCache.load(context, 'musicbox', flaky)).rejects.toThrow('offline');
    expect(instrumentCache.status(context, 'musicbox')).toBe('error');
    build();
    expect(instrumentCache.status(context, 'musicbox')).toBe('loading');
    await instrumentCache.load(context, 'musicbox', flaky);
    expect(instrumentCache.status(context, 'musicbox')).toBe('ready');
  });

  it('skips and counts notes that arrive before the instrument is ready, and plays later ones', async () => {
    let instance!: ReturnType<typeof voice>;
    const audio = await render(1, (ctx) => {
      instance = voice(ctx, { instrument: 'ocarina' });
      instance.schedule!('note', [note(0.1), note(0.2)]);
    }, null);
    expect(skippedNotes(instance.state)).toBe(2);
    expect(rms(audio, 0, 1)).toBe(0);
    expect(skippedNotes(undefined)).toBe(0);
    // Without a samples service the instrument can never load: every note is skipped.
    let bare!: AudioInstance & { state: Record<string, unknown> };
    await render(0.5, (ctx) => {
      bare = voice(ctx, { instrument: 'piano' }, { services: {} });
      bare.schedule!('note', [note(0.1)]);
    }, null);
    expect(skippedNotes(bare.state)).toBe(1);
  });

  it('ignores events that are not notes, and notes with unusable fields', async () => {
    let instance!: ReturnType<typeof voice>;
    const audio = await render(0.5, (ctx) => {
      instance = voice(ctx);
      instance.schedule!('note', [{ time: 0.1, channel: 0 }, { ...note(0.1), pitch: Number.NaN }]);
    });
    expect(rms(audio, 0, 0.5)).toBe(0);
    expect(skippedNotes(instance.state)).toBe(0);
    // Odd but finite fields still play: pitch clamps to MIDI, a zero duration gets the shortest gate.
    const odd = await render(0.5, (ctx) => voice(ctx).schedule!('note', [{ ...note(0.1), pitch: 300, duration: 0, velocity: Number.NaN }]));
    expect(rms(odd, 0.1, 0.05)).toBeGreaterThan(0);
  });
});
