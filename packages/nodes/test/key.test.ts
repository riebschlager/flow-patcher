import { describe, expect, it } from 'vitest';
import {
  compilePatch,
  IMMEDIATE_OFFSET,
  inputRouter,
  ManualClock,
  NODE_EVENT_LIMIT,
  replayInput,
  Runtime,
  Scheduler,
  type EngineEvent,
  type InputEvent,
  type LoggedEvent,
  type Patch,
} from '@flow-patcher/engine';
import { key, nodeRegistry } from '../src';
import { channelOf, checkHeld, heldCodes, KEY_CODES, OTHER_CHANNELS, PIANO, pitchOf } from '../src/key';
import { context, query, queryTiled } from './helpers';

/** A keydown or keyup push as the host sends it: no channel (0), the code is the key. */
const k = (time: number, code: string, fields: Record<string, unknown> = {}): EngineEvent =>
  ({ time, channel: 0, key: code.replace(/^Key/, '').toLowerCase(), code, shift: false, alt: false, ctrl: false, meta: false, repeat: false, ...fields }) as EngineEvent;
const rep = (time: number, code: string) => k(time, code, { repeat: true });

const A = channelOf('KeyA'), Z = channelOf('KeyZ'), Q = channelOf('KeyQ'), SPACE = channelOf('Space');

/** Two keys overlapping, with repeats, a lost keyup, a stray keyup and a modifier. */
const pushed: Record<string, EngineEvent[]> = {
  down: [
    k(0.1, 'KeyZ'), rep(0.15, 'KeyZ'), rep(0.18, 'KeyZ'),
    k(0.2, 'KeyQ', { shift: true }), k(0.2, 'ShiftLeft', { key: 'Shift', shift: true }),
    k(0.5, 'Space', { key: ' ' }),
    k(0.6, 'Space', { key: ' ' }),
    k(0.7, 'KeyA'),
    rep(0.75, 'KeyM'),
  ],
  up: [k(0.3, 'KeyZ'), k(0.35, 'ShiftLeft', { key: 'Shift' }), k(0.4, 'KeyQ'), k(0.45, 'KeyX'), k(0.8, 'Space', { key: ' ' }), k(0.9, 'KeyA')],
};

const times = (events: EngineEvent[] | undefined) => (events ?? []).map((e) => [e.time, e.channel]);

describe('key', () => {
  it('has Down, Up, All, Note and Held, and reads keydown and keyup', () => {
    expect(key.category).toBe('canvas-sources');
    expect(key.ports.map((p) => [p.name, p.type, p.direction])).toEqual([
      ['down', 'event', 'out'],
      ['up', 'event', 'out'],
      ['all', 'event', 'out'],
      ['note', 'note', 'out'],
      ['held', 'signal', 'out'],
    ]);
    expect(key.params.map((p) => [p.name, p.default])).toEqual([['keys', 'Space'], ['piano', false], ['octave', 3], ['velocity', 0.8], ['length', 0.25]]);
    expect(key.input).toEqual({ reads: { keydown: 'down', keyup: 'up' }, rewrites: true });
  });

  it('gives each code a fixed channel: letters 1–26, digits next, others from the list, the rest hashed to 1000–9999', () => {
    expect([A, channelOf('KeyB'), Z, channelOf('Digit0'), channelOf('Digit9')]).toEqual([1, 2, 26, 27, 36]);
    expect(new Set(KEY_CODES).size).toBe(KEY_CODES.length);
    expect(new Set(KEY_CODES.map(channelOf)).size).toBe(KEY_CODES.length);
    for (const code of ['MediaPlayPause', 'F25', 'x', '']) {
      const channel = channelOf(code);
      expect(channel, code).toBe(channelOf(code));
      expect(channel).toBeGreaterThanOrEqual(OTHER_CHANNELS.from);
      expect(channel).toBeLessThan(OTHER_CHANNELS.from + OTHER_CHANNELS.count);
    }
  });

  it('emits Down at each keydown and repeat, and Up at each keyup, on the code\'s channel with key, code, repeat, modifiers and age', () => {
    const out = query(key, 0, 1, { pushed });
    expect(out.down![0]).toEqual({ time: 0.1, channel: Z, key: 'z', code: 'KeyZ', shift: false, alt: false, ctrl: false, meta: false, repeat: false, age: 0 });
    expect(out.down![1]).toMatchObject({ time: 0.15, channel: Z, code: 'KeyZ', repeat: true });
    expect(out.down![1]!.age).toBeCloseTo(0.05, 9);
    expect(out.down!.find((e) => e.code === 'KeyQ')).toMatchObject({ channel: Q, shift: true, repeat: false });
    expect(times(out.up)).toEqual([[0.3, Z], [0.35, channelOf('ShiftLeft')], [0.4, Q], [0.6, SPACE], [0.8, SPACE], [0.9, A]]);
    expect(out.up![0]).toMatchObject({ code: 'KeyZ', repeat: false });
    expect(out.up![0]!.age).toBeCloseTo(0.2, 9);
  });

  it('keeps repeats off All, and tags Down and Up with their phase', () => {
    const out = query(key, 0, 1, { pushed });
    const all = out.all!;
    expect(all.every((e) => e.repeat === false)).toBe(true);
    expect(all.map((e) => [e.time, e.channel, e.phase])).toEqual([
      [0.1, Z, 'down'],
      [0.2, Q, 'down'], [0.2, channelOf('ShiftLeft'), 'down'],
      [0.3, Z, 'up'], [0.35, channelOf('ShiftLeft'), 'up'], [0.4, Q, 'up'],
      [0.5, SPACE, 'down'],
      // A keydown on a key already down (its keyup lost): an Up first, then a new Down.
      [0.6, SPACE, 'up'], [0.6, SPACE, 'down'],
      [0.7, A, 'down'],
      [0.8, SPACE, 'up'], [0.9, A, 'up'],
    ]);
    // The stray keyup (KeyX, never down) is dropped; the repeat with no key down reaches Down only.
    expect(out.up!.some((e) => e.code === 'KeyX')).toBe(false);
    expect(out.down!.filter((e) => e.code === 'KeyM')).toEqual([expect.objectContaining({ time: 0.75, channel: channelOf('KeyM'), repeat: true, age: 0 })]);
  });

  it('plays Keyboard → Note at keydowns on the two-row piano, never at repeats, with the Length and Velocity knobs', () => {
    expect(query(key, 0, 1, { pushed }).note).toBeUndefined();
    const params = { piano: true, length: 0.5, velocity: 0.6 };
    const out = query(key, 0, 1, { pushed, params });
    // Z is C3 (48), Q is C4 (60); KeyA, Space and Shift aren't on the piano.
    expect(out.note).toEqual([
      { time: 0.1, channel: Z, pitch: 48, velocity: 0.6, duration: 0.5 },
      { time: 0.2, channel: Q, pitch: 60, velocity: 0.6, duration: 0.5 },
    ]);
    expect(query(key, 0, 1, { pushed, params: { ...params, octave: 5 } }).note!.map((n) => n.pitch)).toEqual([72, 84]);
  });

  it('lays the piano out in two rows a twelfth apart, chromatic', () => {
    const bottom = ['KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG', 'KeyB', 'KeyH', 'KeyN', 'KeyJ', 'KeyM', 'Comma', 'KeyL', 'Period', 'Semicolon', 'Slash'];
    const top = ['KeyQ', 'Digit2', 'KeyW', 'Digit3', 'KeyE', 'KeyR', 'Digit5', 'KeyT', 'Digit6', 'KeyY', 'Digit7', 'KeyU', 'KeyI', 'Digit9', 'KeyO', 'Digit0', 'KeyP', 'BracketLeft', 'Equal', 'BracketRight'];
    expect(bottom.map((code) => pitchOf(code, 3))).toEqual(bottom.map((_, i) => 48 + i));
    expect(top.map((code) => pitchOf(code, 3))).toEqual(top.map((_, i) => 60 + i));
    expect(Object.keys(PIANO).sort()).toEqual([...bottom, ...top].sort());
    // Off the piano, above MIDI 127, or a bad octave: no note.
    expect([pitchOf('KeyA', 3), pitchOf('BracketRight', 8), pitchOf('KeyZ', NaN)]).toEqual([null, null, null]);
    expect(pitchOf('KeyZ', 8)).toBe(108);
    expect(pitchOf('KeyZ', 0)).toBe(12);
  });

  it('gives the same events in 25 ms, 100 ms and one window', () => {
    const params = { piano: true };
    for (const port of ['down', 'up', 'all', 'note']) {
      const whole = query(key, 0, 1, { pushed, params })[port];
      expect(whole!.length, port).toBeGreaterThan(0);
      // One state across the windows, as the runtime keeps it: which keys are down carries over.
      for (const step of [0.025, 0.1, 0.07]) expect(queryTiled(key, port, 1, step, { pushed, params, state: {} }), `${port} ${step}`).toEqual(whole);
    }
  });

  it('a keydown and keyup at one time apply down first, whatever the push order', () => {
    const out = query(key, 0, 1, { pushed: { up: [k(0.1, 'KeyZ')], down: [k(0.1, 'KeyZ')] } });
    expect(out.all!.map((e) => e.phase)).toEqual(['down', 'up']);
  });

  it('emits nothing without pushes, and survives weird windows and payloads', () => {
    expect(queryTiled(key, 'down', 2, 0.025)).toEqual([]);
    for (const [t0, t1] of [[1, 1], [2, 1], [NaN, 1], [0, Infinity], [-Infinity, NaN]]) expect(query(key, t0!, t1!)).toEqual({});
    // No code, an empty code, a numeric code, a NaN time: no key to give a channel to.
    const weird = { down: [k(0.1, ''), { time: 0.2, channel: 0, key: 'a' }, k(0.3, 'KeyA', { code: 5 }), k(NaN, 'KeyB')] as EngineEvent[] };
    expect(query(key, 0, 1, { pushed: weird })).toEqual({});
    // A raw channel on a push is ignored: the code decides.
    expect(query(key, 0, 1, { pushed: { down: [k(0.1, 'KeyB', { channel: 99 })] } }).down![0]!.channel).toBe(2);
  });

  it('thins repeats before Downs and Ups when a window fills up', () => {
    const flood = Array.from({ length: NODE_EVENT_LIMIT }, (_, i) => rep(0.01 + i * 1e-5, 'KeyA'));
    const out = query(key, 0, 0.1, { pushed: { down: [k(0.005, 'KeyA'), ...flood, k(0.09, 'KeyB')], up: [k(0.095, 'KeyA')] } });
    expect(out.down!.length).toBeLessThan(NODE_EVENT_LIMIT);
    expect(out.all!.map((e) => [e.code, e.phase])).toEqual([['KeyA', 'down'], ['KeyB', 'down'], ['KeyA', 'up']]);
  });
});

/** Queries [0, 1) in windows of `step` on one state and reads Held on `channels` at `at`, after the window holding each. */
function held(step: number, at: number[], channels: number[], params: Record<string, unknown> = {}, events = pushed): number[][] {
  const state: Record<string, unknown> = {};
  const ctx = context(key, { state, params });
  const rows: number[][] = [];
  for (let i = 0; i * step < 1 - 1e-9; i++) {
    const t0 = i * step, t1 = Math.min(1, (i + 1) * step);
    query(key, t0, t1, { state, pushed: events, params });
    for (const t of at.filter((time) => time >= t0 && time < t1)) rows.push(channels.map((channel) => key.signal!(ctx, 'held', t, channel)));
    expect(() => structuredClone(state)).not.toThrow();
  }
  return rows;
}

describe('key Held', () => {
  const at = [0, 0.12, 0.25, 0.32, 0.38, 0.55, 0.65, 0.72, 0.85, 0.95];
  const channels = [0, Z, Q, SPACE, A, NaN, -4, 500];

  it('reads 1 while a chosen key is down: channel 0 any of them, a key\'s channel that key', () => {
    // Held keys "Space": only Space counts.
    expect(held(1, at, channels)).toEqual([
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [1, 0, 0, 1, 0, 1, 0, 0],
      [1, 0, 0, 1, 0, 1, 0, 0],
      [1, 0, 0, 1, 0, 1, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ]);
    // Two chosen keys, separated by a comma and spaces; unchosen ones (Space, Q) read 0.
    expect(held(1, at, channels, { keys: 'KeyZ,  KeyA' }).map((row) => row.slice(0, 5))).toEqual([
      [0, 0, 0, 0, 0], [1, 1, 0, 0, 0], [1, 1, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [1, 0, 0, 0, 1], [1, 0, 0, 0, 1], [0, 0, 0, 0, 0],
    ]);
  });

  it('counts every key with Held keys empty', () => {
    expect(held(1, at, [0, Q], { keys: '' })).toEqual([[0, 0], [1, 0], [1, 1], [1, 1], [1, 1], [1, 0], [1, 0], [1, 0], [1, 0], [0, 0]]);
  });

  it('reads the same however time was split into windows', () => {
    for (const keys of ['Space', 'KeyZ KeyQ', '']) {
      const reference = held(1, at, channels, { keys });
      for (const step of [0.025, 0.1, 0.07]) expect(held(step, at, channels, { keys }), `${keys} ${step}`).toEqual(reference);
    }
    expect(key.signal!(context(key), 'down', 0, 0)).toBe(0);
  });

  it('checks Held keys for codes it doesn\'t know', () => {
    expect(heldCodes(' Space,KeyA  ArrowUp ')).toEqual(['Space', 'KeyA', 'ArrowUp']);
    expect(heldCodes(3)).toEqual([]);
    expect(checkHeld('Space KeyA')).toBeNull();
    expect(checkHeld('')).toBeNull();
    expect(checkHeld('a Space spacebar')).toBe('not a key code: a, spacebar. Use codes like KeyA, Digit1, Space or ArrowUp');
  });
});

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });

/** Key's Note into a synth, and its Down into Make Note, without the audio. */
const patch: Patch = {
  format: 'flowpatch',
  version: 1,
  seed: 1,
  nodes: [node('k', 'key', { piano: true }), node('chime', 'make-note')],
  cables: [{ from: { node: 'k', port: 'down' }, to: { node: 'chime', port: 'trigger' } }],
};

function plan() {
  const compiled = compilePatch(patch, nodeRegistry);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return compiled.plan;
}
const pick = (log: LoggedEvent[], node: string, port: string) => log.filter((e) => e.node === node && e.port === port).map(({ node: _n, port: _p, ...e }) => e);

describe('key in a patch', () => {
  it('reads the stream\'s keydown and keyup', () => {
    const router = inputRouter(plan());
    expect([...router.types].sort()).toEqual(['keydown', 'keyup']);
    expect(router.route({ type: 'keydown', key: 'a', code: 'KeyA', repeat: false })).toEqual([{ node: 'k', port: 'down', fields: { channel: 0, key: 'a', code: 'KeyA', repeat: false } }]);
  });

  it('replays a stream with the same channels and events, whatever the windows', () => {
    const events: InputEvent[] = [
      { time: 0.1, type: 'keydown', key: 'z', code: 'KeyZ', repeat: false },
      { time: 0.2, type: 'keydown', key: 'z', code: 'KeyZ', repeat: true },
      { time: 0.25, type: 'keydown', key: 'a', code: 'KeyA', repeat: false },
      { time: 0.3, type: 'keyup', key: 'z', code: 'KeyZ', repeat: false },
      { time: 0.4, type: 'keyup', key: 'a', code: 'KeyA', repeat: false },
    ];
    const run = (step: number) => {
      const rt = new Runtime(plan());
      replayInput(rt, { events });
      const log: LoggedEvent[] = [];
      for (let i = 0; i * step < 1 - 1e-9; i++) log.push(...rt.query(i * step, Math.min(1, (i + 1) * step)));
      return { rt, log };
    };
    const { rt, log } = run(1);
    expect(times(pick(log, 'k', 'down') as EngineEvent[])).toEqual([[0.1, Z], [0.2, Z], [0.25, A]]);
    expect(times(pick(log, 'k', 'up') as EngineEvent[])).toEqual([[0.3, Z], [0.4, A]]);
    expect(pick(log, 'k', 'note').map((e) => [e.time, e.pitch])).toEqual([[0.1, 48]]);
    // Down's repeats trigger Make Note too: they're on Down.
    expect(pick(log, 'chime', 'note').map((e) => e.time)).toEqual([0.1, 0.2, 0.25]);
    expect(rt.signalAt('k', 'held', 0.35)).toBe(0);
    expect(JSON.stringify(run(0.025).log)).toBe(JSON.stringify(log));
    expect(JSON.stringify(run(0.1).log)).toBe(JSON.stringify(log));
  });

  it('a live keydown lands at currentTime + 5 ms, after windows already queried', () => {
    const clock = new ManualClock();
    const scheduler = new Scheduler(new Runtime(plan()), { clock, record: true });
    for (let i = 0; i < 40; i++) {
      clock.set(i * 0.025);
      scheduler.wake();
    }
    clock.set(1.0123);
    scheduler.pushAll(inputRouter(plan()).route({ type: 'keydown', key: 'q', code: 'KeyQ', repeat: false }));
    const time = 1.0123 + IMMEDIATE_OFFSET;
    expect(pick(scheduler.events(), 'k', 'down')).toEqual([expect.objectContaining({ time, channel: Q, code: 'KeyQ' })]);
    expect(pick(scheduler.events(), 'k', 'note')).toEqual([{ time, channel: Q, pitch: 60, velocity: 0.8, duration: 0.25 }]);
  });
});
