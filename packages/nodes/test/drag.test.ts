import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@flow-patcher/engine';
import { drag } from '../src';
import { RESERVE } from '../src/pointer';
import { ev, expectClaim, expectPassThrough, expectWindowIndependent, merge, run, stroke } from './recognizers';

/** Channel 1 drags right 0.01 per 20 ms: 0.025 from its down at the third move (0.03). */
const dragged = stroke(1, 0.1, [0.2, 0.5], [0.3, 0.5], 10, 0.02);

describe('drag', () => {
  it('takes In and gives Pass, its phase split, Start, Move and End', () => {
    expect(drag.ports.map((p) => `${p.direction} ${p.name}`)).toEqual(['in in', 'out pass', 'out passDown', 'out passMove', 'out passUp', 'out passCancel', 'out start', 'out move', 'out end']);
  });

  it('claims at the move that passes the minimum distance, with Start there, Move after and End on the up', () => {
    const out = expectWindowIndependent(drag, dragged);
    expectClaim(out, dragged, { claimed: [1], time: 0.16 });
    expect(out.start).toEqual([{ time: 0.16, channel: 1, x: 0.23, y: 0.5, pointerType: 'touch', startX: 0.2, startY: 0.5, deltaX: expect.closeTo(0.03, 12), deltaY: 0, distance: expect.closeTo(0.03, 12), duration: expect.closeTo(0.06, 12) }]);
    expect(out.move?.map((e) => e.time)).toEqual([0.18, 0.2, 0.22, 0.24, 0.26, 0.28, 0.3].map((t) => expect.closeTo(t, 12)));
    expect(out.end).toHaveLength(1);
    expect(out.end![0]).toMatchObject({ x: 0.3, startX: 0.2, distance: expect.closeTo(0.1, 12), duration: expect.closeTo(0.2, 12) });
    expect(out.end![0]!.phase).toBeUndefined();
  });

  it('leaves a contact that stays within the minimum distance to Pass, and keeps channels independent', () => {
    const tap = stroke(2, 0.12, [0.7, 0.7], [0.71, 0.7], 3, 0.02);
    const events = merge(dragged, tap);
    const out = expectWindowIndependent(drag, events);
    expectClaim(out, events, { claimed: [1], time: 0.16, free: [2] });
    expect(out.start?.map((e) => e.channel)).toEqual([1]);
    expectPassThrough(run(drag, tap), tap);
  });

  it('ends a cancelled drag without End, and leaves the other stroke going (Flow: cancelling one stroke preserves the other)', () => {
    const a = stroke(1, 0, [0.2, 0.3], [0.1, 0.33], 4, 0.2, 'cancel');
    const b = stroke(2, 0, [0.8, 0.7], [0.95, 0.75], 8, 0.2);
    const out = run(drag, merge(a, b));
    expect(out.start?.map((e) => e.channel)).toEqual([1, 2]);
    expect(out.end?.map((e) => e.channel)).toEqual([2]);
    // Its second move (0.03 away) starts it; the other six are Moves.
    expect(out.move?.filter((e) => e.channel === 2).length).toBe(6);
  });

  it('reads Minimum distance at each move, so a larger one waits longer', () => {
    expect(run(drag, dragged, { params: { minDistance: 0.065 } }).start?.[0]?.time).toBeCloseTo(0.24, 12);
    expect(run(drag, dragged, { params: { minDistance: 0.5 } }).start).toBeUndefined();
  });

  it('with Claim off, drags and passes everything', () => {
    const out = run(drag, dragged, { params: { claim: false } });
    expectPassThrough(out, dragged);
    expect(out.start).toHaveLength(1);
  });

  it('starts a new contact on a down, so a re-used channel drags afresh', () => {
    const again = merge(dragged, stroke(1, 0.5, [0.6, 0.6], [0.6, 0.62], 2, 0.02));
    const out = run(drag, again);
    expect(out.start).toHaveLength(1);
    expect(out.pass?.filter((e) => e.time >= 0.5).length).toBe(4);
  });

  it('thins Move and passed moves past the reserve, never the ends', () => {
    // 200 moves in one 120 ms limit window on each of two channels.
    const many: EngineEvent[] = [];
    for (const channel of [1, 2]) {
      many.push(ev(0.001, channel, 'down', 0.1, 0.1 * channel));
      for (let i = 1; i <= 200; i++) many.push(ev(0.001 + i * 0.0005, channel, 'move', 0.1 + i * 0.001, 0.1 * channel));
      many.push(ev(0.11, channel, 'up', 0.3, 0.1 * channel));
    }
    many.sort((a, b) => a.time - b.time);
    const out = run(drag, many);
    const total = Object.values(out).reduce((n, list) => n + list.length, 0);
    expect(total).toBeLessThanOrEqual(256);
    expect(out.end?.length).toBe(2);
    expect(out.start?.length).toBe(2);
    expect(out.passCancel?.length).toBe(2);
    expect(total).toBeGreaterThan(256 - RESERVE - 4);
  });

  describe('spacing', () => {
    // The same 0.4 stroke right, 0.01 per 10 ms (slow) and 0.02 per 10 ms (fast). With Minimum
    // distance 0.035 both start at x = 0.24; Spacing just under 0.04 then gives a Move at
    // 0.28, 0.32, ..., 0.60 (9 of them) at either speed.
    const slow = stroke(1, 0, [0.2, 0.5], [0.6, 0.5], 40, 0.01);
    const fast = stroke(2, 0, [0.2, 0.3], [0.6, 0.3], 20, 0.01);
    const params = { minDistance: 0.035, spacing: 0.0395 };
    const crossings = [0.28, 0.32, 0.36, 0.4, 0.44, 0.48, 0.52, 0.56, 0.6];

    it('at 0 (the default) emits a Move on every move after Start, as before', () => {
      expect(drag.params.find((p) => p.name === 'spacing')).toMatchObject({ min: 0, max: 0.5, default: 0, label: 'Spacing' });
      expect(run(drag, dragged, { params: { spacing: 0 } })).toEqual(run(drag, dragged));
      expect(run(drag, slow, { params: { minDistance: 0.035 } }).move).toHaveLength(36);
    });

    it('emits Move once per Spacing of distance from the last Start or Move, at either speed', () => {
      const a = expectWindowIndependent(drag, slow, { params });
      const b = expectWindowIndependent(drag, fast, { params });
      for (const out of [a, b]) {
        expect(out.start?.map((e) => e.x)).toEqual([expect.closeTo(0.24, 12)]);
        expect(out.move?.map((e) => e.x)).toEqual(crossings.map((x) => expect.closeTo(x, 12)));
        expect(out.end).toHaveLength(1);
        expect(out.end![0]).toMatchObject({ x: 0.6, distance: expect.closeTo(0.4, 12) });
      }
      // Same count per distance; the fast stroke gets there in half the time, so twice as many per second.
      expect(a.move?.map((e) => e.time)).toEqual(crossings.map((x) => expect.closeTo(x - 0.2, 12)));
      expect(b.move?.map((e) => e.time)).toEqual(crossings.map((x) => expect.closeTo((x - 0.2) / 2, 12)));
      // Move still carries delta and distance from the down, not from the last Move.
      expect(a.move?.[0]).toMatchObject({ startX: 0.2, deltaX: expect.closeTo(0.08, 12), distance: expect.closeTo(0.08, 12) });
    });

    it('measures from where the last Move was emitted, so an uneven stroke keeps its spacing', () => {
      // Moves at 0.03 steps after a start at 0.24: 0.27 is short of 0.04, 0.30 is past it and becomes the reference.
      const uneven = [ev(0, 1, 'down', 0.2, 0.5), ev(0.01, 1, 'move', 0.24, 0.5), ev(0.02, 1, 'move', 0.27, 0.5), ev(0.03, 1, 'move', 0.3, 0.5), ev(0.04, 1, 'move', 0.33, 0.5), ev(0.05, 1, 'move', 0.36, 0.5), ev(0.06, 1, 'up', 0.36, 0.5)];
      expect(run(drag, uneven, { params }).move?.map((e) => e.x)).toEqual([0.3, 0.36]);
    });

    it('gives one Move for a jump past several Spacings, at the new point, which becomes the reference', () => {
      // Start at 0.24, then one jump of 0.16 (just over 4 Spacings): one Move at 0.40, not four.
      // 0.438 is short of 0.40 + 0.0395, so it's dropped; a reference stepped by Spacing (0.398) would pass it. 0.45 is past it.
      const jump = [ev(0, 1, 'down', 0.2, 0.5), ev(0.01, 1, 'move', 0.24, 0.5), ev(0.02, 1, 'move', 0.4, 0.5), ev(0.03, 1, 'move', 0.438, 0.5), ev(0.04, 1, 'move', 0.45, 0.5), ev(0.05, 1, 'up', 0.45, 0.5)];
      const out = expectWindowIndependent(drag, jump, { params });
      expect(out.start?.map((e) => e.x)).toEqual([0.24]);
      expect(out.move?.map((e) => `${e.time} ${e.x}`)).toEqual(['0.02 0.4', '0.04 0.45']);
    });

    it('keeps channels independent and windowing-independent', () => {
      const both = merge(slow, fast);
      const out = expectWindowIndependent(drag, both, { params });
      const solo = { slow: run(drag, slow, { params }), fast: run(drag, fast, { params }) };
      expect(out.move?.filter((e) => e.channel === 1)).toEqual(solo.slow.move);
      expect(out.move?.filter((e) => e.channel === 2)).toEqual(solo.fast.move);
      expect(out.start?.map((e) => `${e.channel} ${e.time.toFixed(2)}`)).toEqual(['2 0.02', '1 0.04']);
    });

    it('treats NaN or a negative Spacing as 0', () => {
      const plain = run(drag, slow, { params: { minDistance: 0.035 } });
      expect(run(drag, slow, { params: { minDistance: 0.035, spacing: Number.NaN } })).toEqual(plain);
      expect(run(drag, slow, { params: { minDistance: 0.035, spacing: -0.1 } })).toEqual(plain);
    });
  });

  it('gives defined results for weird input', () => {
    const weird: EngineEvent[] = [
      { time: 0.1, channel: 3, x: 0.5 },
      ev(0.2, 4, 'move', 0.5, 0.5),
      ev(0.3, 1, 'down', Number.NaN, 0.5),
      ev(0.4, 1, 'move', 0.9, Number.NaN),
      ev(0.5, 1, 'up', 0.9, 0.5),
      ev(0.6, 2, 'up', 0.9, 0.5),
    ];
    const out = run(drag, weird);
    expect(out.start?.[0]).toMatchObject({ startX: 0, startY: 0.5, x: 0.9 });
    expect(out.end).toHaveLength(1);
    expect(out.pass?.map((e) => `${e.channel} ${e.phase ?? '-'}`)).toEqual(['3 -', '4 move', '1 down', '1 cancel', '2 up']);
    expect(run(drag, [])).toEqual({});
  });
});
