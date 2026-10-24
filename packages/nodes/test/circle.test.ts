import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@flow-patcher/engine';
import { circle } from '../src';
import { context } from './helpers';
import { ev, expectClaim, expectPassThrough, expectWindowIndependent, merge, run, stroke } from './recognizers';

const read = (state: Record<string, unknown>, port: string, t: number, channel = 1) => circle.signal!(context(circle, { state }), port, t, channel);

/** Flow's circle: from (0.62, 0.5), once around a 0.12 radius in 80 moves 20 ms apart; `spin` 1 is clockwise on screen. */
function orbit(spin: 1 | -1, channel = 1, t0 = 0, cx = 0.5, cy = 0.5, r = 0.12, end: 'up' | 'cancel' = 'up'): EngineEvent[] {
  const out = [ev(t0, channel, 'down', cx + r, cy)];
  for (let i = 1; i <= 80; i++) {
    const a = (i / 80) * Math.PI * 2 * spin;
    out.push(ev(Math.round((t0 + i * 0.02) * 1e9) / 1e9, channel, 'move', cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  out.push(ev(Math.round((t0 + 1.61) * 1e9) / 1e9, channel, end, cx + r, cy));
  return out;
}

/** The move that starts an `orbit`: each step after the first turns 2π/80, so the 38th move is the first past START_TURN (37 × 2π/80 ≈ 2.906). */
const startMove = (events: EngineEvent[]) => events[38]!.time;

describe('circle', () => {
  it('takes In and gives Pass, its phase split, Orbit start, Orbit end and three signals', () => {
    expect(circle.ports.map((p) => `${p.direction} ${p.name} ${p.type}`)).toEqual([
      'in in event', 'out pass event', 'out passDown event', 'out passMove event', 'out passUp event', 'out passCancel event',
      'out start event', 'out end event', 'out angle signal', 'out revolutions signal', 'out direction signal',
    ]);
  });

  for (const spin of [-1, 1] as const) {
    it(`claims a ${spin > 0 ? 'clockwise' : 'counterclockwise'} circle partway round, with its direction (Flow: both circle directions)`, () => {
      const events = orbit(spin);
      const state = {};
      const out = run(circle, events, { state });
      expect(run(circle, events, { step: 0.025 })).toEqual(out);
      expect(run(circle, events, { step: 0.1 })).toEqual(out);
      const at = startMove(events);
      expectClaim(out, events, { claimed: [1], time: at });
      expect(out.start).toHaveLength(1);
      expect(out.start![0]).toMatchObject({ time: at, channel: 1, direction: spin });
      expect(Math.abs(out.start![0]!.angle as number)).toBeGreaterThanOrEqual(2.875);
      // Flow: orbit > 0.8 and kind orbit by the end of the turn; here the whole revolution shows on Angle.
      expect(read(state, 'angle', 1.6)).toBeCloseTo(spin * (2 * Math.PI - (2 * Math.PI) / 80), 9);
      expect(read(state, 'revolutions', 1.6)).toBeCloseTo(79 / 80, 9);
      expect(read(state, 'direction', 1.6)).toBe(spin);
      expect(out.end).toHaveLength(1);
      expect(out.end![0]!.time).toBe(1.61);
      // Holds after the end.
      expect(read(state, 'direction', 3)).toBe(spin);
    });
  }

  it('reads 0 before the orbit starts', () => {
    const state = {};
    run(circle, orbit(1), { state });
    for (const port of ['angle', 'revolutions', 'direction']) expect(read(state, port, 0.5)).toBe(0);
  });

  it('never takes a straight line: a flick or a vertical sweep (Flow: orbit 0)', () => {
    const flick = [ev(0, 1, 'down', 0.1, 0.5), ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => ev(i * 0.016, 1, 'move', 0.1 + i * 0.08, 0.5)), ev(0.129, 1, 'up', 0.74, 0.5)];
    expectPassThrough(run(circle, flick), flick);
    const sweep = stroke(1, 0, [0.4, 0.8], [0.4, 0.35], 10, 0.04);
    expectPassThrough(run(circle, sweep), sweep);
  });

  it('needs Minimum radius: a tight circle passes with a larger one', () => {
    const tight = orbit(1, 1, 0, 0.5, 0.5, 0.04);
    expect(run(circle, tight).start).toHaveLength(1);
    expectPassThrough(run(circle, tight, { params: { minRadius: 0.05 } }), tight);
  });

  it('ends a cancelled orbit without Orbit end, and keeps channels independent', () => {
    const a = orbit(1, 1, 0, 0.3, 0.3, 0.1, 'cancel');
    const b = orbit(-1, 2, 0.3, 0.7, 0.7, 0.1);
    const c = stroke(3, 0.2, [0.1, 0.9], [0.9, 0.9], 20, 0.05);
    const events = merge(a, b, c);
    const state = {};
    const out = run(circle, events, { state });
    expect(run(circle, events, { step: 0.037 })).toEqual(out);
    expectClaim(out, events, { claimed: [1], time: startMove(a), free: [3] });
    expectClaim(out, events, { claimed: [2], time: Math.round((startMove(orbit(-1)) + 0.3) * 1e9) / 1e9 });
    expect(out.end?.map((e) => e.channel)).toEqual([2]);
    expect(read(state, 'direction', 1.5, 1)).toBe(1);
    expect(read(state, 'direction', 1.5, 2)).toBe(-1);
    // Channel 0 reads whoever changed last: channel 2, still circling after channel 1's cancel.
    expect(read(state, 'direction', 1.75, 0)).toBe(-1);
  });

  it('starts each contact afresh on a down', () => {
    const state = {};
    run(circle, merge(orbit(1), [ev(2, 1, 'down', 0.5, 0.5), ev(2.1, 1, 'move', 0.6, 0.5)]), { state });
    expect(read(state, 'direction', 1.9)).toBe(1);
    expect(read(state, 'direction', 2)).toBe(0);
  });

  it('with Claim off, starts and ends the orbit and passes everything', () => {
    const events = orbit(1);
    const out = run(circle, events, { params: { claim: false } });
    expectPassThrough(out, events);
    expect(out.start).toHaveLength(1);
    expect(out.end).toHaveLength(1);
  });

  it('gives defined results for weird input', () => {
    const weird = orbit(1).map((e, i) => (i % 7 === 3 ? { ...e, y: Number.NaN } : e));
    weird.unshift({ time: 0, channel: 9 }, ev(0, 4, 'cancel', 0.5, 0.5));
    const state = {};
    expectWindowIndependent(circle, weird);
    run(circle, weird, { state });
    expect(Number.isFinite(read(state, 'angle', 1))).toBe(true);
    expect(read({}, 'angle', 1)).toBe(0);
    expect(run(circle, [])).toEqual({});
  });
});
