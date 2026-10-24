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
  type InputEvent,
  type LoggedEvent,
  type Patch,
} from '@flow-patcher/engine';
import { click, nodeRegistry } from '../src';
import { clickAccepts } from '../src/click';
import { query, queryTiled } from './helpers';

const base = { pointerType: 'mouse', buttons: 0, shift: false, alt: false, ctrl: false, meta: false };
const at = (time: number, x: number, y: number, more: Partial<EngineEvent> = {}): EngineEvent => ({ time, channel: 0, x, y, ...base, button: 0, ...more });

/** A click, a double click (two clicks, then dblclick), a middle click and a right-click, over 1 s. */
const pushed: Record<string, EngineEvent[]> = {
  click: [at(0.1, 0.2, 0.3), at(0.4, 0.5, 0.5), at(0.52, 0.5, 0.5, { shift: true }), at(0.9, 0.25, 0.75, { channel: 2, pointerType: 'touch' })],
  double: [at(0.52, 0.5, 0.5, { shift: true })],
  middle: [at(0.6, 0.8, 0.1, { button: 1, buttons: 4 })],
  right: [at(0.7, 0.9, 0.9, { button: 2, buttons: 2, ctrl: true }), at(0.95, 0.1, 0.2, { channel: 3, button: 0, pointerType: 'touch' })],
};

describe('click', () => {
  it('has Click, Double, Middle and Right outputs and reads click, dblclick, auxclick and contextmenu', () => {
    expect(click.category).toBe('canvas-sources');
    expect(click.ports.map((p) => [p.name, p.type, p.direction])).toEqual([
      ['click', 'event', 'out'],
      ['double', 'event', 'out'],
      ['middle', 'event', 'out'],
      ['right', 'event', 'out'],
    ]);
    // Not a contact source: no All, no signals.
    expect(click.ports.some((p) => p.name === 'all')).toBe(false);
    expect(click.params).toEqual([]);
    expect(click.input?.reads).toEqual({ click: 'click', dblclick: 'double', auxclick: 'middle', contextmenu: 'right' });
    expect(click.input?.rewrites).toBe(true);
  });

  it('emits each pushed event on its output at its own time, with position, buttons, modifiers and pointer type', () => {
    const out = query(click, 0, 1, { pushed });
    expect(out).toEqual(pushed);
    expect(out.right![0]).toEqual({ time: 0.7, channel: 0, x: 0.9, y: 0.9, pointerType: 'mouse', button: 2, buttons: 2, shift: false, alt: false, ctrl: true, meta: false });
  });

  it('keeps each event\'s channel apart', () => {
    const out = query(click, 0, 1, { pushed });
    expect(out.click!.map((e) => e.channel)).toEqual([0, 0, 0, 2]);
    expect(out.right!.map((e) => e.channel)).toEqual([0, 3]);
  });

  it('gives the same events however time was split into windows', () => {
    for (const port of ['click', 'double', 'middle', 'right']) {
      const reference = query(click, 0, 1, { pushed })[port] ?? [];
      for (const step of [0.025, 0.1, 0.07, 0.52]) expect(queryTiled(click, port, 1, step, { pushed }), `${port} @ ${step}`).toEqual(reference);
    }
  });

  it('passes on only the middle button\'s auxclick: right, back and forward are left out', () => {
    expect(clickAccepts({ type: 'auxclick', button: 1 })).toBe(true);
    for (const button of [0, 2, 3, 4, undefined]) expect(clickAccepts({ type: 'auxclick', button }), String(button)).toBe(false);
    for (const type of ['click', 'dblclick', 'contextmenu'] as const) expect(clickAccepts({ type, button: 2 })).toBe(true);
    // Pushed straight onto Middle, as a test or an old host might.
    const out = query(click, 0, 1, { pushed: { middle: [at(0.1, 0.5, 0.5, { button: 2 }), at(0.2, 0.5, 0.5, { button: 1 }), at(0.3, 0.5, 0.5, { button: 4 })] } });
    expect(out.middle!.map((e) => e.time)).toEqual([0.2]);
  });

  it('gives weird input a defined result: positions clamped, non-finite fields left out, bad times dropped', () => {
    expect(query(click, 0, 1)).toEqual({});
    expect(query(click, 0, 1, { pushed: { click: [] } })).toEqual({});
    const out = query(click, 0, 1, {
      pushed: {
        click: [
          at(0.1, -0.5, 1.5),
          at(0.2, NaN, Infinity),
          { time: 0.3, channel: 1.5 },
          { time: NaN, channel: 0, x: 0.5, y: 0.5 },
          at(0.4, 0.5, 0.5, { x: 'left' as unknown as number }),
        ],
      },
    });
    expect(out.click).toEqual([
      at(0.1, 0, 1),
      { ...at(0.2, 0, 0), x: undefined, y: undefined },
      { time: 0.3, channel: 0 },
      { ...at(0.4, 0, 0.5), x: undefined },
    ].map((e) => JSON.parse(JSON.stringify(e)) as EngineEvent));
  });
});

const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });

/** Click's four outputs into four Make Notes. */
const patch: Patch = {
  format: 'flowpatch',
  version: 1,
  seed: 1,
  nodes: [node('c', 'click'), node('a', 'make-note', { pitch: 60 }), node('b', 'make-note', { pitch: 67 }), node('m', 'make-note', { pitch: 64 }), node('r', 'make-note', { pitch: 48 })],
  cables: [
    { from: { node: 'c', port: 'click' }, to: { node: 'a', port: 'trigger' } },
    { from: { node: 'c', port: 'double' }, to: { node: 'b', port: 'trigger' } },
    { from: { node: 'c', port: 'middle' }, to: { node: 'm', port: 'trigger' } },
    { from: { node: 'c', port: 'right' }, to: { node: 'r', port: 'trigger' } },
  ],
};

function plan() {
  const compiled = compilePatch(patch, nodeRegistry);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return compiled.plan;
}
const pick = (log: LoggedEvent[], node: string, port: string) => log.filter((e) => e.node === node && e.port === port).map(({ node: _n, port: _p, ...e }) => e);

/** A recorded stream: a click, a double click, a right-click that Chrome follows with a button-2 auxclick, and a middle click. */
const stream: { events: InputEvent[] } = {
  events: [
    { time: 0.1, type: 'click', x: 0.2, y: 0.3, ...base, button: 0 },
    { time: 0.3, type: 'click', x: 0.5, y: 0.5, ...base, button: 0 },
    { time: 0.42, type: 'click', x: 0.5, y: 0.5, ...base, button: 0 },
    { time: 0.42, type: 'dblclick', x: 0.5, y: 0.5, ...base, button: 0 },
    { time: 0.6, type: 'contextmenu', x: 0.9, y: 0.1, ...base, button: 2, buttons: 2 },
    { time: 0.61, type: 'auxclick', x: 0.9, y: 0.1, ...base, button: 2 },
    { time: 0.8, type: 'auxclick', x: 0.4, y: 0.6, ...base, button: 1 },
  ],
};

describe('click in a patch', () => {
  it('routes click, dblclick, contextmenu and the middle button\'s auxclick, on channel 0', () => {
    const router = inputRouter(plan());
    expect([...router.types].sort()).toEqual(['auxclick', 'click', 'contextmenu', 'dblclick']);
    expect(router.route({ type: 'click', x: 0.1, y: 0.2, button: 0 })).toEqual([{ node: 'c', port: 'click', fields: { channel: 0, x: 0.1, y: 0.2, button: 0 } }]);
    expect(router.route({ type: 'auxclick', x: 0.1, y: 0.2, button: 2 })).toEqual([]);
    expect(router.route({ type: 'auxclick', x: 0.1, y: 0.2, button: 1 })).toHaveLength(1);
  });

  it('replays a stream onto each output, and windows don\'t matter', () => {
    const run = (step: number) => {
      const rt = new Runtime(plan());
      replayInput(rt, stream);
      const log: LoggedEvent[] = [];
      for (let i = 0; i * step < 1 - 1e-9; i++) log.push(...rt.query(i * step, Math.min(1, (i + 1) * step)));
      return log;
    };
    const log = run(1);
    expect(pick(log, 'c', 'click').map((e) => [e.time, e.x, e.y])).toEqual([[0.1, 0.2, 0.3], [0.3, 0.5, 0.5], [0.42, 0.5, 0.5]]);
    expect(pick(log, 'c', 'double').map((e) => e.time)).toEqual([0.42]);
    // The right-click is Right only: its auxclick isn't Middle.
    expect(pick(log, 'c', 'right').map((e) => [e.time, e.button])).toEqual([[0.6, 2]]);
    expect(pick(log, 'c', 'middle').map((e) => [e.time, e.button])).toEqual([[0.8, 1]]);
    expect(pick(log, 'r', 'note').map((e) => [e.time, e.pitch])).toEqual([[0.6, 48]]);
    expect(JSON.stringify(run(0.025))).toBe(JSON.stringify(log));
    expect(JSON.stringify(run(0.1))).toBe(JSON.stringify(log));
  });

  it('a live click lands at currentTime + 5 ms with its note, after windows already queried', () => {
    const clock = new ManualClock();
    const scheduler = new Scheduler(new Runtime(plan()), { clock, record: true });
    for (let k = 0; k < 40; k++) {
      clock.set(k * 0.025);
      scheduler.wake();
    }
    clock.set(1.0123);
    const [event] = scheduler.pushAll(inputRouter(plan()).route({ type: 'click', x: 0.4, y: 0.6, ...base, button: 0 }))!;
    expect(event!.time).toBe(1.0123 + IMMEDIATE_OFFSET);
    expect(pick(scheduler.events(), 'c', 'click')).toEqual([{ time: event!.time, channel: 0, x: 0.4, y: 0.6, ...base, button: 0 }]);
    expect(pick(scheduler.events(), 'a', 'note').map((e) => [e.time, e.pitch])).toEqual([[event!.time, 60]]);
  });
});
