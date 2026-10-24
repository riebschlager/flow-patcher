// Recognizers chained through Pass (ADR 0028): priority is wiring. Also timer claims under live input.
import { describe, expect, it } from 'vitest';
import { compilePatch, ManualClock, Runtime, Scheduler, type EngineEvent, type LoggedEvent, type Patch } from '@flow-patcher/engine';
import { drag, nodeRegistry, pinch } from '../src';
import { ev, merge, run } from './recognizers';

describe('recognizers chained through Pass', () => {
  it('Pinch → Drag: the pinch takes both fingers, Drag keeps what it had, and the end of the chain sees one cancel per contact', () => {
    // Finger 1 strokes (a drag), then finger 2 lands and the two close in.
    const events: EngineEvent[] = merge(
      [ev(0, 1, 'down', 0.2, 0.5), ev(0.1, 1, 'move', 0.25, 0.5), ev(0.2, 1, 'move', 0.3, 0.5)],
      [ev(0.3, 2, 'down', 0.8, 0.5)],
      [0.4, 0.5, 0.6].flatMap((t, i) => [ev(t, 1, 'move', 0.3 + (i + 1) * 0.04, 0.5), ev(t, 2, 'move', 0.8 - (i + 1) * 0.04, 0.5)]),
      [ev(0.7, 1, 'up', 0.42, 0.5), ev(0.7, 2, 'up', 0.68, 0.5)],
    );
    const first = run(pinch, events);
    expect(first.pinchIn).toHaveLength(1);
    const claimAt = first.pinchIn![0]!.time;
    const second = run(drag, first.pass!);
    // Drag claimed finger 1 at its first move; finger 2 never got far enough before the pinch took it.
    expect(second.start?.map((e) => `${e.time} ${e.channel}`)).toEqual(['0.1 1']);
    // Pinch's cancel ends finger 1's drag without End.
    expect(second.end).toBeUndefined();
    const pass = second.pass ?? [];
    for (const channel of [1, 2]) {
      const mine = pass.filter((e) => e.channel === channel);
      expect(mine.filter((e) => e.phase === 'cancel'), `channel ${channel}`).toHaveLength(1);
      expect(mine.at(-1)!.phase).toBe('cancel');
    }
    expect(pass.filter((e) => e.channel === 1).at(-1)!.time).toBe(0.1);
    expect(pass.filter((e) => e.channel === 2).at(-1)!.time).toBe(claimAt);
  });
});

/** Pointer All → Tap (Claim on) and Hold, as a live host plays them. */
const node = (id: string, type: string, params = {}) => ({ id, type, typeVersion: nodeRegistry.get(type)!.version, params, position: { x: 0, y: 0 } });
const timerPatch: Patch = {
  format: 'flowpatch', version: 1, seed: 1,
  nodes: [node('pointer', 'pointer'), node('tap', 'tap', { claim: true }), node('hold', 'hold')],
  cables: [
    { from: { node: 'pointer', port: 'all' }, to: { node: 'tap', port: 'in' } },
    { from: { node: 'pointer', port: 'all' }, to: { node: 'hold', port: 'in' } },
  ],
};

/**
 * Raw pointer pushes at clock times. Pointer 7 lifts at 0.65 s, just before Tap's long press
 * (0.2 + 0.5 s, from the stamp); pointer 8 lifts at 1.0 s, just before Hold's claim (0.4 +
 * 0.25 + 0.4 × 1.1 s). By the time each up arrives, the scheduler has queried 120 ms past it.
 */
const PUSHES: { at: number; port: string; fields: Omit<EngineEvent, 'time'> }[] = [
  { at: 0.2, port: 'down', fields: { channel: 7, x: 0.3, y: 0.3, pointerType: 'touch' } },
  { at: 0.4, port: 'down', fields: { channel: 8, x: 0.7, y: 0.7, pointerType: 'touch' } },
  { at: 0.65, port: 'up', fields: { channel: 7, x: 0.3, y: 0.3, pointerType: 'touch' } },
  { at: 1.0, port: 'up', fields: { channel: 8, x: 0.7, y: 0.7, pointerType: 'touch' } },
];

function perform(wakes: number[], lookahead?: number): { log: LoggedEvent[]; rewinds: number } {
  const compiled = compilePatch(timerPatch, nodeRegistry);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  const clock = new ManualClock();
  const scheduler = new Scheduler(new Runtime(compiled.plan), { clock, record: true, ...(lookahead ? { lookahead } : {}) });
  const timeline = [...PUSHES.map((p, i) => ({ at: p.at, push: i })), ...wakes.map((at) => ({ at, push: -1 }))].sort((a, b) => a.at - b.at || b.push - a.push);
  for (const { at, push } of timeline) {
    clock.set(at);
    if (push < 0) scheduler.wake();
    else scheduler.push('pointer', PUSHES[push]!.port, PUSHES[push]!.fields);
  }
  for (let k = 1; (scheduler.horizon ?? -Infinity) < 2; k++) {
    clock.set(2 + k * 0.025);
    scheduler.wake();
  }
  return { log: scheduler.events().filter((e) => e.time < 2), rewinds: scheduler.stats.rewinds };
}

const grid = (step: number) => Array.from({ length: Math.ceil(2 / step) }, (_, k) => k * step);

describe('timer claims with live input (ADR 0019)', () => {
  it('withdraws a long press and a hold claim that a late up rules out, as if the up had been known in advance', () => {
    const ahead = perform(grid(0.002), 0.004);
    const live = perform(grid(0.025));
    expect(live.rewinds).toBeGreaterThan(0);
    expect(live.log).toEqual(ahead.log);
    const of = (id: string, port: string) => live.log.filter((e) => e.node === id && e.port === port);
    // Pointer 7 (slot 1) lifted before its long press, and pointer 8 (slot 2) before its hold claimed.
    expect(of('tap', 'longPress').filter((e) => e.channel === 1)).toEqual([]);
    expect(of('tap', 'passCancel').filter((e) => e.channel === 1)).toEqual([]);
    expect(of('hold', 'passCancel')).toEqual([]);
    expect(of('hold', 'release')).toEqual([]);
    // Pointer 8 was still down at 0.9 s: its long press stands, with Tap's claim.
    expect(of('tap', 'longPress').map((e) => e.channel)).toEqual([2]);
    expect(of('tap', 'pass').filter((e) => e.channel === 2).map((e) => e.phase)).toEqual(['down', 'cancel']);
  });
});

describe('Claim defaults (ADR 0028, amended 2026-10-24)', () => {
  it('are on for Pinch, Drag, Hold and Circle, off for Tap, Flick and Stroke', () => {
    const defaults = Object.fromEntries(['drag', 'tap', 'hold', 'flick', 'circle', 'pinch', 'stroke'].map((type) => [type, nodeRegistry.get(type)!.params.find((p) => p.name === 'claim')!.default]));
    expect(defaults).toEqual({ drag: true, tap: false, hold: true, flick: false, circle: true, pinch: true, stroke: false });
  });
});
