import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@flow-patcher/engine';
import { hold } from '../src';
import { context } from './helpers';
import { ev, expectClaim, expectPassThrough, expectWindowIndependent, merge, run, stroke } from './recognizers';

const charge = (state: Record<string, unknown>, t: number, channel = 1) => hold.signal!(context(hold, { state }), 'charge', t, channel);

/** Flow's held finger: down at 0.5, 0.5 and up 1.4 s later, with a little jitter. */
/** When a contact down at `t` claims with the default knobs: 0.25 s delay, then 0.4 × 1.1 s (as the node sums them). */
const claimAt = (t: number) => t + 0.25 + 0.4 * 1.1;

const held = [ev(0, 1, 'down', 0.5, 0.5), ev(0.5, 1, 'move', 0.505, 0.5), ev(1.4, 1, 'up', 0.505, 0.5)];

describe('hold', () => {
  it('takes In and gives Pass, its phase split, Release and Charge', () => {
    expect(hold.ports.map((p) => `${p.direction} ${p.name} ${p.type}`)).toEqual(['in in event', 'out pass event', 'out passDown event', 'out passMove event', 'out passUp event', 'out passCancel event', 'out release event', 'out charge signal']);
  });

  it('charges while held still and releases on the up (Flow: hold, then bloom)', () => {
    const state = {};
    const out = run(hold, held, { state });
    expect(charge(state, 0.2)).toBe(0);
    expect(charge(state, 0.8)).toBeCloseTo(0.5, 12);
    // Flow: sample(1400).kind === 'hold' (held > 0.35).
    expect(charge(state, 1.39)).toBeGreaterThan(0.35);
    expect(charge(state, 1.4)).toBe(0);
    // Flow: end(1400).kind === 'bloom'.
    expect(out.release).toEqual([{ time: 1.4, channel: 1, x: 0.505, y: 0.5, pointerType: 'touch', charge: 1, duration: 1.4 }]);
  });

  it('claims from its timer when the charge reaches Min charge, with a cancel then', () => {
    const out = expectWindowIndependent(hold, held);
    const at = claimAt(0);
    expectClaim(out, held, { claimed: [1], time: at });
    expect(out.pass!.at(-1)).toEqual({ ...held[1], time: at, phase: 'cancel' });
  });

  it('never releases a cancelled hold (Flow: end(1600, cancel) is a cancel)', () => {
    const cancelled = [ev(0, 1, 'down', 0.5, 0.5), ev(1.6, 1, 'cancel', 0.5, 0.5)];
    const state = {};
    const out = run(hold, cancelled, { state });
    expect(out.release).toBeUndefined();
    expectClaim(out, cancelled, { claimed: [1], time: claimAt(0) });
    expect(charge(state, 1.6)).toBe(0);
  });

  it('emits nothing while held, and the charge is audible before the release (Flow: Gather sounds before release)', () => {
    const state = {};
    const out = run(hold, held, { state });
    expect(Object.keys(out).sort()).toEqual(['pass', 'passCancel', 'passDown', 'passMove', 'release']);
    expect(charge(state, 1)).toBeGreaterThan(0.4);
  });

  it('stops charging for good once the contact leaves the radius, and lets a quick tap go', () => {
    const wander = [ev(0, 1, 'down', 0.5, 0.5), ev(0.3, 1, 'move', 0.6, 0.5), ev(0.6, 1, 'move', 0.5, 0.5), ev(1.5, 1, 'up', 0.5, 0.5)];
    const state = {};
    const out = run(hold, wander, { state });
    expectPassThrough(out, wander);
    expect(charge(state, 1)).toBe(0);
    const tapped = [ev(0, 1, 'down', 0.5, 0.5), ev(0.4, 1, 'up', 0.5, 0.5)];
    expectPassThrough(run(hold, tapped), tapped);
  });

  it('keeps fingers independent: two holds charge on their own, and cancelling one leaves the other (Flow: independent Gather rings)', () => {
    const a = [ev(0, 1, 'down', 0.2, 0.3), ev(1, 1, 'cancel', 0.2, 0.3)];
    const b = [ev(0.3, 2, 'down', 0.8, 0.6), ev(1.5, 2, 'up', 0.8, 0.6)];
    const c = stroke(3, 0.1, [0.5, 0.5], [0.7, 0.5], 4, 0.1);
    const events = merge(a, b, c);
    const state = {};
    const out = run(hold, events, { state });
    expect(run(hold, events, { step: 0.025 })).toEqual(out);
    expectClaim(out, events, { claimed: [1], time: claimAt(0), free: [3] });
    expectClaim(out, events, { claimed: [2], time: claimAt(0.3) });
    expect(out.release?.map((e) => e.channel)).toEqual([2]);
    expect(charge(state, 0.9, 1)).toBeCloseTo(0.65 / 1.1, 12);
    expect(charge(state, 0.9, 2)).toBeCloseTo(0.35 / 1.1, 12);
    expect(charge(state, 1.2, 1)).toBe(0);
    // Channel 0 reads the contact that changed last.
    expect(charge(state, 0.95, 0)).toBe(charge(state, 0.95, 3));
    expect(charge(state, 1.2, 0)).toBe(charge(state, 1.2, 1));
  });

  it('with Claim off, charges and releases, and passes everything', () => {
    const out = run(hold, held, { params: { claim: false } });
    expectPassThrough(out, held);
    expect(out.release).toHaveLength(1);
  });

  it('follows its knobs', () => {
    const out = run(hold, held, { params: { delay: 0, chargeTime: 2, minCharge: 0.8 } });
    expect(out.release).toBeUndefined();
    expect(out.passCancel).toBeUndefined();
    expect(run(hold, held, { params: { chargeTime: 0, minCharge: 1 } }).release?.[0]?.charge).toBe(1);
  });

  it('gives defined results for weird input', () => {
    const weird: EngineEvent[] = [{ time: 0.1, channel: 2 }, ev(0.2, 1, 'down', Number.NaN, 0.5), ev(0.3, 1, 'move', Number.NaN, Number.NaN), ev(1.3, 1, 'up', 0, 0.5)];
    const state = {};
    const out = run(hold, weird, { state });
    expect(out.release).toHaveLength(1);
    expect(Number.isFinite(charge(state, Number.NaN))).toBe(true);
    expect(charge({}, 1)).toBe(0);
    expect(run(hold, [])).toEqual({});
  });
});
