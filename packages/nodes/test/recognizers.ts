// Shared helpers for the gesture recognizer tests (docs/nodes/gesture-recognizers.md, ADR 0028).
import { expect } from 'vitest';
import type { EngineEvent, NodeDefinition, QueryResult } from '@flow-patcher/engine';
import { query } from './helpers';

export type Phase = 'down' | 'move' | 'up' | 'cancel';

/** One contact event as a source's All output carries it (touch unless `extra` says otherwise). */
export const ev = (time: number, channel: number, phase: Phase, x: number, y: number, extra: Record<string, string | number | boolean> = {}): EngineEvent =>
  ({ time, channel, phase, x, y, pointerType: 'touch', ...extra });

/** A straight stroke on one channel: down at `from`, `steps` moves to `to` every `dt`, then an up (or a cancel) right after the last. */
export function stroke(channel: number, t0: number, from: [number, number], to: [number, number], steps: number, dt: number, end: 'up' | 'cancel' | null = 'up', extra: Record<string, string | number | boolean> = {}): EngineEvent[] {
  const out = [ev(t0, channel, 'down', from[0], from[1], extra)];
  for (let i = 1; i <= steps; i++) out.push(ev(t0 + i * dt, channel, 'move', from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, extra));
  if (end) out.push(ev(t0 + steps * dt, channel, end, to[0], to[1], extra));
  return out;
}

/** Events from several contacts, in time order (stable, so same-time events keep their listed order). */
export const merge = (...lists: EngineEvent[][]): EngineEvent[] => lists.flat().sort((a, b) => a.time - b.time);

export interface RunOptions {
  params?: Record<string, unknown>;
  /** Window size; the default runs one call over [0, end). */
  step?: number;
  end?: number;
  state?: Record<string, unknown>;
}

/** Runs the recognizer over [0, end) in windows of `step`, every port concatenated. */
export function run(definition: NodeDefinition, events: readonly EngineEvent[], { params = {}, step, end = 4, state = {} }: RunOptions = {}): Record<string, EngineEvent[]> {
  const out: Record<string, EngineEvent[]> = {};
  const size = step ?? end;
  for (let i = 0; i * size < end - 1e-9; i++) {
    const t0 = i * size, t1 = Math.min(end, (i + 1) * size);
    const result: QueryResult = query(definition, t0, t1, { params, state, inputs: { in: events.filter((e) => e.time >= t0 && e.time < t1) } });
    for (const [port, list] of Object.entries(result)) (out[port] ??= []).push(...(list ?? []));
  }
  return out;
}

/** Every port the same in one call, 100 ms and 25 ms windows. */
export function expectWindowIndependent(definition: NodeDefinition, events: readonly EngineEvent[], options: RunOptions = {}): Record<string, EngineEvent[]> {
  const whole = run(definition, events, options);
  for (const step of [0.1, 0.025, 0.037]) expect(run(definition, events, { ...options, step }), `${step} s windows`).toEqual(whole);
  return whole;
}

const on = (list: readonly EngineEvent[] | undefined, channel: number) => (list ?? []).filter((e) => e.channel === channel);

/**
 * The four checks every recognizer gets (docs/nodes/gesture-recognizers.md): for each claimed
 * channel, Pass carries exactly one cancel, at `time`, as that channel's last event (nothing after
 * it), and Pass Cancel mirrors it; and channels in `free` pass every In event untouched.
 *
 * Before the cancel, Pass must carry exactly the channel's In events strictly before `time`, so a
 * claim that forwards its triggering event and then the cancel fails. Channels in `sameTime` (a
 * pinch's partner finger) may also have passed their In events at `time` that come before the
 * trigger in input order; the trigger is the first In event at `time` on a claimed channel not in
 * `sameTime`.
 */
export function expectClaim(out: Record<string, EngineEvent[]>, input: readonly EngineEvent[], { claimed, time, free = [], sameTime = [] }: { claimed: number[]; time: number; free?: number[]; sameTime?: number[] }): void {
  for (const channel of claimed) {
    const pass = on(out.pass, channel);
    const cancels = pass.filter((e) => e.phase === 'cancel');
    expect(cancels.length, `cancels on channel ${channel}`).toBe(1);
    expect(cancels[0]!.time, `claim time on channel ${channel}`).toBe(time);
    expect(pass.at(-1), `nothing after the cancel on channel ${channel}`).toBe(cancels[0]);
    expect(pass.filter((e) => e.time > time), `Pass after the claim on channel ${channel}`).toEqual([]);
    expect(on(out.passCancel, channel).length).toBe(1);
    for (const port of ['passDown', 'passMove', 'passUp']) expect(on(out[port], channel).filter((e) => e.time > time), `${port} after the claim`).toEqual([]);
    const before = pass.slice(0, -1);
    // The trigger: the first In event at the claim's time on a claimed channel not in `sameTime`.
    const trigger = input.findIndex((e) => e.time === time && claimed.includes(e.channel) && !sameTime.includes(e.channel));
    const allowed = input.filter((e, i) => e.channel === channel && (e.time < time || (sameTime.includes(channel) && e.time === time && trigger >= 0 && i < trigger)));
    expect(before, `Pass before the claim on channel ${channel}`).toEqual(allowed);
  }
  for (const channel of free) expect(on(out.pass, channel), `channel ${channel} passes untouched`).toEqual(on(input, channel));
}

/** Pass unchanged: every In event, in order, and nothing claimed. */
export function expectPassThrough(out: Record<string, EngineEvent[]>, input: readonly EngineEvent[]): void {
  expect(out.pass ?? []).toEqual(input);
  for (const phase of ['down', 'move', 'up', 'cancel'] as const) {
    const port = `pass${phase[0]!.toUpperCase()}${phase.slice(1)}`;
    expect(out[port] ?? []).toEqual(input.filter((e) => e.phase === phase).map(({ phase: _p, ...rest }) => rest));
  }
}
