import { describe, expect, it } from 'vitest';
import { compilePatch, inputRouter, replayInput, Runtime, type EngineEvent, type EventField, type InputEvent, type LoggedEvent, type Patch, type SignalSource } from '@flow-patcher/engine';
import { dwell, nodeRegistry } from '../src';
import { query, queryTiled } from './helpers';
import { burst, expectUnderCap, expectWellFormed, splitsMatchPass } from './routing';

const PASS = ['pass', 'passDown', 'passMove', 'passUp', 'passCancel'];

const ev = (time: number, channel: number, phase: string | undefined, x: EventField, y: EventField, pointerType: EventField = 'mouse'): EngineEvent =>
  ({ time, channel, ...(phase ? { phase } : {}), x, y, pointerType });

/**
 * Channel 1, a mouse: hovers still from 0.1 (fires at 0.7), wanders within Radius, leaves it at
 * 1.0, stays from 1.0 but presses at 1.3 (no fire), lifts at 1.5 and stays there (fires at 2.1). Channel 2, a pen, hovers from 0.4, drifts out of Radius at 0.8 and stays (fires at 1.4).
 * Channel 3 is a touch: never fires.
 */
const stream: EngineEvent[] = [
  ev(0.1, 1, 'move', 0.5, 0.5),
  ev(0.3, 1, 'move', 0.51, 0.5),
  ev(0.3, 3, 'move', 0.2, 0.2, 'touch'),
  ev(0.4, 2, 'move', 0.2, 0.8, 'pen'),
  ev(0.5, 1, 'move', 0.5, 0.515),
  ev(0.8, 2, 'move', 0.25, 0.8, 'pen'),
  ev(0.9, 1, 'move', 0.505, 0.5),
  ev(1.0, 1, 'move', 0.6, 0.5),
  ev(1.3, 1, 'down', 0.6, 0.5),
  ev(1.4, 1, 'move', 0.6, 0.5),
  ev(1.5, 1, 'up', 0.6, 0.5),
  ev(1.6, 1, 'move', 0.6, 0.5),
  ev(2.0, 3, 'down', 0.2, 0.2, 'touch'),
  ev(2.1, 3, 'up', 0.2, 0.2, 'touch'),
];

function tiled(step: number, events = stream, end = 3, params: Record<string, unknown> = {}, mods = {}) {
  const state = {};
  const out: Record<string, EngineEvent[]> = {};
  for (let i = 0; i * step < end - 1e-9; i++) {
    const t0 = i * step, t1 = Math.min(end, (i + 1) * step);
    const result = query(dwell, t0, t1, { state, params, mods, inputs: { in: events.filter((e) => e.time >= t0 && e.time < t1) } });
    for (const [port, list] of Object.entries(result)) (out[port] ??= []).push(...list!);
  }
  return out;
}

const fires = (out: Record<string, EngineEvent[] | undefined>) => (out.dwell ?? []).map((e) => [+e.time.toFixed(9), e.channel, e.x, e.y, e.pointerType]);

describe('dwell', () => {
  it('is a recognizer with Dwell, Pass and its phase splits, and Radius and Time knobs', () => {
    expect(dwell.category).toBe('gesture-recognizers');
    expect(dwell.ports.filter((p) => p.direction === 'out').map((p) => p.name)).toEqual(['dwell', ...PASS]);
    expect(dwell.params.map((p) => [p.name, p.kind === 'number' && p.default])).toEqual([['radius', 0.02], ['time', 0.6]]);
  });

  it('fires once a mouse or pen hover has stayed within Radius for Time, at that moment', () => {
    expect(fires(tiled(3))).toEqual([
      [0.7, 1, 0.5, 0.515, 'mouse'],
      [1.4, 2, 0.25, 0.8, 'pen'],
      [2.1, 1, 0.6, 0.5, 'mouse'],
    ]);
  });

  it('fires only once per stay, and not for a stay a down interrupts', () => {
    // One long still hover: one fire. Moving away and back starts a new stay.
    const still = [ev(0.1, 1, 'move', 0.5, 0.5), ev(1.5, 1, 'move', 0.5, 0.5), ev(2.5, 1, 'move', 0.5, 0.5)];
    expect(fires(tiled(3, still))).toEqual([[0.7, 1, 0.5, 0.5, 'mouse']]);
    const back = [...still.slice(0, 2), ev(1.6, 1, 'move', 0.9, 0.5), ev(1.7, 1, 'move', 0.5, 0.5)];
    expect(fires(tiled(3, back))).toEqual([[0.7, 1, 0.5, 0.5, 'mouse'], [2.3, 1, 0.5, 0.5, 'mouse']]);
    const pressed = [ev(0.1, 1, 'move', 0.5, 0.5), ev(0.6, 1, 'down', 0.5, 0.5), ev(0.9, 1, 'move', 0.5, 0.5), ev(1.0, 1, 'cancel', 0.5, 0.5)];
    expect(fires(tiled(3, pressed))).toEqual([]);
  });

  it('fires before an event at its own time, and not when the pointer leaves Radius just before', () => {
    expect(fires(tiled(3, [ev(0.1, 1, 'move', 0.5, 0.5), ev(0.7, 1, 'move', 0.9, 0.9)]))).toEqual([[0.7, 1, 0.5, 0.5, 'mouse'], [1.3, 1, 0.9, 0.9, 'mouse']]);
    expect(fires(tiled(3, [ev(0.1, 1, 'move', 0.5, 0.5), ev(0.69, 1, 'move', 0.9, 0.9)]))).toEqual([[1.29, 1, 0.9, 0.9, 'mouse']]);
  });

  it('reads Radius and Time when a stay is anchored, per channel', () => {
    expect(fires(tiled(3, stream, 3, { time: 1, radius: 0.2 }))).toEqual([[1.1, 1, 0.6, 0.5, 'mouse'], [1.4, 2, 0.25, 0.8, 'pen'], [2.5, 1, 0.6, 0.5, 'mouse']]);
    // Time from a cable: 0.6 + channel × 0.5 s.
    const time: SignalSource = (_t, channel) => channel;
    const two = [ev(0.1, 1, 'move', 0.5, 0.5), ev(0.1, 2, 'move', 0.2, 0.2, 'pen')];
    expect(fires(tiled(3, two, 3, {}, { time: [{ depth: 0.5, signal: time }] }))).toEqual([[1.2, 1, 0.5, 0.5, 'mouse'], [1.7, 2, 0.2, 0.2, 'pen']]);
  });

  it('starts a stay where a mouse or pen lifts, so click-then-hold-still dwells; a touch or a cancel does not', () => {
    const click = [ev(0.1, 1, 'down', 0.3, 0.3), ev(0.2, 1, 'up', 0.3, 0.3)];
    expect(fires(tiled(3, click))).toEqual([[0.8, 1, 0.3, 0.3, 'mouse']]);
    expect(fires(tiled(3, click.map((e) => ({ ...e, pointerType: 'pen' }))))).toEqual([[0.8, 1, 0.3, 0.3, 'pen']]);
    expect(fires(tiled(3, click.map((e) => ({ ...e, pointerType: 'touch' }))))).toEqual([]);
    expect(fires(tiled(3, [click[0]!, ev(0.2, 1, 'cancel', 0.3, 0.3)]))).toEqual([]);
    // Moving off after the click, before Time, starts over from there.
    expect(fires(tiled(3, [...click, ev(0.5, 1, 'move', 0.6, 0.6)]))).toEqual([[1.1, 1, 0.6, 0.6, 'mouse']]);
  });

  it('forgets a stay at a cancel: the next hover anchors afresh', () => {
    const events = [ev(0.1, 1, 'move', 0.5, 0.5), ev(0.2, 1, 'down', 0.5, 0.5), ev(0.3, 1, 'cancel', 0.5, 0.5), ev(0.4, 1, 'move', 0.505, 0.5)];
    expect(fires(tiled(3, events))).toEqual([[1.0, 1, 0.505, 0.5, 'mouse']]);
  });

  it('drops a stay at a hover\'s leave without firing, so a pointer reusing the slot starts afresh', () => {
    // Still from 0.1 (due at 0.7), but it leaves at 0.4. Its slot's next pointer hovers nearby from 0.9.
    const left = [ev(0.1, 1, 'move', 0.5, 0.5), ev(0.4, 1, 'leave', 0.5, 0.5), ev(0.9, 1, 'move', 0.505, 0.5, 'pen')];
    expect(fires(tiled(3, left))).toEqual([[1.5, 1, 0.505, 0.5, 'pen']]);
    for (const step of [0.025, 0.1, 0.37]) expect(fires(tiled(step, left)), `${step}`).toEqual([[1.5, 1, 0.505, 0.5, 'pen']]);
    // Only its own channel's stay goes.
    expect(fires(tiled(3, [ev(0.1, 1, 'move', 0.5, 0.5), ev(0.1, 2, 'move', 0.2, 0.2), ev(0.4, 2, 'leave', 0.2, 0.2)]))).toEqual([[0.7, 1, 0.5, 0.5, 'mouse']]);
    // A fire due at the leave's own time goes first; a leave after a fire, or with no position, changes nothing else.
    expect(fires(tiled(3, [ev(0.1, 1, 'move', 0.5, 0.5), ev(0.7, 1, 'leave', 0.5, 0.5)]))).toEqual([[0.7, 1, 0.5, 0.5, 'mouse']]);
    expect(fires(tiled(3, [ev(0.1, 1, 'move', 0.5, 0.5), ev(0.4, 1, 'leave', NaN, 'x', 7)]))).toEqual([]);
    // The leave goes out on Pass alone: it's no contact phase.
    const out = tiled(3, left);
    expect(out.pass).toEqual(left);
    splitsMatchPass(out);
    expect(out.passMove).toHaveLength(2);
  });

  it('keeps every output inside its window, a fire landing exactly on a window edge', () => {
    // Anchored at 0.15, fires at 0.75: the edge of 0.25 s windows (and of 0.05 s ones).
    const events = [ev(0.15, 1, 'move', 0.5, 0.5), ev(0.75, 2, 'move', 0.2, 0.2, 'pen')];
    for (const step of [0.05, 0.25]) {
      const state = {};
      const fired: number[] = [];
      for (let i = 0; i * step < 2 - 1e-9; i++) {
        const t0 = i * step, t1 = Math.min(2, (i + 1) * step);
        const result = query(dwell, t0, t1, { state, inputs: { in: events.filter((e) => e.time >= t0 && e.time < t1) } });
        for (const list of Object.values(result)) for (const e of list!) {
          expect(e.time, `step ${step}`).toBeGreaterThanOrEqual(t0);
          expect(e.time, `step ${step}`).toBeLessThan(t1);
        }
        fired.push(...(result.dwell ?? []).map((e) => +e.time.toFixed(9)));
      }
      expect(fired).toEqual([0.75, 1.35]);
    }
    expect(fires(tiled(0.25, events))).toEqual(fires(tiled(3, events)));
  });

  it('thins forwarded moves in an over-budget burst, but never a fire, a down or an end', () => {
    // 10 mice hovering still from 0.0005 fire at 0.6005, in a limit window full of other channels' moves.
    const still = Array.from({ length: 10 }, (_, i) => ev(0.0005, 100 + i, 'move', 0.1 * i, 0.5));
    const flood = burst(12, 60, (c, step) => ({ x: 0.5 + step / 1000, y: c / 20, pointerType: 'touch' }), 0.5);
    const events = [...still, ...flood].sort((a, b) => a.time - b.time);
    const out = query(dwell, 0, 1, { state: {}, inputs: { in: events } }) as Record<string, EngineEvent[]>;
    expectUnderCap(out);
    expectWellFormed(out);
    splitsMatchPass(out);
    expect(out.dwell).toHaveLength(10);
    expect(out.passMove!.length).toBeLessThan(12 * 60);
    // A leave in the full window still goes out, and drops its stay.
    const leave = ev(0.05, 100, 'leave', 0, 0.5);
    const left = query(dwell, 0, 1, { state: {}, inputs: { in: [...events, leave].sort((a, b) => a.time - b.time) } }) as Record<string, EngineEvent[]>;
    expectUnderCap(left);
    expect(left.pass!.filter((e) => e.phase === 'leave')).toEqual([leave]);
    expect(left.dwell!.map((e) => e.channel)).toEqual(Array.from({ length: 9 }, (_, i) => 101 + i));
  });

  it('passes every event unchanged, never claiming', () => {
    const out = tiled(3);
    expect(out.pass).toEqual(stream);
    expect(out.pass![0]).toBe(stream[0]);
    expect(out.passMove).toHaveLength(stream.filter((e) => e.phase === 'move').length);
    expect(out.passDown!.map((e) => e.time)).toEqual([1.3, 2.0]);
    expect(out.passUp!.map((e) => e.time)).toEqual([1.5, 2.1]);
    expect(out.passCancel).toBeUndefined();
  });

  it('gives the same events in any windows, a fire landing in a window with no input', () => {
    const whole = tiled(3);
    for (const step of [0.025, 0.1, 0.3, 0.7]) expect(tiled(step)).toEqual(whole);
    expect(queryTiled(dwell, 'dwell', 3, 0.05, { state: {}, inputsFor: (t0, t1) => ({ in: stream.filter((e) => e.time >= t0 && e.time < t1) }) }).map((e) => +e.time.toFixed(9))).toEqual([0.7, 1.4, 2.1]);
  });

  it('copes with weird input', () => {
    expect(query(dwell, 0, 1)).toEqual({});
    expect(query(dwell, 0, 1, { inputs: { in: [] } })).toEqual({});
    const weird = [
      ev(NaN, 1, 'move', 0.5, 0.5),
      ev(0.1, 2, 'move', NaN, 0.5),
      ev(0.1, 3, 'move', '0.5', 0.5),
      ev(0.1, 4, 'move', 0.5, 0.5, 7),
      ev(0.1, 5.5, 'move', 0.5, 0.5),
      ev(0.1, 6, undefined, 0.5, 0.5),
      ev(0.2, 7, 'up', 0.5, 0.5),
      // Off the canvas is still a position.
      ev(0.3, 8, 'move', -4, 9),
    ];
    // A non-finite knob reads its default, one out of range clamps (Time −1 → 0.1 s).
    const out = tiled(1, weird, 2, { radius: NaN, time: -1 });
    // Any finite channel counts (5.5); a mouse up anchors a stay where it lifted (7).
    expect(fires(out)).toEqual([[0.2, 5.5, 0.5, 0.5, 'mouse'], [0.3, 7, 0.5, 0.5, 'mouse'], [0.4, 8, -4, 9, 'mouse']]);
    expect(out.pass).toHaveLength(weird.length - 1);
    expect(query(dwell, 0, 1, { inputs: { in: [ev(0.1, NaN, 'move', 0.5, 0.5), ev(0.2, Infinity, 'up', 0.5, 0.5)] } })).toEqual({});
  });

  /** A Pointer → Dwell patch, and a mouse stream that hovers, stops, then moves on before Time. */
  const node = (id: string, type: string) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params: {}, position: { x: 0, y: 0 } });
  const patch: Patch = { format: 'flowpatch', version: 1, seed: 1, nodes: [node('p', 'pointer'), node('d', 'dwell')], cables: [{ from: { node: 'p', port: 'all' }, to: { node: 'd', port: 'in' } }] };
  const plan = () => {
    const compiled = compilePatch(patch, nodeRegistry);
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    return compiled.plan;
  };
  const m = (time: number, x: number): InputEvent => ({ time, type: 'pointermove', channel: 1, x, y: 0.5, pointerType: 'mouse', buttons: 0, button: -1 });
  const mouseStream: InputEvent[] = [m(0.1, 0.2), m(0.2, 0.21), m(0.5, 0.5), m(1.0, 0.8), m(1.05, 0.81)];
  const dwellOf = (log: LoggedEvent[]) => log.filter((e) => e.node === 'd' && e.port === 'dwell').map((e) => [+e.time.toFixed(9), e.channel, e.x]);

  /** Replays `events` ahead of the horizon, or pushes each live after the runtime queried `late` s past it; the log either way. */
  function play(events: readonly InputEvent[], late: number | null, end = 2.5) {
    const rt = new Runtime(plan(), { history: late !== null });
    if (late === null) {
      replayInput(rt, { events });
      const log: LoggedEvent[] = [];
      for (let i = 0; i * 0.025 < end - 1e-9; i++) log.push(...rt.query(i * 0.025, (i + 1) * 0.025));
      return { log: rt.sortLog(log), seen: log };
    }
    const router = inputRouter(rt.plan);
    let log: LoggedEvent[] = [];
    let next = 0;
    const seen: LoggedEvent[] = [];
    const queryTo = (t: number) => {
      for (; next * 0.025 < t - 1e-9; next++) {
        const added = rt.query(next * 0.025, (next + 1) * 0.025);
        log.push(...added);
        seen.push(...added);
      }
    };
    for (const event of events) {
      queryTo(event.time + late);
      const report = rt.pushAll(router.route(event).map(({ node: id, port, fields }) => ({ node: id, port, event: { time: event.time, ...fields } as EngineEvent })));
      if (!report) continue;
      log = [...log.filter((e) => !(report.affected.has(e.node) && e.time >= report.time)), ...report.added];
      seen.push(...report.added);
    }
    queryTo(end);
    return { log: rt.sortLog(log), seen };
  }

  it('withdraws a pending fire when the mouse leaves the canvas still, on replay and live', () => {
    // Hovers still from 0.1 (due at 0.7) and leaves at 0.4; then a pen enters, takes the freed slot 1
    // and hovers nearby from 1.0: its stay is its own (due at 1.6), nothing inherited from the mouse.
    const leave: InputEvent = { time: 0.4, type: 'pointerleave', channel: 1, x: 0.21, y: 0.5, pointerType: 'mouse', buttons: 0, button: -1 };
    const pen: InputEvent = { time: 1.0, type: 'pointermove', channel: 2, x: 0.205, y: 0.5, pointerType: 'pen', buttons: 0, button: -1 };
    const events = [m(0.1, 0.2), m(0.2, 0.21), leave, pen];
    const ahead = play(events, null);
    expect(dwellOf(ahead.log)).toEqual([[1.6, 1, 0.205]]);
    // Pointer marked the leave on slot 1 at the mouse's last position, and Dwell passed it on Pass alone.
    const leaves = ahead.log.filter((e) => e.phase === 'leave').map((e) => [e.node, e.port, e.time, e.channel, e.x]);
    expect(leaves).toEqual([['p', 'all', 0.4, 1, 0.21], ['d', 'pass', 0.4, 1, 0.21]]);
    // Without the leave, the mouse's stay fires at its exit point.
    expect(dwellOf(play([m(0.1, 0.2), m(0.2, 0.21)], null).log)).toEqual([[0.7, 1, 0.21]]);
    // Live, the leave arrives after the fire at 0.7 went out, and its rewind withdraws it.
    const live = play(events, 0.7);
    expect(dwellOf(live.seen)).toContainEqual([0.7, 1, 0.21]);
    expect(dwellOf(live.log)).toEqual(dwellOf(ahead.log));
    expect(JSON.stringify(live.log)).toBe(JSON.stringify(ahead.log));
  });

  it('fires from Pointer All on replay, and withdraws a fire a live move cancels by rewinding', () => {
    const ahead = new Runtime(plan());
    replayInput(ahead, { events: mouseStream });
    const aheadLog: LoggedEvent[] = [];
    for (let i = 0; i < 100; i++) aheadLog.push(...ahead.query(i * 0.025, (i + 1) * 0.025));
    expect(dwellOf(aheadLog)).toEqual([[1.6, 1, 0.81]]);

    // Live: each push lands after the runtime has queried 0.7 s past it, so the fire at 0.7
    // (from the hover at 0.1) is emitted, then withdrawn when the move at 0.5 rewinds.
    const rt = new Runtime(plan(), { history: true });
    const router = inputRouter(rt.plan);
    let log: LoggedEvent[] = [];
    let next = 0;
    const seen: LoggedEvent[] = [];
    const queryTo = (t: number) => {
      for (; next * 0.025 < t - 1e-9; next++) {
        const added = rt.query(next * 0.025, (next + 1) * 0.025);
        log.push(...added);
        seen.push(...added);
      }
    };
    for (const event of mouseStream) {
      queryTo(event.time + 0.7);
      const report = rt.pushAll(router.route(event).map(({ node: id, port, fields }) => ({ node: id, port, event: { time: event.time, ...fields } as EngineEvent })));
      if (!report) continue;
      log = [...log.filter((e) => !(report.affected.has(e.node) && e.time >= report.time)), ...report.added];
      seen.push(...report.added);
    }
    queryTo(2.5);
    // The first hover's fire went out before the move at 0.5 withdrew it.
    expect(dwellOf(seen).slice(0, 1)).toEqual([[0.7, 1, 0.2]]);
    expect(dwellOf(rt.sortLog(log))).toEqual(dwellOf(aheadLog));
  });
});
