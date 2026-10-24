import { describe, expect, it } from 'vitest';
import { compilePatch, replayInput, Runtime, type EngineEvent, type InputEvent, type LoggedEvent, type Patch } from '@flow-patcher/engine';
import { nodeRegistry, pinch } from '../src';
import { context } from './helpers';
import { ev, expectClaim, expectPassThrough, expectWindowIndependent, merge, run, stroke } from './recognizers';

/** Flow's multitouch test canvas was 1000 × 600 px: its pixel coordinates, normalized. */
const px = (x: number, y: number): [number, number] => [x / 1000, y / 600];
const touch = (time: number, channel: number, phase: 'down' | 'move' | 'up' | 'cancel', x: number, y: number) => ev(time, channel, phase, ...px(x, y));

const signal = (state: Record<string, unknown>, port: string, t: number, channel = 0) => pinch.signal!(context(pinch, { state }), port, t, channel);

/** Flow's gather: fingers at 200 and 800 px close to 300/700 (claim), then 400/600, then finger 1 spreads back to 200. */
const gather: EngineEvent[] = [
  touch(1.0, 1, 'down', 200, 300),
  touch(1.0, 2, 'down', 800, 300),
  touch(1.1, 1, 'move', 300, 300),
  touch(1.1, 2, 'move', 700, 300),
  touch(1.2, 1, 'move', 400, 300),
  touch(1.2, 2, 'move', 600, 300),
  touch(1.3, 1, 'move', 200, 300),
  touch(1.4, 1, 'up', 200, 300),
  touch(1.4, 2, 'up', 600, 300),
];

describe('pinch', () => {
  it('takes In and gives Pass, its phase split, Pinch in, Spread, End and four signals', () => {
    expect(pinch.category).toBe('gesture-recognizers');
    expect(pinch.ports.map((p) => `${p.direction} ${p.name} ${p.type}`)).toEqual([
      'in in event',
      'out pass event', 'out passDown event', 'out passMove event', 'out passUp event', 'out passCancel event',
      'out pinchIn event', 'out spread event', 'out end event',
      'out scale signal', 'out rotation signal', 'out x signal', 'out y signal',
    ]);
  });

  it('claims both fingers once they pinch in, at the move that crosses the threshold, with what came before already passed (no Flow-style hold-back)', () => {
    const out = expectWindowIndependent(pinch, gather);
    // Finger 1's move at 1.1 s still passes: finger 2 hadn't moved yet. Finger 2's move claims.
    expectClaim(out, gather, { claimed: [1, 2], time: 1.1, sameTime: [1] });
    const pass = out.pass!;
    expect(pass.map((e) => `${e.time} ${e.channel} ${e.phase}`)).toEqual(['1 1 down', '1 2 down', '1.1 1 move', '1.1 2 cancel', '1.1 1 cancel']);
    // The cancel replaces the triggering event, payload and all.
    expect(pass[3]).toEqual({ ...gather[3], phase: 'cancel' });
    expect(pass[4]).toEqual({ ...gather[2], phase: 'cancel' });
    expect(out.pinchIn).toEqual([{ time: 1.1, channel: 1, x: 0.5, y: 0.5, scale: expect.closeTo(0.4 / 0.6, 12), rotation: 0, distance: expect.closeTo(0.4, 12) }]);
  });

  it('charges as the fingers close (Flow: Gather midpoint and charge), and spread and lift only Bloom once (Flow)', () => {
    const state = {};
    const out = run(pinch, gather, { state });
    expect(signal(state, 'x', 1.1)).toBeCloseTo(0.5, 12);
    expect(signal(state, 'y', 1.1)).toBeCloseTo(0.5, 12);
    expect(signal(state, 'scale', 1.2)).toBeLessThan(signal(state, 'scale', 1.1));
    // Finger 1 spreads back to 200 px: 0.2 from the closest, past Flow's bloom threshold max(0.06, 0.16 × 0.6).
    expect(out.spread?.map((e) => e.time)).toEqual([1.3]);
    expect(out.spread![0]!.scale).toBeCloseTo(0.4 / 0.6, 12);
    // The Spread ended the pinch: lifting both fingers fires nothing more.
    expect(out.end).toBeUndefined();
    expect(out.pinchIn).toHaveLength(1);
    expect(signal(state, 'scale', 3)).toBeCloseTo(0.4 / 0.6, 12);
  });

  it('reads Scale 1 and the rest 0 before any pinch, the same on every channel', () => {
    const state = {};
    run(pinch, gather, { state });
    expect(['scale', 'rotation', 'x', 'y'].map((p) => signal(state, p, 1.05))).toEqual([1, 0, 0, 0]);
    expect(signal(state, 'scale', 1.25, 7)).toBe(signal(state, 'scale', 1.25, 1));
  });

  it('spreads only past Flow\'s bloom threshold, a little wider than the claim\'s', () => {
    // Closest 0.4 apart at the claim: opening to 0.445 is under max(0.06, 0.16 × 0.6) = 0.096, to 0.5 is past it.
    const under = merge(gather.slice(0, 4), [touch(1.2, 1, 'move', 255, 300)]);
    expect(run(pinch, under).spread).toBeUndefined();
    const past = merge(gather.slice(0, 4), [touch(1.2, 1, 'move', 200, 300)]);
    expect(run(pinch, past).spread?.map((e) => e.time)).toEqual([1.2]);
  });

  it('ends only when both fingers lift (Flow: both fingers lift to Bloom)', () => {
    const events = merge(gather.slice(0, 4), [touch(1.3, 1, 'up', 300, 300), touch(1.5, 2, 'up', 700, 300)]);
    const out = run(pinch, events);
    expect(out.end?.map((e) => e.time)).toEqual([1.5]);
    expect(out.spread).toBeUndefined();
  });

  it('ends without End or Spread when a finger is cancelled (Flow: cancel never produces a release accent)', () => {
    for (const which of [1, 2]) {
      const events = merge(gather.slice(0, 4), [touch(1.3, which, 'cancel', 300, 300), touch(1.5, 3 - which, 'up', 700, 300)]);
      const out = run(pinch, events);
      expect(out.end, `cancel ${which}`).toBeUndefined();
      expect(out.spread).toBeUndefined();
      expectClaim(out, events, { claimed: [1, 2], time: 1.1, sameTime: [1] });
    }
  });

  it('keeps independent strokes independent: spreading apart and a cancel on one don\'t touch the other (Flow)', () => {
    const events = [
      touch(0, 1, 'down', 200, 180), touch(0, 2, 'down', 800, 420),
      touch(0.8, 1, 'move', 100, 200), touch(0.8, 2, 'move', 900, 400),
      touch(0.9, 1, 'cancel', 100, 200),
      touch(1.7, 2, 'move', 950, 450), touch(1.8, 2, 'up', 950, 450),
    ];
    expectPassThrough(expectWindowIndependent(pinch, events), events);
  });

  it('never pinches two parallel strokes, or a pen beside a finger unless Pointers is any (Flow: no parallel-stroke Gather)', () => {
    const parallel = [touch(0, 1, 'down', 200, 200), touch(0, 2, 'down', 700, 200), touch(0.8, 1, 'move', 200, 400), touch(0.8, 2, 'move', 700, 400), touch(1, 1, 'up', 200, 400), touch(1, 2, 'up', 700, 400)];
    expectPassThrough(run(pinch, parallel), parallel);
    const pen = gather.map((e) => (e.channel === 2 ? { ...e, pointerType: 'pen' } : e));
    expectPassThrough(run(pinch, pen), pen);
    expectClaim(run(pinch, pen, { params: { pointers: 'any' } }), pen, { claimed: [1, 2], time: 1.1, sameTime: [1] });
  });

  it('does not take a two-finger drag: the midpoint may not travel as far as the fingers close', () => {
    const drag = [touch(0, 1, 'down', 200, 300), touch(0, 2, 'down', 800, 300), touch(0.1, 1, 'move', 450, 300), touch(0.1, 2, 'move', 950, 300), touch(0.2, 1, 'up', 450, 300), touch(0.2, 2, 'up', 950, 300)];
    // They close by 0.1 (past the 0.084 threshold), but the midpoint travels 0.2, more than 0.7 × 0.1.
    expectPassThrough(run(pinch, drag), drag);
  });

  it('with Pair "only two", lets three fingers alone; with "first two", pairs the first two and passes the third untouched', () => {
    const third = stroke(3, 1.05, [0.5, 0.9], [0.55, 0.9], 10, 0.05);
    const events = merge(gather, third);
    expectPassThrough(run(pinch, events), events);
    const out = expectWindowIndependent(pinch, events, { params: { pair: 'first two' } });
    expectClaim(out, events, { claimed: [1, 2], time: 1.1, free: [3], sameTime: [1] });
  });

  it('keeps a pinch going when a third finger lands, and passes that finger through', () => {
    const third = stroke(3, 1.15, [0.5, 0.9], [0.6, 0.9], 4, 0.05);
    const events = merge(gather, third);
    const out = run(pinch, events);
    expectClaim(out, events, { claimed: [1, 2], time: 1.1, free: [3], sameTime: [1] });
    expect(out.spread?.map((e) => e.time)).toEqual([1.3]);
    expect(out.end).toBeUndefined();
  });

  it('re-forms the pair from where the fingers are after a third one lifts', () => {
    const events = merge(
      [touch(0, 1, 'down', 200, 300), touch(0, 2, 'down', 800, 300)],
      [touch(0.05, 3, 'down', 500, 500), touch(0.1, 1, 'move', 300, 300), touch(0.1, 2, 'move', 700, 300), touch(0.15, 3, 'up', 500, 500)],
      // Closing to 0.4 apart happened with three down: no pinch. From 0.4 apart, closing to 0.36 is under the 0.056 threshold.
      [touch(0.2, 1, 'move', 310, 300), touch(0.2, 2, 'move', 690, 300), touch(0.3, 1, 'move', 320, 300), touch(0.3, 2, 'move', 680, 300)],
    );
    expect(run(pinch, events).pinchIn).toBeUndefined();
    const more = merge(events, [touch(0.4, 1, 'move', 360, 300), touch(0.4, 2, 'move', 640, 300)]);
    expect(run(pinch, more).pinchIn?.map((e) => e.time)).toEqual([0.4]);
  });

  it('with Starts "either", claims a spread too, as a Spread that ends the pinch', () => {
    const events = [
      touch(0, 1, 'down', 400, 300), touch(0, 2, 'down', 600, 300),
      touch(0.1, 1, 'move', 300, 300), touch(0.1, 2, 'move', 700, 300),
      touch(0.2, 1, 'move', 450, 300), touch(0.2, 2, 'move', 550, 300),
      touch(0.3, 1, 'up', 450, 300), touch(0.3, 2, 'up', 550, 300),
    ];
    // By default the spread passes, and the close from 0.2 apart to 0.1 is the claim.
    expect(run(pinch, events).pinchIn?.map((e) => e.time)).toEqual([0.2]);
    expect(run(pinch, events).spread).toBeUndefined();
    const out = run(pinch, events, { params: { starts: 'either' } });
    expectClaim(out, events, { claimed: [1, 2], time: 0.1, sameTime: [1] });
    expect(out.spread?.map((e) => e.time)).toEqual([0.1]);
    // The fingers stay claimed until they lift, but the pinch is over: no Pinch in, no End.
    expect(out.pinchIn).toBeUndefined();
    expect(out.end).toBeUndefined();
  });

  it('follows rotation unwrapped, clockwise on screen positive', () => {
    const state = {};
    const events: EngineEvent[] = [ev(0, 1, 'down', 0.3, 0.5), ev(0, 2, 'down', 0.7, 0.5), ev(0.05, 1, 'move', 0.35, 0.5), ev(0.05, 2, 'move', 0.65, 0.5)];
    // Then the pair (0.15 from the middle) turns 1.5 revolutions clockwise in 30 steps.
    for (let i = 1; i <= 30; i++) {
      const a = Math.PI + (i / 30) * 3 * Math.PI;
      events.push(ev(0.05 + i * 0.01, 1, 'move', 0.5 + 0.15 * Math.cos(a), 0.5 + 0.15 * Math.sin(a)));
      events.push(ev(0.05 + i * 0.01, 2, 'move', 0.5 - 0.15 * Math.cos(a), 0.5 - 0.15 * Math.sin(a)));
    }
    run(pinch, events, { state });
    expect(signal(state, 'rotation', 1)).toBeCloseTo(3 * Math.PI, 9);
    expect(signal(state, 'scale', 1)).toBeCloseTo(0.75, 9);
  });

  it('with Claim off, recognizes the pinch and passes everything', () => {
    const out = run(pinch, gather, { params: { claim: false } });
    expectPassThrough(out, gather);
    expect(out.pinchIn).toHaveLength(1);
    expect(out.spread).toHaveLength(1);
    expect(out.end).toBeUndefined();
  });

  it('with Claim off, still ends the pinch at the Spread: the fingers don\'t pair again until they lift', () => {
    const events = [
      ev(0, 1, 'down', 0.2, 0.5), ev(0, 2, 'down', 0.8, 0.5),
      ev(0.1, 1, 'move', 0.3, 0.5), ev(0.1, 2, 'move', 0.7, 0.5),
      ev(0.2, 1, 'move', 0.1, 0.5), ev(0.2, 2, 'move', 0.9, 0.5),
      ev(0.3, 1, 'move', 0.3, 0.5), ev(0.3, 2, 'move', 0.7, 0.5),
      ev(0.4, 1, 'move', 0.4, 0.5), ev(0.4, 2, 'move', 0.6, 0.5),
      ev(0.5, 1, 'up', 0.4, 0.5), ev(0.5, 2, 'up', 0.6, 0.5),
    ];
    for (const claim of [true, false]) {
      const out = run(pinch, events, { params: { claim } });
      expect(out.pinchIn?.map((e) => e.time), `claim ${claim}`).toEqual([0.1]);
      expect(out.spread?.map((e) => e.time)).toEqual([0.2]);
      expect(out.end).toBeUndefined();
    }
    expectPassThrough(run(pinch, events, { params: { claim: false } }), events);
  });

  it('gives defined results for weird input', () => {
    const weird: EngineEvent[] = [
      { time: 0.1, channel: 5, x: 0.5, y: 0.5 }, // no phase: passes, on Pass only
      ev(0.2, 6, 'up', 0.5, 0.5), // an end with no contact
      ev(0.3, 7, 'move', 0.5, 0.5), // a hover move
      ev(0.4, Number.NaN, 'down', 0.5, 0.5),
      ev(Number.NaN, 1, 'down', 0.5, 0.5),
      ev(0.5, 1, 'down', Number.NaN, Number.POSITIVE_INFINITY),
      ev(0.5, 2, 'down', 0.5, 0.5),
      ev(0.6, 1, 'move', Number.NaN, 0.5),
      ev(0.7, 2, 'move', 0.5, 0.5),
      ev(0.8, 1, 'up', 0, 0),
      ev(0.8, 2, 'up', 0.5, 0.5),
    ];
    const state = {};
    const out = run(pinch, weird, { state });
    expect(out.pass?.map((e) => e.channel)).toEqual([5, 6, 7, 1, 2, 1, 2, 1, 2]);
    expect(out.passDown?.length).toBe(2);
    expect(out.pinchIn).toBeUndefined();
    for (const port of ['scale', 'rotation', 'x', 'y']) expect(Number.isFinite(signal(state, port, Number.NaN))).toBe(true);
    expect(run(pinch, [])).toEqual({});
  });
});

/** Pointer → Pinch, painting from Pass Down and Pass Move through Make Note, wired as examples/pinch-paint.flowpatch wires its paint path. */
const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });
const ownershipPatch: Patch = {
  format: 'flowpatch', version: 1, seed: 1,
  nodes: [node('pointer', 'pointer'), node('pinch', 'pinch'), node('paint', 'make-note', { pitch: 60 })],
  cables: [
    { from: { node: 'pointer', port: 'all' }, to: { node: 'pinch', port: 'in' } },
    { from: { node: 'pinch', port: 'passDown' }, to: { node: 'paint', port: 'trigger' } },
    { from: { node: 'pinch', port: 'passMove' }, to: { node: 'paint', port: 'trigger' } },
  ],
};

/** An ADR 0029 stream: finger 21 paints a stroke; finger 22 lands; both close in, and the pinch claims. Raw pointerIds. */
function ownershipStream(): InputEvent[] {
  const t = (time: number, type: string, pointerId: number, x: number, y: number): InputEvent =>
    ({ time, type, channel: pointerId, x, y, pressure: type === 'pointerup' ? 0 : 0.5, pointerType: 'touch' }) as InputEvent;
  const events: InputEvent[] = [t(0.1, 'pointerdown', 21, 0.2, 0.5)];
  for (let i = 1; i <= 8; i++) events.push(t(0.1 + i * 0.04, 'pointermove', 21, 0.2 + i * 0.01, 0.5));
  events.push(t(0.5, 'pointerdown', 22, 0.8, 0.5));
  for (let i = 1; i <= 10; i++) {
    events.push(t(0.5 + i * 0.03, 'pointermove', 21, 0.28 + i * 0.012, 0.5));
    events.push(t(0.5 + i * 0.03, 'pointermove', 22, 0.8 - i * 0.012, 0.5));
  }
  events.push(t(0.9, 'pointerup', 21, 0.4, 0.5), t(0.9, 'pointerup', 22, 0.68, 0.5));
  return events;
}

describe('ownership (M2 gate)', () => {
  it('stops painting from both fingers at the claim, with exactly one Cancel per claimed channel downstream of Pass', () => {
    for (const window of [0.025, 0.1, 2]) {
      const compiled = compilePatch(ownershipPatch, nodeRegistry);
      if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
      const runtime = new Runtime(compiled.plan);
      replayInput(runtime, { events: ownershipStream() });
      const log: LoggedEvent[] = [];
      for (let i = 0; i * window < 2; i++) log.push(...runtime.query(i * window, (i + 1) * window));
      const of = (id: string, port: string): EngineEvent[] => log.filter((e) => e.node === id && e.port === port).map(({ node: _n, port: _p, ...e }) => e);
      const claim = of('pinch', 'pinchIn');
      expect(claim, `${window} s windows`).toHaveLength(1);
      const at = claim[0]!.time;
      // The pair forms 0.52 apart at 0.5 s; each step closes it by 0.012 per finger. The change first passes
      // max(0.055, 0.14 × 0.52) = 0.0728 at finger 21's (slot 1's) fourth move, 0.084 at 0.62 s.
      expect(at).toBeCloseTo(0.62, 9);
      // Finger 21 painted on its own before the second finger landed.
      expect(of('paint', 'note').filter((e) => e.time < 0.5).length).toBeGreaterThan(5);
      // Pointer slots: 21 → 1, 22 → 2.
      for (const channel of [1, 2]) {
        const pass = of('pinch', 'pass').filter((e) => e.channel === channel);
        // Before the claim, Pass is exactly Pointer's All: the triggering move isn't forwarded ahead of its cancel.
        expect(pass.slice(0, -1), `channel ${channel}`).toEqual(of('pointer', 'all').filter((e) => e.channel === channel && e.time < at));
        expect(pass.at(-1)).toMatchObject({ time: at, phase: 'cancel' });
        // Exactly one Cancel downstream of Pass, on Pass and on Pass Cancel.
        expect(pass.filter((e) => e.phase === 'cancel')).toHaveLength(1);
        expect(of('pinch', 'passCancel').filter((e) => e.channel === channel).map((e) => e.time)).toEqual([at]);
        // The paint path: nothing from the channel at or after the claim, and no cancel turned into a note.
        const notes = of('paint', 'note').filter((e) => e.channel === channel);
        expect(notes.filter((e) => e.time >= at)).toEqual([]);
        expect(notes.filter((e) => e.phase === 'cancel')).toEqual([]);
      }
      expect(of('pinch', 'end').map((e) => e.time)).toEqual([0.9]);
    }
  });
});
