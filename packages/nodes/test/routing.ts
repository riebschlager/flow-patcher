// Shared checks for the routing nodes' tests (Switch, Modifier Router, Zone, Dwell).
import { expect } from 'vitest';
import { limitWindowOf, NODE_EVENT_LIMIT, type EngineEvent } from '@flow-patcher/engine';

const ENDS = ['up', 'cancel'];

/**
 * Asserts that on every port carrying phase-tagged events, each channel's downs and ends pair up:
 * no down while one is open, no end without one, and nothing left open. Events with no phase
 * (Pass Down and the other splits) are skipped; `splitsMatchPass` checks those.
 */
export function expectWellFormed(out: Record<string, readonly EngineEvent[] | undefined>): void {
  for (const [port, events] of Object.entries(out)) {
    const open = new Set<number>();
    for (const e of events ?? []) {
      const phase = e.phase as string | undefined;
      if (phase === 'down') {
        expect(open.has(e.channel), `${port}: second down on ${e.channel} at ${e.time}`).toBe(false);
        open.add(e.channel);
      } else if (phase && ENDS.includes(phase)) {
        expect(open.has(e.channel), `${port}: ${phase} with no down on ${e.channel} at ${e.time}`).toBe(true);
        open.delete(e.channel);
      }
    }
    expect([...open], `${port}: left open`).toEqual([]);
  }
}

/** Asserts no limit window (ADR 0022) holds more than NODE_EVENT_LIMIT events over all ports. */
export function expectUnderCap(out: Record<string, readonly EngineEvent[] | undefined>): void {
  const counts = new Map<number, number>();
  for (const events of Object.values(out)) for (const e of events ?? []) counts.set(limitWindowOf(e.time), (counts.get(limitWindowOf(e.time)) ?? 0) + 1);
  for (const [k, n] of counts) expect(n, `limit window ${k}`).toBeLessThanOrEqual(NODE_EVENT_LIMIT);
}

/**
 * An over-budget burst in one 120 ms limit window: `contacts` channels each go down, move
 * `moves` times and lift (every third cancels), with `fields(channel, step)` for position or
 * modifiers. Times are on a 1 ms grid from `start`.
 */
export function burst(contacts: number, moves: number, fields: (channel: number, step: number) => Record<string, number | string | boolean>, start = 0.0005): EngineEvent[] {
  const events: EngineEvent[] = [];
  for (let step = 0; step <= moves + 1; step++) {
    for (let c = 1; c <= contacts; c++) {
      const phase = step === 0 ? 'down' : step <= moves ? 'move' : c % 3 === 0 ? 'cancel' : 'up';
      events.push({ time: start + step * 0.001, channel: c, phase, ...fields(c, step) });
    }
  }
  return events;
}

const SPLITS = { down: 'passDown', move: 'passMove', up: 'passUp', cancel: 'passCancel' } as const;

/** Asserts that Pass Down, Move, Up and Cancel hold exactly Pass's events of their phase, without `phase`. */
export function splitsMatchPass(out: Record<string, readonly EngineEvent[] | undefined>): void {
  for (const [phase, port] of Object.entries(SPLITS)) {
    const expected = (out.pass ?? []).filter((e) => e.phase === phase).map(({ phase: _p, ...rest }) => rest);
    expect(out[port] ?? [], port).toEqual(expected);
  }
}
