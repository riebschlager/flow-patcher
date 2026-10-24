import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@flow-patcher/engine';
import { flick } from '../src';
import { ev, expectClaim, expectPassThrough, expectWindowIndependent, merge, run, stroke } from './recognizers';

/** Flow's flick: from 0.1 across by 0.08 every 16 ms, eight times, lifted 1 ms after the last. */
function flung(channel = 1, t0 = 0, y = 0.5, dir = 1): EngineEvent[] {
  const out = [ev(t0, channel, 'down', 0.5 - dir * 0.4, y)];
  for (let i = 1; i <= 8; i++) out.push(ev(t0 + i * 0.016, channel, 'move', 0.5 - dir * 0.4 + dir * i * 0.08, y));
  out.push(ev(t0 + 0.129, channel, 'up', 0.5 - dir * 0.4 + dir * 0.64, y));
  return out;
}

describe('flick', () => {
  it('takes In and gives Pass, its phase split and Flick', () => {
    expect(flick.ports.map((p) => `${p.direction} ${p.name}`)).toEqual(['in in', 'out pass', 'out passDown', 'out passMove', 'out passUp', 'out passCancel', 'out flick']);
  });

  it('flicks on a fast release, claiming at the up (Flow: end(129).kind === flick)', () => {
    const events = flung();
    const out = expectWindowIndependent(flick, events);
    expectClaim(out, events, { claimed: [1], time: 0.129 });
    expect(out.pass!.at(-1)).toEqual({ ...events.at(-1), phase: 'cancel' });
    expect(out.flick).toHaveLength(1);
    expect(out.flick![0]).toMatchObject({ time: 0.129, channel: 1, x: expect.closeTo(0.74, 12), angle: 0 });
    // Eight steps of 5 units/s, capped at 4, blended 40% at a time.
    expect(out.flick![0]!.speed).toBeCloseTo(4 * (1 - 0.6 ** 8), 9);
  });

  it('gives the direction of the last step', () => {
    expect(run(flick, flung(1, 0, 0.5, -1)).flick?.[0]?.angle).toBeCloseTo(Math.PI, 12);
    const down = [ev(0, 1, 'down', 0.5, 0.1), ...[1, 2, 3, 4, 5].map((i) => ev(i * 0.016, 1, 'move', 0.5, 0.1 + i * 0.05)), ev(0.09, 1, 'up', 0.5, 0.35)];
    expect(run(flick, down).flick?.[0]?.angle).toBeCloseTo(Math.PI / 2, 12);
  });

  it('is no flick when slow, when it stopped before lifting, or when cancelled', () => {
    const slow = stroke(1, 0, [0.2, 0.5], [0.3, 0.5], 10, 0.05);
    expectPassThrough(run(flick, slow), slow);
    const paused = [...flung().slice(0, -1), ev(0.3, 1, 'up', 0.74, 0.5)];
    expectPassThrough(run(flick, paused), paused);
    const cancelled = [...flung().slice(0, -1), ev(0.129, 1, 'cancel', 0.74, 0.5)];
    expectPassThrough(run(flick, cancelled), cancelled);
    const still = [ev(0, 1, 'down', 0.5, 0.5), ev(0.05, 1, 'up', 0.5, 0.5)];
    expectPassThrough(run(flick, still), still);
  });

  it('reads Speed threshold at the up', () => {
    expect(run(flick, flung(), { params: { threshold: 4 } }).flick).toBeUndefined();
    const slow = stroke(1, 0, [0.2, 0.5], [0.3, 0.5], 10, 0.02);
    expect(run(flick, slow, { params: { threshold: 0.3 } }).flick).toHaveLength(1);
  });

  it('keeps channels independent: one finger flicks while another drags slowly and lifts', () => {
    const slow = stroke(2, 0.02, [0.3, 0.8], [0.35, 0.8], 5, 0.04);
    const events = merge(flung(1, 0.05, 0.2), slow);
    const out = expectWindowIndependent(flick, events);
    expectClaim(out, events, { claimed: [1], time: 0.05 + 0.129, free: [2] });
    expect(out.flick?.map((e) => e.channel)).toEqual([1]);
  });

  it('with Claim off, flicks and passes everything', () => {
    const events = flung();
    const out = run(flick, events, { params: { claim: false } });
    expectPassThrough(out, events);
    expect(out.flick).toHaveLength(1);
  });

  it('gives defined results for weird input', () => {
    const weird = flung().map((e, i) => (i === 3 ? { ...e, x: Number.NaN } : e));
    weird.unshift({ time: 0, channel: 9 }, ev(0, 4, 'up', 0.5, 0.5));
    const out = run(flick, weird);
    expect(out.flick).toHaveLength(1);
    expect(Number.isFinite(out.flick![0]!.speed as number)).toBe(true);
    expect(run(flick, [])).toEqual({});
  });
});
