import { describe, expect, it } from 'vitest';
import type { EngineEvent, NodeDefinition } from '@flow-patcher/engine';
import { tap } from '../src';
import { ev, expectClaim, expectPassThrough, expectWindowIndependent as windowed, merge, run as runRaw, type RunOptions, stroke } from './recognizers';

// Claim is off by default on Tap; these tests turn it on unless they say otherwise.
const claiming = (o: RunOptions = {}): RunOptions => ({ ...o, params: { claim: true, ...o.params } });
const run = (d: NodeDefinition, e: readonly EngineEvent[], o?: RunOptions) => runRaw(d, e, claiming(o));
const expectWindowIndependent = (d: NodeDefinition, e: readonly EngineEvent[], o?: RunOptions) => windowed(d, e, claiming(o));

const round = (t: number) => Math.round(t * 1e9) / 1e9;
/** A down, a small move and an up `length` seconds later. */
const quick = (channel: number, t: number, x = 0.5, y = 0.5, length = 0.1): EngineEvent[] => [ev(t, channel, 'down', x, y), ev(round(t + length / 2), channel, 'move', x + 0.005, y), ev(round(t + length), channel, 'up', x + 0.005, y)];

describe('tap', () => {
  it('takes In and gives Pass, its phase split, Tap, Double tap and Long press', () => {
    expect(tap.ports.map((p) => `${p.direction} ${p.name}`)).toEqual(['in in', 'out pass', 'out passDown', 'out passMove', 'out passUp', 'out passCancel', 'out tap', 'out doubleTap', 'out longPress']);
  });

  it('taps on a quick up that barely moved, claiming it there: the up becomes the cancel', () => {
    const events = quick(1, 0.2);
    const out = expectWindowIndependent(tap, events);
    expectClaim(out, events, { claimed: [1], time: 0.3 });
    expect(out.pass!.at(-1)).toEqual({ ...events[2], phase: 'cancel' });
    expect(out.tap).toEqual([{ time: 0.3, channel: 1, x: 0.505, y: 0.5, pointerType: 'touch', duration: expect.closeTo(0.1, 12) }]);
    expect(out.doubleTap).toBeUndefined();
    expect(out.longPress).toBeUndefined();
  });

  it('is no tap when the contact strays past Max movement or stays down past Max duration', () => {
    const strayed = stroke(1, 0.2, [0.5, 0.5], [0.55, 0.5], 2, 0.05);
    expectPassThrough(run(tap, strayed), strayed);
    const slow = quick(1, 0.2, 0.5, 0.5, 0.4);
    expectPassThrough(run(tap, slow), slow);
    expect(run(tap, slow, { params: { maxDuration: 0.45 } }).tap).toHaveLength(1);
  });

  it('long-presses from its own timer, claiming with a cancel at that time, and the up is no tap', () => {
    const held = [ev(0.2, 1, 'down', 0.5, 0.5), ev(0.4, 1, 'move', 0.51, 0.5), ev(1.2, 1, 'up', 0.51, 0.5)];
    const out = expectWindowIndependent(tap, held);
    expectClaim(out, held, { claimed: [1], time: 0.7 });
    expect(out.pass!.at(-1)).toEqual({ ...held[1], time: 0.7, phase: 'cancel' });
    expect(out.longPress).toEqual([{ time: 0.7, channel: 1, x: 0.51, y: 0.5, pointerType: 'touch', duration: expect.closeTo(0.5, 12) }]);
    expect(out.tap).toBeUndefined();
  });

  it('fires a long press due at the up\'s exact time first', () => {
    const out = run(tap, [ev(0.2, 1, 'down', 0.5, 0.5), ev(0.7, 1, 'up', 0.5, 0.5)], { params: { maxDuration: 1 } });
    expect(out.longPress).toHaveLength(1);
    expect(out.tap).toBeUndefined();
  });

  it('no long press for a contact that moved away, lifted or was cancelled first', () => {
    for (const events of [stroke(1, 0.2, [0.5, 0.5], [0.6, 0.5], 4, 0.1, null), [ev(0.2, 1, 'down', 0.5, 0.5), ev(0.5, 1, 'cancel', 0.5, 0.5)], quick(1, 0.2)]) {
      expect(run(tap, events).longPress).toBeUndefined();
    }
  });

  it('double-taps on a second tap close by within Double gap; both still tap, and a third starts again', () => {
    const events = merge(quick(1, 0.2), quick(1, 0.45, 0.52), quick(1, 0.7));
    const out = expectWindowIndependent(tap, events);
    expect(out.tap?.map((e) => e.time)).toEqual([0.3, 0.55, 0.8].map((t) => expect.closeTo(t, 12)));
    expect(out.doubleTap).toEqual([expect.objectContaining({ time: 0.55, channel: 1, gap: expect.closeTo(0.15, 12) })]);
    // Too slow, too far, or on another channel: no double tap.
    expect(run(tap, merge(quick(1, 0.2), quick(1, 0.7))).doubleTap).toBeUndefined();
    expect(run(tap, merge(quick(1, 0.2), quick(1, 0.45, 0.6))).doubleTap).toBeUndefined();
    expect(run(tap, merge(quick(1, 0.2), quick(2, 0.45))).doubleTap).toBeUndefined();
  });

  it('keeps channels independent: one finger\'s long press and another\'s tap and drag', () => {
    const held = [ev(0.1, 1, 'down', 0.2, 0.2), ev(1, 1, 'up', 0.2, 0.2)];
    const taps = quick(2, 0.3, 0.8, 0.8);
    const dragged = stroke(3, 0.2, [0.4, 0.4], [0.6, 0.4], 5, 0.05);
    const events = merge(held, taps, dragged);
    const out = expectWindowIndependent(tap, events);
    expectClaim(out, events, { claimed: [1], time: 0.6, free: [3] });
    expectClaim(out, events, { claimed: [2], time: 0.4 });
    expect(out.longPress?.map((e) => e.channel)).toEqual([1]);
    expect(out.tap?.map((e) => e.channel)).toEqual([2]);
  });

  it('claims nothing by default (Claim off): recognizes and passes everything', () => {
    const events = merge(quick(1, 0.2), [ev(0.5, 2, 'down', 0.5, 0.5), ev(1.5, 2, 'up', 0.5, 0.5)]);
    const out = runRaw(tap, events);
    expectPassThrough(out, events);
    expect(out.tap).toHaveLength(1);
    expect(out.longPress).toHaveLength(1);
  });

  it('gives defined results for weird input', () => {
    const weird: EngineEvent[] = [
      { time: 0.1, channel: 3 },
      ev(0.2, 4, 'up', 0.5, 0.5),
      ev(0.3, 1, 'down', Number.NaN, Number.NaN),
      ev(0.35, 1, 'up', Number.NaN, 0.01),
    ];
    const out = run(tap, weird);
    expect(out.tap).toEqual([expect.objectContaining({ time: 0.35, channel: 1 })]);
    expect(run(tap, [])).toEqual({});
  });
});
