import type { EngineEvent, NodeDefinition, NodeState } from '@flow-patcher/engine';

/** Held steps per channel, times ascending. Plain data so a rewind snapshot can clone it (ADR 0019). */
interface Held {
  times: number[];
  values: number[];
}
type HeldState = Record<number, Held>;

/**
 * Seconds of held history kept behind each window start, as Sample & Hold keeps:
 * ADR 0019 rewinds re-run readers from a boundary before this node's last t0,
 * and frame-time reads trail the lookahead (1.25 s when the tab is hidden).
 */
export const RETAIN = 2;

/**
 * The fields the Field menu offers: the numeric base fields of an input event
 * (design.md, Event payload) and the Note fields. Any other name can be typed in,
 * such as a recognizer's own field.
 */
export const FIELD_PRESETS: Readonly<Record<string, string>> = {
  'x (0–1)': 'x',
  'y (0–1, 0 at top)': 'y',
  dx: 'dx',
  dy: 'dy',
  speed: 'speed',
  angle: 'angle',
  pressure: 'pressure',
  width: 'width',
  height: 'height',
  age: 'age',
  button: 'button',
  buttons: 'buttons',
  'shift (0/1)': 'shift',
  'alt (0/1)': 'alt',
  'ctrl (0/1)': 'ctrl',
  'meta (0/1)': 'meta',
  'Note pitch': 'pitch',
  'Note velocity': 'velocity',
  'Note duration': 'duration',
};

/** The field name the node reads: the text without surrounding spaces. */
export const fieldName = (text: string): string => text.trim();

/** The Field param as a field name; anything but text names no field. */
const fieldParam = (value: unknown): string => fieldName(typeof value === 'string' ? value : '');

export function fieldError(text: string): string | null {
  return fieldName(text) === '' ? 'Name a payload field, such as pressure.' : null;
}

/**
 * What an event's field gives Out: a number as is (non-finite → 0), a boolean
 * as 1 or 0, and undefined when the event has no such field or carries text
 * there, so the channel keeps its held value.
 */
export function fieldValue(event: EngineEvent, name: string): number | undefined {
  // Own fields only, so a name like "constructor" doesn't reach the prototype.
  if (!Object.hasOwn(event, name)) return undefined;
  const v = event[name];
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return undefined;
}

/** Channels are pointer ids (ADR 0009): non-negative integers. Others are ignored, so they can't grow `held`. */
const validChannel = (channel: number) => Number.isInteger(channel) && channel >= 0;

const heldOf = (state: NodeState): HeldState => (state.held ??= {}) as HeldState;

/** Index of the first time greater than t. */
function upperBound(times: readonly number[], t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Event → Signal: Out holds the named payload field of the latest event on each
 * channel, such as a pointer's pressure or a note's velocity, until the next
 * event there carries it. Notes plug into In too (a Note is an Event).
 *
 * Fallbacks: Out is 0 on a channel before its first event with the field. An
 * event without the field, or with text in it (pointerType), leaves the held
 * value alone, so a stream that mixes event kinds holds the last real reading.
 * A boolean reads 1 or 0, and a non-finite number 0. `time` and `channel` are
 * fields too.
 *
 * Stateful like Sample & Hold: `signal()` doesn't see event inputs, so `query`
 * records each value in `state.held`. A read at t only needs the events at or
 * before t, and every reader of Out is ordered after this node, so Out doesn't
 * depend on windowing. Naming another field drops the held values, so Out
 * doesn't keep the old field's readings until the new one arrives.
 */
export const getField: NodeDefinition = {
  type: 'get-field',
  version: 1,
  label: 'Get Field',
  category: 'control-logic',
  description: 'Holds one payload field of the latest event, such as pressure, as a Signal per channel.',
  ports: [
    { name: 'in', type: 'event', direction: 'in', label: 'In' },
    { name: 'out', type: 'signal', direction: 'out', label: 'Out' },
  ],
  params: [{ name: 'field', kind: 'text', default: 'pressure', label: 'Field', presets: FIELD_PRESETS, check: fieldError }],
  keepState(before, after) {
    return fieldParam(before.field) === fieldParam(after.field);
  },
  query({ inputs, state, params, t0 }) {
    const held = heldOf(state);
    // Forget steps before t0 − RETAIN, keeping the one in force then, so reads from there on are unchanged.
    for (const { times, values } of Object.values(held)) {
      const drop = upperBound(times, t0 - RETAIN) - 1;
      if (drop > 0) {
        times.splice(0, drop);
        values.splice(0, drop);
      }
    }
    const name = fieldParam(params.field);
    if (name === '') return {};
    for (const e of inputs.in ?? []) {
      if (!Number.isFinite(e.time) || !validChannel(e.channel)) continue;
      const value = fieldValue(e, name);
      if (value === undefined) continue;
      const { times, values } = (held[e.channel] ??= { times: [], values: [] });
      const i = upperBound(times, e.time);
      // Several events at one time on one channel: the last one wins.
      if (i > 0 && times[i - 1] === e.time) values[i - 1] = value;
      else {
        times.splice(i, 0, e.time);
        values.splice(i, 0, value);
      }
    }
    return {};
  },
  signal({ state }, port, t, channel) {
    if (port !== 'out' || !Number.isFinite(t)) return 0;
    const steps = heldOf(state)[channel];
    if (!steps) return 0;
    const i = upperBound(steps.times, t);
    return i === 0 ? 0 : steps.values[i - 1]!;
  },
};
