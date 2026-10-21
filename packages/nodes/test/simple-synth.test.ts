import { describe, expect, it } from 'vitest';
import { resolveParams, type NoteEvent } from '@flow-patcher/engine';
import { midiToHz, simpleSynth } from '../src/simple-synth';
import { blockLoudness, renderOffline } from '../../../tools/lib/audio';

describe('simple-synth', () => {
  it('maps MIDI pitch to frequency', () => {
    expect(midiToHz(69)).toBe(440);
    expect(midiToHz(81)).toBe(880);
  });

  it('sounds only while a note plays', async () => {
    const notes: NoteEvent[] = [{ time: 0.2, channel: 0, pitch: 60, velocity: 1, duration: 0.1 }];
    const audio = await renderOffline(1, (context) => {
      const instance = simpleSynth.audio!({ audio: context, params: resolveParams(simpleSynth, { release: 0.1 }), state: {} });
      instance.outputs!.audio!.connect(context.destination);
      instance.schedule!('note', notes);
    });
    const blocks = blockLoudness(audio, 0.1);
    expect(blocks[0]).toBe(0);
    expect(blocks[2]).toBeGreaterThan(0.05);
    expect(blocks.slice(5).every((v) => v === 0)).toBe(true);
  });

  it('ignores events that are not notes', async () => {
    const audio = await renderOffline(0.5, (context) => {
      const instance = simpleSynth.audio!({ audio: context, params: resolveParams(simpleSynth, {}), state: {} });
      instance.outputs!.audio!.connect(context.destination);
      instance.schedule!('note', [{ time: 0.1, channel: 0 }]);
    });
    expect(blockLoudness(audio, 0.5)[0]).toBe(0);
  });
});
