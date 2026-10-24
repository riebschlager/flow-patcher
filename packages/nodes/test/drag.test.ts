import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@flow-patcher/engine';
import { drag } from '../src';
import { RESERVE } from '../src/recognizer';
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
