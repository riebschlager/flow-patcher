import { describe, expect, it } from 'vitest';
import { compilePatch, replayInput, Runtime, type EngineEvent, type EventField, type InputEvent, type LoggedEvent, type Patch } from '@flow-patcher/engine';
import { modifierRouter, nodeRegistry } from '../src';
import { matches, parseRoute, routeError } from '../src/modifier-router';
import { query, queryTiled } from './helpers';
import { burst, expectUnderCap, expectWellFormed, splitsMatchPass } from './routing';

const PORTS = ['out1', 'out2', 'out3', 'out4', 'pass', 'passDown', 'passMove', 'passUp', 'passCancel'];

const ev = (time: number, channel: number, phase: string | undefined, fields: Record<string, EventField> = {}): EngineEvent => ({ time, channel, ...(phase ? { phase } : {}), ...fields });
const mouse = (buttons: number, button: number, mods: Record<string, boolean> = {}) => ({ pointerType: 'mouse', buttons, button, shift: false, alt: false, ctrl: false, meta: false, ...mods });

/**
 * Three contacts on two channels and some loose events: a right-drag on 1 that lets go of the
 * button mid-drag, a plain drag on 2 that presses Shift then Alt mid-drag, an Alt drag on 1 after
 * the first ends, a shifted hover on 3 and a phaseless right click.
 */
const stream: EngineEvent[] = [
  ev(0.1, 1, 'down', mouse(2, 2)),
  ev(0.2, 2, 'down', { pointerType: 'touch', buttons: 1, button: 0 }),
  ev(0.3, 1, 'move', mouse(0, -1)),
  ev(0.3, 2, 'move', { pointerType: 'touch', buttons: 1, button: -1, shift: true }),
  ev(0.4, 3, 'move', mouse(0, -1, { shift: true })),
  ev(0.5, 1, 'up', mouse(0, 2)),
  ev(0.55, 2, 'move', { pointerType: 'touch', buttons: 1, button: -1, alt: true }),
  ev(0.6, 0, undefined, { button: 2, buttons: 0, x: 0.5, y: 0.5 }),
  ev(0.7, 1, 'down', mouse(1, 0, { alt: true })),
  ev(0.8, 2, 'cancel', { pointerType: 'touch', buttons: 0, button: -1 }),
  ev(0.9, 1, 'move', mouse(1, -1)),
  ev(1.0, 1, 'up', mouse(0, 0)),
];

/** [port, time, channel, phase] for every event, ports in PORTS order then time. */
function flat(result: Record<string, EngineEvent[] | undefined>) {
  return PORTS.flatMap((port) => (result[port] ?? []).map((e) => [port, e.time, e.channel, e.phase ?? '-']));
}

function tiled(step: number, params: Record<string, unknown> = {}) {
  const state = {};
  const out: Record<string, EngineEvent[]> = {};
  for (let i = 0; i * step < 1.2 - 1e-9; i++) {
    const t0 = i * step, t1 = Math.min(1.2, (i + 1) * step);
    const result = query(modifierRouter, t0, t1, { state, params, inputs: { in: stream.filter((e) => e.time >= t0 && e.time < t1) } });
    for (const [port, events] of Object.entries(result)) (out[port] ??= []).push(...events!);
  }
  return flat(out);
}

describe('modifier-router', () => {
  it('is a recognizer with In, four routes, Pass and its phase splits, and Flow modes as defaults', () => {
    expect(modifierRouter.category).toBe('gesture-recognizers');
    expect(modifierRouter.ports.filter((p) => p.direction === 'out').map((p) => p.name)).toEqual(PORTS);
    expect(modifierRouter.params.map((p) => [p.name, p.default])).toEqual([['route1', 'right, shift'], ['route2', 'alt'], ['route3', ''], ['route4', '']]);
  });

  it('routes each contact by its down, and keeps it there until it ends (ADR 0028)', () => {
    expect(tiled(2)).toEqual([
      // The right-drag stays on Out 1 after the button state changes.
      ['out1', 0.1, 1, 'down'], ['out1', 0.3, 1, 'move'], ['out1', 0.4, 3, 'move'], ['out1', 0.5, 1, 'up'], ['out1', 0.6, 0, '-'],
      // The Alt drag on channel 1 after it, and its moves without Alt.
      ['out2', 0.7, 1, 'down'], ['out2', 0.9, 1, 'move'], ['out2', 1.0, 1, 'up'],
      // The plain touch drag stays on Pass through Shift and Alt, to its cancel.
      ['pass', 0.2, 2, 'down'], ['pass', 0.3, 2, 'move'], ['pass', 0.55, 2, 'move'], ['pass', 0.8, 2, 'cancel'],
      // The splits carry no phase, as Pointer's per-phase ports.
      ['passDown', 0.2, 2, '-'], ['passMove', 0.3, 2, '-'], ['passMove', 0.55, 2, '-'], ['passCancel', 0.8, 2, '-'],
    ]);
  });

  it('checks routes in order, and passes events unchanged', () => {
    const params = { route1: 'alt', route2: 'left', route3: 'right', route4: '' };
    const result = query(modifierRouter, 0, 2, { params, inputs: { in: stream } });
    expect(result.out1!.map((e) => e.time)).toEqual([0.7, 0.9, 1.0]);
    expect(result.out2!.map((e) => e.time)).toEqual([0.2, 0.3, 0.55, 0.8]);
    expect(result.out3!.map((e) => e.time)).toEqual([0.1, 0.3, 0.5, 0.6]);
    expect(result.pass!.map((e) => e.time)).toEqual([0.4]);
    expect(result.out1![0]).toBe(stream[8]);
    // Pass splits are copies, so no event object sits on two ports.
    const pass = query(modifierRouter, 0, 2, { params: { route1: '', route2: '' }, inputs: { in: stream } });
    expect(pass.pass).toHaveLength(stream.length);
    const { phase: _phase, ...stripped } = pass.pass![0]!;
    expect(pass.passDown![0]).toEqual(stripped);
    for (const port of ['passDown', 'passMove', 'passUp', 'passCancel']) for (const e of pass[port]!) expect(e).not.toHaveProperty('phase');
    expect(pass.pass!.filter((e) => e.phase === undefined)).toHaveLength(1);
  });

  it('gives the same events in any windows', () => {
    const whole = tiled(2);
    for (const step of [0.025, 0.1, 0.35]) expect(tiled(step)).toEqual(whole);
    expect(queryTiled(modifierRouter, 'passMove', 1.2, 0.05, { state: {}, inputsFor: (t0, t1) => ({ in: stream.filter((e) => e.time >= t0 && e.time < t1) }) }).map((e) => e.time)).toEqual([0.3, 0.55]);
  });

  it('parses routes: "," for or, "+" for and, case and spaces ignored', () => {
    expect(parseRoute(' Right ,SHIFT ').route).toEqual([['right'], ['shift']]);
    expect(parseRoute('ctrl + shift').route).toEqual([['ctrl', 'shift']]);
    expect(parseRoute('').route).toEqual([]);
    expect(parseRoute(' , ').route).toEqual([]);
    expect(routeError('right, shift')).toBeNull();
    expect(routeError('hyper')).toMatch(/^Unknown: hyper\./);
    expect(routeError('shift+')).toMatch(/^Unknown: \(empty\)/);
    // An unusable route matches nothing, so its contacts go on down the list.
    expect(parseRoute('shift, hyper').route).toEqual([]);
    const both = parseRoute('ctrl+shift').route;
    expect(matches(ev(0, 1, 'down', { ctrl: true, shift: true }), both)).toBe(true);
    expect(matches(ev(0, 1, 'down', { ctrl: true, shift: false }), both)).toBe(false);
    // Recorded 1/0 modifiers count; buttons by bit or by the button that changed.
    expect(matches(ev(0, 1, 'down', { alt: 1 }), parseRoute('alt').route)).toBe(true);
    expect(matches(ev(0, 1, 'down', { buttons: 6, button: 1 }), parseRoute('right').route)).toBe(true);
    expect(matches(ev(0, 1, 'down', { buttons: 32, button: 5 }), parseRoute('eraser').route)).toBe(true);
    expect(matches(ev(0, 1, 'down', { buttons: 1, button: 0 }), parseRoute('middle').route)).toBe(false);
  });

  it('picks afresh after a cancel: the next event on the channel is checked on its own', () => {
    const events = [ev(0.1, 1, 'down', mouse(2, 2)), ev(0.2, 1, 'cancel', mouse(0, -1)), ev(0.3, 1, 'move', mouse(0, -1)), ev(0.4, 1, 'move', mouse(0, -1, { alt: true })), ev(0.5, 1, 'down', mouse(1, 0)), ev(0.6, 1, 'up', mouse(0, 0))];
    expect(flat(query(modifierRouter, 0, 1, { state: {}, inputs: { in: events } })).filter((r) => !String(r[0]).startsWith('passD') && !String(r[0]).startsWith('passM') && !String(r[0]).startsWith('passU'))).toEqual([
      ['out1', 0.1, 1, 'down'], ['out1', 0.2, 1, 'cancel'], ['out2', 0.4, 1, 'move'], ['pass', 0.3, 1, 'move'], ['pass', 0.5, 1, 'down'], ['pass', 0.6, 1, 'up'],
    ]);
  });

  it('thins moves in an over-budget burst, so every down still gets its up or cancel on every output', () => {
    // 30 contacts × 22 events in 22 ms: far past NODE_EVENT_LIMIT. Thirds right-drag, Alt-drag, plain.
    const events = burst(30, 20, (c) => (c % 3 === 0 ? mouse(2, 2) : c % 3 === 1 ? mouse(1, 0, { alt: true }) : mouse(1, 0)));
    const out = query(modifierRouter, 0, 1, { state: {}, inputs: { in: events } }) as Record<string, EngineEvent[]>;
    expectWellFormed(out);
    splitsMatchPass(out);
    expectUnderCap(out);
    for (const port of ['out1', 'out2', 'pass']) expect(out[port]!.filter((e) => e.phase === 'down')).toHaveLength(10);
    expect((out.passCancel?.length ?? 0) + out.passUp!.length).toBe(10);
    expect(out.out1!.filter((e) => e.phase === 'cancel')).toHaveLength(10);
    expect(out.passMove!.length).toBeLessThan(10 * 20);
  });

  it('copes with weird input', () => {
    expect(query(modifierRouter, 0, 1)).toEqual({});
    expect(query(modifierRouter, 0, 1, { inputs: { in: [] } })).toEqual({});
    const weird = [
      ev(NaN, 1, 'down', { shift: true }),
      ev(0.1, 2, 'down', { shift: NaN, alt: 'yes', buttons: NaN, button: Infinity }),
      ev(0.2, 2.5, 'down', { buttons: -1 }),
      ev(0.3, 3, 'down', { buttons: 2.5 }),
    ];
    const state: Record<string, unknown> = {};
    const result = query(modifierRouter, 0, 1, { state, params: { route1: 42, route2: 'nonsense' }, inputs: { in: weird } });
    // A non-text route reads as its default; nonsense as nothing; odd fields don't match.
    // A non-finite time or channel is dropped; any finite channel can hold a contact.
    expect(flat(result)).toEqual([['pass', 0.1, 2, 'down'], ['pass', 0.2, 2.5, 'down'], ['pass', 0.3, 3, 'down'], ['passDown', 0.1, 2, '-'], ['passDown', 0.2, 2.5, '-'], ['passDown', 0.3, 3, '-']]);
    expect(state.routes).toEqual({ 2: 0, 2.5: 0, 3: 0 });
    expect(query(modifierRouter, 0, 1, { inputs: { in: [ev(0.1, NaN, 'down', { shift: true }), ev(0.2, Infinity, undefined)] } })).toEqual({});
  });

  it("routes Flow's right-drag and Alt from Pointer's All, live", () => {
    const node = (id: string, type: string) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params: {}, position: { x: 0, y: 0 } });
    const patch: Patch = { format: 'flowpatch', version: 1, seed: 1, nodes: [node('p', 'pointer'), node('r', 'modifier-router')], cables: [{ from: { node: 'p', port: 'all' }, to: { node: 'r', port: 'in' } }] };
    const compiled = compilePatch(patch, nodeRegistry);
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    const rt = new Runtime(compiled.plan);
    const m = (time: number, type: string, x: number, buttons: number, button: number, alt = false): InputEvent => ({ time, type, channel: 1, x, y: 0.5, pressure: buttons ? 0.5 : 0, pointerType: 'mouse', buttons, button, shift: false, alt, ctrl: false, meta: false } as InputEvent);
    replayInput(rt, { events: [
      m(0.1, 'pointerdown', 0.1, 2, 2), m(0.15, 'pointermove', 0.2, 2, -1), m(0.2, 'pointerup', 0.2, 0, 2),
      m(0.3, 'pointerdown', 0.3, 1, 0, true), m(0.35, 'pointerup', 0.3, 0, 0, true),
      m(0.4, 'pointerdown', 0.4, 1, 0), m(0.45, 'pointerup', 0.4, 0, 0),
    ] });
    const log: LoggedEvent[] = [];
    for (let i = 0; i < 24; i++) log.push(...rt.query(i * 0.025, (i + 1) * 0.025));
    expect(log.filter((e) => e.node === 'r').map((e) => [e.port, e.time, e.phase])).toEqual([
      ['out1', 0.1, 'down'], ['out1', 0.15, 'move'], ['out1', 0.2, 'up'],
      ['out2', 0.3, 'down'], ['out2', 0.35, 'up'],
      ['pass', 0.4, 'down'], ['passDown', 0.4, undefined], ['pass', 0.45, 'up'], ['passUp', 0.45, undefined],
    ]);
  });
});
