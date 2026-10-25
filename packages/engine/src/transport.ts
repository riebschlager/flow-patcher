// The transport (ADR 0018): a beat position that a Clock writes and
// beat-counting readers (Progression, later Step Sequencer and Arpeggio) read
// over an ordinary Value cable.
//
// A transport is a list of anchors, plain data so it lives in node state and
// survives snapshots (ADR 0019). Each anchor fixes the beat and step position
// at its time and the tempo from then on. A tempo, division or swing change
// adds an anchor at the change time; reads before it keep using the old one,
// so the beat and the step position (and so Phase) never jump.
//
// Ticks are integer steps. Each anchor owns a run of step indices: those the
// previous anchor had not fired before the change. So every step fires exactly
// once, whatever the changes, and a tick's index comes from the transport,
// not from a per-node counter.
import type { NodeContext } from './definition';

/** Tempo, division and swing from one anchor on. */
export interface TransportTempo {
  /** Beats per second: bpm / 60, times any rate multiplier. Positive and finite. */
  beatsPerSecond: number;
  /** Beats per step: the division as beats (a 1/16 note is 0.25 beats). Positive and finite. */
  stepBeats: number;
  /** Odd steps fire this fraction of a step late. 0 ≤ swing < 1. */
  swing: number;
}

export interface TransportAnchor extends TransportTempo {
  /** Audio-clock time, seconds. */
  time: number;
  /** Beat position at `time`. */
  beat: number;
  /** Continuous step position at `time` (unswung). */
  step: number;
  /** The first step index this anchor fires; the previous anchor fired the ones before. */
  firstStep: number;
}

export interface Transport {
  /** Ticks fire from this time on (step 0 fires here). */
  start: number;
  /** Ascending by time; at least one. Older anchors are dropped (see trimTransport). */
  anchors: TransportAnchor[];
}

export interface TransportTick {
  time: number;
  /** Step index, counted by the transport from 0 at its start. */
  step: number;
  /** Beat position at the tick. */
  beat: number;
}

/**
 * Seconds of anchors `advanceTransport` keeps behind its window start, so
 * reads that lag the horizon (frames, up to 1.25 s while hidden) stay exact.
 */
export const TRANSPORT_HISTORY = 2;

/** A step position within this distance of an integer at an anchor is taken as that integer. */
const SNAP = 1e-9;

function checkTempo(tempo: TransportTempo): void {
  const { beatsPerSecond, stepBeats, swing } = tempo;
  if (!(beatsPerSecond > 0 && Number.isFinite(beatsPerSecond))) throw new RangeError(`transport: beatsPerSecond must be positive and finite, got ${beatsPerSecond}`);
  if (!(stepBeats > 0 && Number.isFinite(stepBeats))) throw new RangeError(`transport: stepBeats must be positive and finite, got ${stepBeats}`);
  if (!(swing >= 0 && swing < 1)) throw new RangeError(`transport: swing must be in [0, 1), got ${swing}`);
}

const tempoOf = ({ beatsPerSecond, stepBeats, swing }: TransportTempo): TransportTempo => ({ beatsPerSecond, stepBeats, swing });

export const sameTempo = (a: TransportTempo, b: TransportTempo): boolean =>
  a.beatsPerSecond === b.beatsPerSecond && a.stepBeats === b.stepBeats && a.swing === b.swing;

/** A transport at beat 0 and step 0 at `start`. Throws a RangeError on an unusable tempo. */
export function createTransport(tempo: TransportTempo, start = 0): Transport {
  checkTempo(tempo);
  if (!Number.isFinite(start)) throw new RangeError(`transport: start must be finite, got ${start}`);
  return { start, anchors: [{ time: start, beat: 0, step: 0, firstStep: 0, ...tempoOf(tempo) }] };
}

/** The anchor in effect at t: the latest at or before it, else the first. */
function anchorAt(transport: Transport, t: number): TransportAnchor {
  const { anchors } = transport;
  let i = anchors.length - 1;
  while (i > 0 && anchors[i]!.time > t) i--;
  return anchors[i]!;
}

const beatIn = (a: TransportAnchor, t: number) => a.beat + (t - a.time) * a.beatsPerSecond;
const stepIn = (a: TransportAnchor, t: number) => a.step + ((t - a.time) * a.beatsPerSecond) / a.stepBeats;

/** When `a` fires step k: its swung position on a's tempo, never before a's time. */
function fireTime(a: TransportAnchor, k: number): number {
  const position = k % 2 !== 0 ? k + a.swing : k;
  return Math.max(a.time, a.time + ((position - a.step) * a.stepBeats) / a.beatsPerSecond);
}

/** The first step ≥ a.firstStep that `a` fires at or after t. */
function firstStepFrom(a: TransportAnchor, t: number): number {
  let k = Math.max(a.firstStep, Math.floor(stepIn(a, t)) - 1);
  while (k > a.firstStep && fireTime(a, k - 1) >= t) k--;
  while (fireTime(a, k) < t) k++;
  return k;
}

/** The beat position at t. Reads before a change use the anchor that was in effect then. */
export function beatAt(transport: Transport, t: number): number {
  return beatIn(anchorAt(transport, t), t);
}

/** The continuous step position at t (unswung): step k starts at k. */
export function stepAt(transport: Transport, t: number): number {
  return stepIn(anchorAt(transport, t), t);
}

/** Position within the current step, 0 ≤ phase < 1. Continuous across changes except where it wraps. */
export function phaseAt(transport: Transport, t: number): number {
  const s = stepAt(transport, t);
  return s - Math.floor(s);
}

/** The tempo in effect at t. */
export function tempoAt(transport: Transport, t: number): TransportTempo {
  return tempoOf(anchorAt(transport, t));
}

/**
 * Changes the tempo from `time` on. The beat and step position carry on from
 * where the old tempo had them at `time`, so neither jumps. Ticks the old
 * tempo would have fired before `time` keep their times; the rest fire on the
 * new tempo, from `firstStep` when given (the caller has already fired the
 * steps before it, at or before `time`). Returns false, changing nothing, when
 * the tempo is the same and no `firstStep` is given. `time` may not be before
 * the newest anchor; throws a RangeError then, or on an unusable tempo.
 */
export function retune(transport: Transport, time: number, tempo: TransportTempo, firstStep?: number): boolean {
  checkTempo(tempo);
  const { anchors } = transport;
  const last = anchors.at(-1)!;
  if (!(time >= last.time) || !Number.isFinite(time)) throw new RangeError(`transport: retune at ${time} is before the newest anchor at ${last.time}`);
  if (sameTempo(last, tempo) && firstStep === undefined) return false;
  let step = stepIn(last, time);
  const nearest = Math.round(step);
  if (Math.abs(step - nearest) < SNAP) step = nearest;
  // A new anchor even at the newest one's time: the old one keeps the steps it
  // already fired there, and owns nothing after.
  anchors.push({
    time,
    beat: beatIn(last, time),
    step,
    firstStep: Math.max(last.firstStep, firstStep ?? firstStepFrom(last, time)),
    ...tempoOf(tempo),
  });
  return true;
}

/**
 * Forgets anchors that only matter for reads before `time`: keeps the one in
 * effect at `time` and everything after it. Reads at `time` or later, and
 * ticks there, are unchanged.
 */
export function trimTransport(transport: Transport, time: number): void {
  const { anchors } = transport;
  let drop = 0;
  while (drop < anchors.length - 1 && anchors[drop + 1]!.time <= time) drop++;
  if (drop) anchors.splice(0, drop);
}

/** The ticks in [t0, t1), in time order, on the anchors as they stand. */
export function ticksIn(transport: Transport, t0: number, t1: number): TransportTick[] {
  const ticks: TransportTick[] = [];
  const { anchors } = transport;
  const from = Math.max(t0, transport.start);
  if (!(t1 > from)) return ticks;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!, next = anchors[i + 1];
    // An anchor fires its steps in [a.time, next.time]; skip anchors outside the window.
    if (a.time >= t1 || (next && next.time < from)) continue;
    const end = next ? next.firstStep : Infinity;
    for (let k = firstStepFrom(a, from); k < end; k++) {
      const time = fireTime(a, k);
      if (!(time < t1)) break;
      ticks.push({ time, step: k, beat: beatIn(a, time) });
    }
  }
  return ticks;
}

/**
 * One query window of a Clock: the ticks in [t0, t1). With `sample`, the
 * tempo (knobs plus modulation) is sampled at each tick and takes effect right
 * after it, so a modulated tempo changes at tick times, which don't depend on
 * the windowing. (A knob change from a new plan takes effect at the window it
 * starts: call `retune(transport, t0, tempo)` before this.)
 *
 * It first forgets anchors from before t0 − TRANSPORT_HISTORY, so a modulated
 * tempo doesn't grow the state without bound. Which old anchors remain then
 * depends on where windows start, but every read the NodeState contract
 * allows (this window, frames up to 1.25 s behind) and every tick is the same
 * however time is split into windows.
 *
 * A window that starts before the newest anchor (queried again without its
 * state restored) gets the ticks the anchors give and doesn't re-anchor.
 */
export function advanceTransport(transport: Transport, t0: number, t1: number, sample?: (t: number) => TransportTempo): TransportTick[] {
  trimTransport(transport, t0 - TRANSPORT_HISTORY);
  if (!sample) return ticksIn(transport, t0, t1);
  const ticks: TransportTick[] = [];
  let pending = ticksIn(transport, t0, t1);
  for (let i = 0; i < pending.length; i++) {
    const tick = pending[i]!;
    ticks.push(tick);
    const newest = transport.anchors.at(-1)!;
    // A window before the newest anchor (queried again without restoring state)
    // reads the anchors as they stand; it can't re-anchor in the past.
    if (tick.time < newest.time) continue;
    const tempo = sample(tick.time);
    if (sameTempo(newest, tempo)) continue;
    retune(transport, tick.time, tempo, tick.step + 1);
    pending = ticksIn(transport, tick.time, t1).filter((next) => next.step > tick.step);
    i = -1;
  }
  return ticks;
}

/**
 * Everything a transport reader can know at t: the beat position, and the
 * tempo, division and swing of the anchor in effect then, with the time that
 * anchor took effect. Plain data, so it can travel on a Value cable.
 */
export interface TransportReading extends TransportTempo {
  /** Beat position at t, as `beatAt`. */
  beat: number;
  /** When this tempo took effect: the anchor's time. Reads before a change keep the old tempo. */
  since: number;
}

/** The transport at t as a `TransportReading`. */
export function readTransport(transport: Transport, t: number): TransportReading {
  const a = anchorAt(transport, t);
  return { beat: beatIn(a, t), ...tempoOf(a), since: a.time };
}

const isReading = (v: unknown): v is TransportReading => typeof v === 'object' && v !== null && 'beat' in v;

/**
 * A reader's beat at t from the Transport cable on `port` (ADR 0018): the
 * cable carries the beat as a number, or a `TransportReading`. 0 when nothing
 * is wired or there is no finite beat.
 */
export function transportBeat(ctx: Pick<NodeContext, 'value'>, port: string, t: number): number {
  const value = ctx.value(port, t);
  const beat = isReading(value) ? value.beat : value;
  return typeof beat === 'number' && Number.isFinite(beat) ? beat : 0;
}

/**
 * A reader's tempo at t from the Transport cable on `port`: the exact
 * beats per second, beats per step and swing of the anchor in effect at t,
 * and when it took effect (`since`), so a tempo-synced node can turn a
 * division into seconds (division beats / beatsPerSecond) and follow a change
 * from the moment it happens. Reads before a change get the old tempo.
 *
 * Null when nothing is wired, or when the cable carries only a beat number
 * (no anchor to read the tempo from) or an unusable tempo. The source must
 * put a `TransportReading` on the cable (`readTransport`) for this to answer.
 */
export function transportTempo(ctx: Pick<NodeContext, 'value'>, port: string, t: number): (TransportTempo & { since: number }) | null {
  const value = ctx.value(port, t);
  if (!isReading(value)) return null;
  const { beatsPerSecond, stepBeats, swing, since } = value;
  const usable = beatsPerSecond > 0 && Number.isFinite(beatsPerSecond) && stepBeats > 0 && Number.isFinite(stepBeats) && swing >= 0 && swing < 1 && Number.isFinite(since);
  return usable ? { beatsPerSecond, stepBeats, swing, since } : null;
}
