import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import { VoicePool, type AudioContextLike, type AudioInstance, type NoteEvent } from '@flow-patcher/engine';
import { instrumentCache } from '../src/instruments';
import { sampledVoice, STEAL_FADE } from '../src/sampled-voice';
import { midiToHz, simpleSynth } from '../src/simple-synth';
import { blockLoudness, renderOffline, type RenderedAudio } from '../../../tools/lib/audio';
import { audioSetup, vendorSamples } from './helpers';

const RATE = 48000;
const samples = vendorSamples();
const note = (time: number, pitch = 60, duration = 0.3, channel = 0): NoteEvent => ({ time, channel, pitch, velocity: 1, duration });

/** Renders on a fresh context with Sampled Voice's synthstrings loaded, so both instruments can share one pool. */
async function renderShared(seconds: number, setup: (context: AudioContextLike, pool: VoicePool) => void): Promise<RenderedAudio> {
  const context = new OfflineAudioContext(1, Math.round(seconds * RATE), RATE);
  const like = context as unknown as AudioContextLike;
  await instrumentCache.load(like, 'synthstrings', samples);
  setup(like, new VoicePool(() => like.currentTime));
  const buffer = await context.startRendering();
  return { sampleRate: RATE, channels: [buffer.getChannelData(0).slice()] };
}

/** A Simple Synth on `pool`, its output connected only if `connect`. */
function synth(context: AudioContextLike, pool: VoicePool, connect = true, params: Record<string, unknown> = {}): AudioInstance {
  const instance = simpleSynth.audio!(audioSetup(simpleSynth, context, { params: { release: 0.05, ...params }, voices: pool }));
  if (connect) instance.outputs!.audio!.connect(context.destination);
  return instance;
}

/** A Sampled Voice on `pool`, its output connected only if `connect`. */
function sampled(context: AudioContextLike, pool: VoicePool, connect = true): AudioInstance {
  const instance = sampledVoice.audio!(audioSetup(sampledVoice, context, { params: { instrument: 'synthstrings', release: 0.05 }, services: { samples }, voices: pool }));
  if (connect) instance.outputs!.audio!.connect(context.destination);
  return instance;
}

/** RMS of `audio` over [t, t + width). */
function rms(audio: RenderedAudio, t: number, width = 0.01): number {
  const data = audio.channels[0]!, from = Math.round(t * RATE), to = Math.round((t + width) * RATE);
  let sum = 0;
  for (let i = from; i < to; i++) sum += data[i]! ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

describe('simple-synth', () => {
  it('maps MIDI pitch to frequency', () => {
    expect(midiToHz(69)).toBe(440);
    expect(midiToHz(81)).toBe(880);
  });

  it('sounds only while a note plays', async () => {
    const notes: NoteEvent[] = [{ time: 0.2, channel: 0, pitch: 60, velocity: 1, duration: 0.1 }];
    const audio = await renderOffline(1, (context) => {
      const instance = simpleSynth.audio!(audioSetup(simpleSynth, context, { params: { release: 0.1 } }));
      instance.outputs!.audio!.connect(context.destination);
      instance.schedule!('note', notes);
    });
    const blocks = blockLoudness(audio, 0.1);
    expect(blocks[0]).toBe(0);
    expect(blocks[2]).toBeGreaterThan(0.05);
    expect(blocks.slice(5).every((v) => v === 0)).toBe(true);
  });

  it('samples a modulated level once per note, at its start and channel', async () => {
    const notes: NoteEvent[] = [
      { time: 0.1, channel: 0, pitch: 60, velocity: 1, duration: 0.1 },
      { time: 0.6, channel: 0, pitch: 60, velocity: 1, duration: 0.1 },
      { time: 1.1, channel: 1, pitch: 60, velocity: 1, duration: 0.1 },
    ];
    // +0.3 on the level from 0.5 s on, but only on channel 0: notes 1 and 3 play at 0.3, note 2 at 0.6.
    const signal = (t: number, channel: number) => (t >= 0.5 && channel === 0 ? 0.3 : 0);
    const audio = await renderOffline(1.5, (context) => {
      const instance = simpleSynth.audio!(audioSetup(simpleSynth, context, { params: { level: 0.3, release: 0.05 }, mods: { level: [{ depth: 1, signal }] } }));
      instance.outputs!.audio!.connect(context.destination);
      instance.schedule!('note', notes);
    });
    const blocks = blockLoudness(audio, 0.1);
    expect(blocks[6]! / blocks[1]!).toBeCloseTo(2, 1);
    expect(blocks[11]! / blocks[1]!).toBeCloseTo(1, 2);
  });

  it('withdraws a cancelled note before it sounds, and keeps the others', async () => {
    const notes: NoteEvent[] = [
      { time: 0.1, channel: 0, pitch: 60, velocity: 1, duration: 0.1 },
      { time: 0.6, channel: 0, pitch: 60, velocity: 1, duration: 0.1 },
    ];
    const audio = await renderOffline(1, (context) => {
      const instance = simpleSynth.audio!(audioSetup(simpleSynth, context, { params: { release: 0.05 } }));
      instance.outputs!.audio!.connect(context.destination);
      instance.schedule!('note', notes);
      // A copy with the same fields isn't the scheduled event, so it cancels nothing.
      instance.cancel!('note', [{ ...notes[0]! }, notes[1]!]);
    });
    const blocks = blockLoudness(audio, 0.1);
    expect(blocks[1]).toBeGreaterThan(0.05);
    expect(blocks.slice(4).every((v) => v === 0)).toBe(true);
  });

  it('is idle once the last note has released, so a removed synth can finish its notes', async () => {
    let idle: number[] = [];
    await renderOffline(0.2, (context) => {
      const instance = simpleSynth.audio!(audioSetup(simpleSynth, context, { params: { attack: 0.01, release: 0.2 } }));
      idle = [instance.idleAt!()];
      const notes: NoteEvent[] = [
        { time: 0.1, channel: 0, pitch: 60, velocity: 1, duration: 0.3 },
        { time: 0.05, channel: 0, pitch: 64, velocity: 1, duration: 0.1 },
      ];
      instance.schedule!('note', notes);
      idle.push(instance.idleAt!());
      instance.cancel!('note', [notes[0]!]);
      idle.push(instance.idleAt!());
    });
    // Nothing scheduled; then the first note's end (0.1 + 0.3 + 0.2); then the second's, once the first is withdrawn.
    expect(idle[0]).toBe(0);
    expect(idle[1]).toBeCloseTo(0.6, 9);
    expect(idle[2]).toBeCloseTo(0.35, 9);
  });

  it('ignores events that are not notes', async () => {
    const audio = await renderOffline(0.5, (context) => {
      const instance = simpleSynth.audio!(audioSetup(simpleSynth, context));
      instance.outputs!.audio!.connect(context.destination);
      instance.schedule!('note', [{ time: 0.1, channel: 0 }]);
    });
    expect(blockLoudness(audio, 0.5)[0]).toBe(0);
  });

  describe('voices from the runtime pool', () => {
    // 64 notes, each a little later than 0.2 s, all overlapping a note at 0.1 s: the 65th voice.
    const crowd = () => Array.from({ length: 64 }, (_, i) => note(0.2 + i * 0.001, 40 + (i % 40), 0.8));
    const stolenAt = 0.2 + 63 * 0.001;

    it('has a Sampled Voice steal its earliest note, and fades it out', async () => {
      let idle = 0, inUse = 0;
      const audio = await renderShared(1.2, (ctx, pool) => {
        const first = synth(ctx, pool);
        first.schedule!('note', [note(0.1, 60, 0.8)]);
        sampled(ctx, pool, false).schedule!('note', crowd());
        idle = first.idleAt!();
        inUse = pool.inUse();
      });
      expect(idle).toBeCloseTo(stolenAt + STEAL_FADE, 9);
      expect(inUse).toBe(64);
      expect(rms(audio, 0.2, 0.05)).toBeGreaterThan(0.01);
      expect(rms(audio, stolenAt + STEAL_FADE + 0.01, 0.5)).toBe(0);
      // A fade, not a click: the last 10 ms before the stop are much quieter than before the steal.
      expect(rms(audio, stolenAt + 0.03, 0.01)).toBeLessThan(rms(audio, stolenAt - 0.02, 0.01) / 10);
    });

    it("steals a Sampled Voice's earliest note for its own", async () => {
      let idle = 0, inUse = 0, synthIdle = 0;
      const audio = await renderShared(1.2, (ctx, pool) => {
        const first = sampled(ctx, pool);
        first.schedule!('note', [note(0.1, 60, 0.8)]);
        const rest = synth(ctx, pool, false);
        rest.schedule!('note', crowd());
        idle = first.idleAt!();
        synthIdle = rest.idleAt!();
        inUse = pool.inUse();
      });
      expect(idle).toBeCloseTo(stolenAt + STEAL_FADE, 9);
      // None of the synth's own notes was stolen: its last ends at 0.263 + 0.8 + 0.05.
      expect(synthIdle).toBeCloseTo(stolenAt + 0.8 + 0.05, 9);
      expect(inUse).toBe(64);
      expect(rms(audio, 0.2, 0.05)).toBeGreaterThan(0.01);
      expect(rms(audio, stolenAt + STEAL_FADE + 0.01, 0.5)).toBe(0);
    });

    it('is stolen inside its own claim when its note starts before a full pool', async () => {
      let idle = 0, inUse = 0, crowdIdle = 0;
      const audio = await renderShared(1.2, (ctx, pool) => {
        const rest = sampled(ctx, pool, false);
        rest.schedule!('note', crowd());
        // Claimed last, but the earliest start: at 0.263 s it is the oldest of 65, so it goes.
        const late = synth(ctx, pool);
        late.schedule!('note', [note(0.1, 60, 0.8)]);
        idle = late.idleAt!();
        crowdIdle = rest.idleAt!();
        inUse = pool.inUse();
      });
      expect(idle).toBeCloseTo(stolenAt + STEAL_FADE, 9);
      expect(crowdIdle).toBeGreaterThan(1);
      expect(inUse).toBe(64);
      expect(rms(audio, 0.15, 0.05)).toBeGreaterThan(0.01);
      expect(rms(audio, stolenAt + STEAL_FADE + 0.01, 0.5)).toBe(0);
    });

    it('frees a slot on cancel, so the next note steals nothing', async () => {
      const counts: number[] = [];
      let firstIdle = 0;
      const audio = await renderShared(1.2, (ctx, pool) => {
        const first = sampled(ctx, pool);
        first.schedule!('note', [note(0.1, 60, 0.8)]);
        const rest = synth(ctx, pool, false);
        const notes = crowd().slice(0, 63);
        rest.schedule!('note', notes);
        counts.push(pool.inUse());
        rest.cancel!('note', [notes[10]!]);
        counts.push(pool.inUse());
        // The 65th note would have stolen the first; with a slot freed, it fits.
        rest.schedule!('note', [note(stolenAt, 52, 0.8)]);
        counts.push(pool.inUse());
        firstIdle = first.idleAt!();
      });
      expect(counts).toEqual([64, 63, 64]);
      expect(firstIdle).toBeCloseTo(0.1 + 0.8 + 0.05, 9);
      expect(rms(audio, 0.5, 0.1)).toBeGreaterThan(0.01);
    });

    it('skips notes with unusable times or pitches without claiming a voice', async () => {
      let inUse = -1;
      const audio = await renderShared(0.5, (ctx, pool) => {
        const instance = synth(ctx, pool);
        instance.schedule!('note', [note(Number.NaN), note(0.1, Number.NaN), note(Number.POSITIVE_INFINITY), { ...note(0.1), velocity: Number.NaN, duration: Number.NaN }]);
        inUse = pool.inUse();
      });
      // Only the last one sounds: velocity defaults to 1, and a NaN duration holds for the attack.
      expect(inUse).toBe(1);
      expect(rms(audio, 0.1, 0.05)).toBeGreaterThan(0.001);
      expect(rms(audio, 0.2, 0.3)).toBe(0);
    });
  });
});
