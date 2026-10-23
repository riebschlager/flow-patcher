// The Web MIDI host: every input, inputs connected later, one event per channel message (ADR 0004, 0029).
import { describe, expect, it } from 'vitest';
import type { InputFields } from '@flow-patcher/engine';
import { midiEvent, MidiHost, type MidiAccessLike } from '../src/midi';

/** A MIDIAccess stand-in: inputs are EventTargets that `send` dispatches a midimessage on. */
function fakeAccess() {
  const inputs = new Map<string, EventTarget>();
  const access = Object.assign(new EventTarget(), { inputs });
  const connect = (id: string) => {
    inputs.set(id, new EventTarget());
    access.dispatchEvent(new Event('statechange'));
  };
  const send = (id: string, bytes: number[]) => inputs.get(id)!.dispatchEvent(Object.assign(new Event('midimessage'), { data: new Uint8Array(bytes) }));
  return { access: access as unknown as MidiAccessLike, inputs, connect, send };
}

describe('midiEvent', () => {
  it('turns channel messages into midi events with status, data1 and data2', () => {
    expect(midiEvent([0x90, 60, 100])).toEqual({ type: 'midi', status: 0x90, data1: 60, data2: 100 });
    expect(midiEvent([0xb3, 1, 0])).toEqual({ type: 'midi', status: 0xb3, data1: 1, data2: 0 });
    // Two-byte messages have no data2.
    expect(midiEvent([0xc0, 5])).toEqual({ type: 'midi', status: 0xc0, data1: 5 });
  });

  it('skips system messages, running-status data and malformed bytes', () => {
    for (const bytes of [[0xf8], [0xfe], [0xf0, 1, 2, 0xf7], [60, 100], [], [0x90], [0x90, 200, 1]]) expect(midiEvent(bytes), bytes.join(',')).toBeNull();
    expect(midiEvent(null)).toBeNull();
  });
});

describe('MidiHost', () => {
  it('pushes messages from every input, and from inputs connected later, until disposed', () => {
    const pushed: InputFields[] = [];
    const host = new MidiHost((event) => pushed.push(event));
    const midi = fakeAccess();
    midi.inputs.set('a', new EventTarget());
    host.attach(midi.access);
    expect(host.listening).toBe(1);
    midi.send('a', [0x90, 60, 100]);
    midi.connect('b');
    expect(host.listening).toBe(2);
    midi.send('b', [0x81, 62, 0]);
    midi.send('b', [0xf8]);
    // A second statechange doesn't listen twice.
    midi.connect('c');
    midi.send('a', [0xb0, 1, 64]);
    expect(pushed).toEqual([
      { type: 'midi', status: 0x90, data1: 60, data2: 100 },
      { type: 'midi', status: 0x81, data1: 62, data2: 0 },
      { type: 'midi', status: 0xb0, data1: 1, data2: 64 },
    ]);
    host.dispose();
    midi.send('a', [0x90, 61, 100]);
    midi.connect('d');
    expect(pushed).toHaveLength(3);
    expect(host.listening).toBe(0);
  });

  it('keeps the first access it gets, and ignores one after dispose', () => {
    const pushed: InputFields[] = [];
    const host = new MidiHost((event) => pushed.push(event));
    const first = fakeAccess(), second = fakeAccess();
    first.inputs.set('a', new EventTarget());
    second.inputs.set('a', new EventTarget());
    host.attach(first.access);
    host.attach(second.access);
    second.send('a', [0x90, 60, 1]);
    expect(pushed).toEqual([]);
    host.dispose();
    const late = new MidiHost((event) => pushed.push(event));
    late.dispose();
    late.attach(second.access);
    second.send('a', [0x90, 60, 1]);
    expect(pushed).toEqual([]);
  });
});
