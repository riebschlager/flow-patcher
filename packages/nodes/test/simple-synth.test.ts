import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@flow-patcher/engine';
import { midiToHz, simpleSynth } from '../src/simple-synth';
import { blockLoudness, renderOffline } from '../../../tools/lib/audio';
import { audioSetup } from './helpers';

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
});
