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

  it('ignores events that are not notes', async () => {
    const audio = await renderOffline(0.5, (context) => {
      const instance = simpleSynth.audio!(audioSetup(simpleSynth, context));
      instance.outputs!.audio!.connect(context.destination);
      instance.schedule!('note', [{ time: 0.1, channel: 0 }]);
    });
    expect(blockLoudness(audio, 0.5)[0]).toBe(0);
  });
});
