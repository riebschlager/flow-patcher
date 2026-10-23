import { describe, expect, it } from 'vitest';
import {
  compilePatch,
  IMMEDIATE_OFFSET,
  inputRouter,
  ManualClock,
  replayInput,
  Runtime,
  Scheduler,
  type EngineEvent,
  type LoggedEvent,
  type Patch,
  type PermissionState,
  type StatusContext,
} from '@flow-patcher/engine';
import { midiIn, nodeRegistry } from '../src';
import { decodeMidi, MIDI_CHANNELS } from '../src/midi-in';
import { context, query, queryTiled } from './helpers';

const NOTE_ON = 0x90, NOTE_OFF = 0x80, CC = 0xb0;
const midi = (time: number, status: number, data1: number, data2: number): EngineEvent => ({ time, channel: 0, status, data1, data2 });

/** Two MIDI channels (1 and 10) playing over each other, with CCs on both and a pitch bend. */
const messages: EngineEvent[] = [
  midi(0.1, NOTE_ON | 0, 60, 127),
  midi(0.12, CC | 0, 1, 64),
  midi(0.2, NOTE_ON | 9, 36, 100),
  midi(0.25, CC | 9, 1, 127),
  midi(0.25, CC | 9, 7, 30),
  midi(0.3, NOTE_OFF | 0, 60, 40),
  midi(0.33, 0xe0 | 0, 0, 64),
  midi(0.4, NOTE_ON | 9, 36, 0),
  midi(0.5, CC | 0, 1, 0),
  midi(0.61, NOTE_ON | 0, 67, 64),
  midi(0.61, NOTE_ON | 0, 71, 64),
];
const pushed = { midi: messages };

const strip = (events: EngineEvent[] | undefined) => (events ?? []).map((e) => ({ ...e }));

describe('midi-in', () => {
  it('has Note, Note On, Note Off, CC and the raw MIDI output, behind the midi permission', () => {
    expect(midiIn.category).toBe('canvas-sources');
    expect(midiIn.ports.map((p) => [p.name, p.type, p.direction])).toEqual([
      ['note', 'note', 'out'],
      ['on', 'event', 'out'],
      ['off', 'event', 'out'],
      ['cc', 'signal', 'out'],
      ['midi', 'event', 'out'],
    ]);
    expect(midiIn.params.map((p) => p.name)).toEqual(['channel', 'controller', 'length']);
    expect(MIDI_CHANNELS).toEqual(['All', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16']);
    expect(midiIn.permission).toBe('midi');
    expect(midiIn.input?.reads).toEqual({ midi: 'midi' });
  });

  it('decodes note-on, note-off, velocity-0 note-on as off, and CC; ignores the rest', () => {
    expect(decodeMidi(midi(0, 0x93, 60, 100))).toEqual({ kind: 'on', midiChannel: 3, data1: 60, data2: 100 });
    expect(decodeMidi(midi(0, 0x93, 60, 0))).toEqual({ kind: 'off', midiChannel: 3, data1: 60, data2: 0 });
    expect(decodeMidi(midi(0, 0x8f, 60, 12))).toEqual({ kind: 'off', midiChannel: 15, data1: 60, data2: 12 });
    expect(decodeMidi(midi(0, 0xb0, 74, 1))).toEqual({ kind: 'cc', midiChannel: 0, data1: 74, data2: 1 });
    for (const status of [0xa0, 0xc0, 0xd0, 0xe0, 0xf8, 0x40]) expect(decodeMidi(midi(0, status, 1, 1)), status.toString(16)).toBeNull();
    // Weird fields: NaN, fractional, out of range, missing, strings.
    for (const bad of [
      midi(0, NaN, 60, 1), midi(0, 0x90, 60.5, 1), midi(0, 0x90, 128, 1), midi(0, 0x90, 60, -1), midi(0, 256, 60, 1),
      { time: 0, channel: 0, status: 0x90 }, { time: 0, channel: 0, status: '144', data1: 60, data2: 1 },
    ]) expect(decodeMidi(bad)).toBeNull();
  });

  it('emits a Note at each note-on, on MIDI channel + 1, with velocity 0–1 and the Length knob as duration', () => {
    const out = query(midiIn, 0, 1, { pushed, params: { length: 0.5 } });
    expect(strip(out.note)).toEqual([
      { time: 0.1, channel: 1, pitch: 60, velocity: 1, duration: 0.5 },
      { time: 0.2, channel: 10, pitch: 36, velocity: 100 / 127, duration: 0.5 },
      { time: 0.61, channel: 1, pitch: 67, velocity: 64 / 127, duration: 0.5 },
      { time: 0.61, channel: 1, pitch: 71, velocity: 64 / 127, duration: 0.5 },
    ]);
    // The default Length is Make Note's, a quarter second; out of range clamps like the knob.
    expect(query(midiIn, 0, 1, { pushed }).note!.map((n) => n.duration)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(query(midiIn, 0, 1, { pushed, params: { length: 100 } }).note!.map((n) => n.duration)).toEqual([8, 8, 8, 8]);
    expect(query(midiIn, 0, 1, { pushed, params: { length: NaN } }).note!.map((n) => n.duration)).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it('emits Note On and Note Off with pitch and velocity; a velocity-0 note-on is an off and makes no Note', () => {
    const out = query(midiIn, 0, 1, { pushed });
    expect(strip(out.on)).toEqual([
      { time: 0.1, channel: 1, pitch: 60, velocity: 1 },
      { time: 0.2, channel: 10, pitch: 36, velocity: 100 / 127 },
      { time: 0.61, channel: 1, pitch: 67, velocity: 64 / 127 },
      { time: 0.61, channel: 1, pitch: 71, velocity: 64 / 127 },
    ]);
    expect(strip(out.off)).toEqual([
      { time: 0.3, channel: 1, pitch: 60, velocity: 40 / 127 },
      { time: 0.4, channel: 10, pitch: 36, velocity: 0 },
    ]);
    // It never returns the raw MIDI events: the runtime merges those itself.
    expect(out.midi).toBeUndefined();
  });

  it('passes only the chosen MIDI channel to the derived outputs', () => {
    const ten = query(midiIn, 0, 1, { pushed, params: { channel: '10' } });
    expect(ten.note!.map((n) => [n.time, n.channel, n.pitch])).toEqual([[0.2, 10, 36]]);
    expect(ten.off!.map((n) => [n.time, n.channel])).toEqual([[0.4, 10]]);
    expect(query(midiIn, 0, 1, { pushed, params: { channel: '16' } })).toEqual({ note: [], on: [], off: [] });
    // An unknown menu value falls back to the default, All.
    expect(query(midiIn, 0, 1, { pushed, params: { channel: '17' } }).note).toHaveLength(4);
  });

  it('gives the same events in 25 ms, 100 ms and one window', () => {
    for (const port of ['note', 'on', 'off']) {
      const whole = query(midiIn, 0, 1, { pushed })[port];
      expect(queryTiled(midiIn, port, 1, 0.025, { pushed }), port).toEqual(whole);
      expect(queryTiled(midiIn, port, 1, 0.1, { pushed }), port).toEqual(whole);
    }
  });

  it('emits nothing without pushes, and survives weird windows and payloads', () => {
    expect(queryTiled(midiIn, 'note', 2, 0.025)).toEqual([]);
    for (const [t0, t1] of [[1, 1], [2, 1], [NaN, 1], [0, Infinity], [-Infinity, NaN]]) expect(query(midiIn, t0!, t1!)).toEqual({ note: [], on: [], off: [] });
    const weird = { midi: [midi(0.1, NaN, 60, 100), { time: 0.2, channel: 0 }, midi(0.3, 0x90, 999, 1), { time: 0.4, channel: 0, status: 'x', data1: true, data2: 1 } as EngineEvent] };
    expect(query(midiIn, 0, 1, { pushed: weird })).toEqual({ note: [], on: [], off: [] });
  });
});

/** Queries [0, 1) in windows of `step` on one state and reads CC on `channels` at `times`, after the window holding each. */
function readCC(step: number, times: number[], channels: number[], params: Record<string, unknown> = {}): number[][] {
  const state: Record<string, unknown> = {};
  const ctx = context(midiIn, { state, params });
  const rows: number[][] = [];
  for (let i = 0; i * step < 1 - 1e-9; i++) {
    const t0 = i * step, t1 = Math.min(1, (i + 1) * step);
    query(midiIn, t0, t1, { state, pushed, params });
    for (const t of times.filter((time) => time >= t0 && time < t1)) rows.push(channels.map((channel) => midiIn.signal!(ctx, 'cc', t, channel)));
    // Snapshots must clone: plain data only.
    expect(() => structuredClone(state)).not.toThrow();
  }
  return rows;
}

describe('midi-in CC', () => {
  const times = [0, 0.11, 0.12, 0.2, 0.25, 0.3, 0.5, 0.9];
  // Channel 0 latest, then MIDI channels 1 and 10 (signal channels 1 and 10), 2 (never sent), and 99 (latest).
  const channels = [0, 1, 10, 2, 99];

  it('holds CC 1 per MIDI channel, 0–1, with channel 0 the latest', () => {
    expect(readCC(1, times, channels)).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [64 / 127, 64 / 127, 0, 0, 64 / 127],
      [64 / 127, 64 / 127, 0, 0, 64 / 127],
      [1, 64 / 127, 1, 0, 1],
      [1, 64 / 127, 1, 0, 1],
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
    ]);
  });

  it('reads the CC Number knob, and the Channel filter', () => {
    // CC 7 only came on MIDI channel 10, at 0.25.
    expect(readCC(1, [0.2, 0.25, 0.9], [0, 10, 1], { controller: 7 })).toEqual([[0, 0, 0], [30 / 127, 30 / 127, 0], [30 / 127, 30 / 127, 0]]);
    // With Channel 1, the channel-10 CCs don't count, not even as the latest.
    expect(readCC(1, [0.12, 0.25, 0.5], [0, 1, 10], { channel: '1' })).toEqual([[64 / 127, 64 / 127, 0], [64 / 127, 64 / 127, 0], [0, 0, 0]]);
  });

  it('reads the same however time was split into windows', () => {
    const reference = readCC(1, times, channels);
    expect(readCC(0.025, times, channels)).toEqual(reference);
    expect(readCC(0.1, times, channels)).toEqual(reference);
    expect(readCC(0.07, times, channels)).toEqual(reference);
  });

  it('starts over when the CC Number or Channel changes, and keeps its state for a new Length', () => {
    const base = { channel: 'All', controller: 1, length: 0.25 };
    expect(midiIn.keepState!(base, { ...base, length: 1 })).toBe(true);
    expect(midiIn.keepState!(base, { ...base, controller: 7 })).toBe(false);
    expect(midiIn.keepState!(base, { ...base, channel: '2' })).toBe(false);
  });
});

describe('midi-in permission', () => {
  const statusFor = (permission: PermissionState | undefined) =>
    midiIn.status!({ nodeId: 'm', params: {}, audio: {} as StatusContext['audio'], services: {}, permission });

  it('shows the blocked state when denied or unsupported, and nothing when granted or not asked yet', () => {
    expect(statusFor('denied')).toEqual({ kind: 'blocked', message: 'MIDI blocked — Allow in browser settings' });
    expect(statusFor('unsupported')).toEqual({ kind: 'blocked', message: "MIDI isn't available in this browser" });
    for (const state of ['granted', 'pending', 'unasked', undefined] as const) expect(statusFor(state), String(state)).toBeNull();
  });
});

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });

/** MIDI In's Note into a synth, as in examples/midi-in.flowpatch, without the audio. */
const patch: Patch = {
  format: 'flowpatch',
  version: 1,
  seed: 1,
  nodes: [node('m', 'midi-in', { length: 0.4 }), node('synth', 'simple-synth')],
  cables: [{ from: { node: 'm', port: 'note' }, to: { node: 'synth', port: 'note' } }],
};

function plan() {
  const compiled = compilePatch(patch, nodeRegistry);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return compiled.plan;
}
const pick = (log: LoggedEvent[], port: string) => log.filter((e) => e.node === 'm' && e.port === port).map(({ node: _n, port: _p, ...e }) => e);

describe('midi-in in a patch', () => {
  it('reads the stream\'s midi events onto MIDI, on channel 0, unchanged', () => {
    const router = inputRouter(plan());
    expect([...router.types]).toEqual(['midi']);
    expect(router.route({ type: 'midi', status: 0x90, data1: 60, data2: 100 })).toEqual([{ node: 'm', port: 'midi', fields: { channel: 0, status: 0x90, data1: 60, data2: 100 } }]);
  });

  it('replays a stream: raw MIDI passes through, Notes follow, and windows don\'t matter', () => {
    const stream = { events: messages.map(({ time, status, data1, data2 }) => ({ time, type: 'midi' as const, status, data1, data2 })) };
    const run = (step: number) => {
      const rt = new Runtime(plan());
      replayInput(rt, stream);
      const log: LoggedEvent[] = [];
      for (let i = 0; i * step < 1 - 1e-9; i++) log.push(...rt.query(i * step, Math.min(1, (i + 1) * step)));
      return log;
    };
    const log = run(1);
    expect(pick(log, 'midi')).toEqual(messages);
    expect(pick(log, 'note').map((e) => [e.time, e.channel, e.pitch, e.duration])).toEqual([[0.1, 1, 60, 0.4], [0.2, 10, 36, 0.4], [0.61, 1, 67, 0.4], [0.61, 1, 71, 0.4]]);
    expect(JSON.stringify(run(0.025))).toBe(JSON.stringify(log));
    expect(JSON.stringify(run(0.1))).toBe(JSON.stringify(log));
  });

  it('a live note-on lands at currentTime + 5 ms with its Note, after windows already queried', () => {
    const clock = new ManualClock();
    const scheduler = new Scheduler(new Runtime(plan()), { clock, record: true });
    for (let k = 0; k < 40; k++) {
      clock.set(k * 0.025);
      scheduler.wake();
    }
    clock.set(1.0123);
    const [event] = scheduler.pushAll(inputRouter(plan()).route({ type: 'midi', status: 0x92, data1: 64, data2: 127 }))!;
    expect(event).toEqual({ time: 1.0123 + IMMEDIATE_OFFSET, channel: 0, status: 0x92, data1: 64, data2: 127 });
    expect(pick(scheduler.events(), 'note')).toEqual([{ time: event!.time, channel: 3, pitch: 64, velocity: 1, duration: 0.4 }]);
  });
});
