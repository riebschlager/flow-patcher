// Shared machinery for the gesture recognizers (docs/nodes/gesture-recognizers.md, ADR 0028):
// the In and Pass ports, the claim, the timers, the event budget and the signal history.
// Not a node: each recognizer's own file holds its definition and its gesture logic.
import { limitWindowOf, NODE_EVENT_LIMIT, type EngineEvent, type NodeState, type PortSpec, type QueryContext, type QueryResult, type ToggleParamSpec } from '@flow-patcher/engine';
import { PHASES, RESERVE, type Phase } from './pointer';

export const IN_PORT: Readonly<PortSpec> = Object.freeze({ name: 'in', type: 'event', direction: 'in', label: 'In' });

/** Pass, then its per-phase split (ADR 0028). */
export const PASS_PORTS: readonly Readonly<PortSpec>[] = Object.freeze([
  { name: 'pass', type: 'event', direction: 'out', label: 'Pass' },
  { name: 'passDown', type: 'event', direction: 'out', label: 'Pass Down' },
  { name: 'passMove', type: 'event', direction: 'out', label: 'Pass Move' },
  { name: 'passUp', type: 'event', direction: 'out', label: 'Pass Up' },
  { name: 'passCancel', type: 'event', direction: 'out', label: 'Pass Cancel' },
].map((port) => Object.freeze(port as PortSpec)));

const PASS_PHASE: Record<Phase, string> = { down: 'passDown', move: 'passMove', up: 'passUp', cancel: 'passCancel' };

/**
 * Every recognizer's Claim toggle (ADR 0028, amended 2026-10-24): off, it recognizes but never
 * claims, and Pass carries everything. On by default where a claim is the point of the
 * gesture (Pinch, Drag, Hold, Circle), off where the gesture usually rides along with
 * painting (Tap, Flick, Stroke).
 */
export const claimParam = (on: boolean): ToggleParamSpec => ({ name: 'claim', kind: 'toggle', default: on, label: 'Claim' });

/*
 * Event budget: Pointer's RESERVE (pointer.ts). Forwarded moves (two events each, Pass and
 * Pass Move) and move-like gesture events stop once a limit window's count (ADR 0022) would
 * pass NODE_EVENT_LIMIT − RESERVE, so the runtime's per-node cap never takes Pass's downs,
 * ups and cancels or the gesture events that aren't moves.
 */

/**
 * Seconds of signal history kept behind each window start, as Sample & Hold keeps it:
 * rewinds re-run readers from a boundary before this node's last t0, and frame-time reads
 * trail the lookahead (1.25 s when hidden).
 */
export const RETAIN = 2;

/** Upper bound on timers fired in one query, against a recognizer that never clears one. */
const MAX_TIMERS = 4096;

/** What the driver keeps per open contact. Plain data (ADR 0019). */
interface Contact {
  claimed: boolean;
  /** The contact's latest In event, phase included: a claim made off its own event repeats it. */
  last: EngineEvent;
}

/** Events emitted in one limit window: `k` its index, `n` the count so far. */
interface Cell {
  k: number;
  n: number;
}

/** What a recognizer's hooks can do. */
export interface Emitter {
  /** Emits a gesture event on `port`. `thin`: a move-like event the budget may drop (RESERVE). */
  emit(port: string, event: EngineEvent, thin?: boolean): void;
  /** Claims an open, unclaimed channel (no-op otherwise, or with Claim off). Its cancel goes out on Pass at once. */
  claim(channel: number): void;
  /** Whether a channel is claimed, by this recognizer, right now. */
  claimed(channel: number): boolean;
}

/** One recognizer's gesture logic. Its own state lives in `state` (plain data), next to the driver's. */
export interface Recognizer {
  /**
   * An In event on a contact: a `down`, or a move, up or cancel on a channel with an open
   * contact. Hover moves, stray ends and events with no phase go to Pass without reaching it.
   * A claimed contact's events still arrive here; they just don't go on to Pass.
   */
  event(event: EngineEvent, phase: Phase, out: Emitter): void;
  /** The earliest pending timer's time, or null. */
  nextTimer?(): number | null;
  /** Fires the timer at `time` (which must clear it or move it later). */
  timer?(time: number, out: Emitter): void;
}

/** An event's contact phase (ADR 0028), or null when it has none or an unknown one. */
export const phaseOf = (event: EngineEvent): Phase | null => ((PHASES as readonly unknown[]).includes(event.phase) ? (event.phase as Phase) : null);

/** A payload field as a finite number, or `fallback`. */
export const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/**
 * One recognizer query: runs every In event of [t0, t1) and every timer due before t1
 * through `recognizer` in time order (a timer at an event's time fires first), and builds
 * Pass from what it didn't claim.
 *
 * Pass (ADR 0028):
 * - every In event in its tagged shape, and on Pass Down/Move/Up/Cancel without `phase`,
 *   as Pointer's per-phase ports carry them;
 * - in place of the event that makes a claim, one `cancel` (the event with phase cancel)
 *   at its time and place; every other channel claimed at that moment gets one right
 *   after, its latest event at that time with phase cancel;
 * - a claim made by a timer, which has no In event to replace, gets its cancel at the
 *   timer's time;
 * - then nothing from a claimed channel until its contact ends: the ending up or cancel is
 *   withheld too, and the next down starts a new contact.
 * Events with no phase (not from a contact source) go out on Pass alone, unless their
 * channel is claimed. Events with a non-finite time or channel are dropped.
 */
export function runRecognizer(ctx: Pick<QueryContext, 'inputs' | 'state' | 't0' | 't1' | 'params'>, recognizer: Recognizer): QueryResult {
  const { state, t0, t1 } = ctx;
  const contacts = (state.contacts ??= {}) as Record<number, Contact>;
  const cell = (state.cell ??= { k: -Infinity, n: 0 }) as Cell;
  const claiming = ctx.params.claim !== false;
  const out: Record<string, EngineEvent[]> = {};
  const push = (port: string, event: EngineEvent) => (out[port] ??= []).push(event);

  /** Counts `cost` events at `time` in its limit window; a `thin` one only while the window has room below RESERVE. */
  const admit = (time: number, cost: number, thin: boolean): boolean => {
    const k = limitWindowOf(time);
    if (k !== cell.k) Object.assign(cell, { k, n: 0 });
    if (thin && cell.n + cost > NODE_EVENT_LIMIT - RESERVE) return false;
    cell.n += cost;
    return true;
  };
  const forward = (event: EngineEvent, phase: Phase | null) => {
    if (!admit(event.time, phase ? 2 : 1, phase === 'move' || phase === null)) return;
    push('pass', event);
    if (phase) {
      const { phase: _phase, ...rest } = event;
      push(PASS_PHASE[phase], rest as EngineEvent);
    }
  };
  let claimsNow: number[] = [];
  const emitter: Emitter = {
    emit(port, event, thin = false) {
      if (admit(event.time, 1, thin)) push(port, event);
    },
    claim(channel) {
      const contact = contacts[channel];
      if (!claiming || !contact || contact.claimed) return;
      contact.claimed = true;
      claimsNow.push(channel);
    },
    claimed: (channel) => contacts[channel]?.claimed === true,
  };
  const cancelFor = (channel: number, time: number) => forward({ ...contacts[channel]!.last, time, phase: 'cancel' }, 'cancel');

  const fireTimers = (until: number, inclusive: boolean) => {
    for (let guard = 0; guard < MAX_TIMERS; guard++) {
      const due = recognizer.nextTimer?.() ?? null;
      if (due === null || !(inclusive ? due <= until : due < until)) return;
      // A timer left behind a window no one queried (a stall) fires at the start of this one.
      const time = Math.max(due, t0);
      claimsNow = [];
      recognizer.timer!(time, emitter);
      for (const channel of claimsNow) cancelFor(channel, time);
    }
  };

  for (const event of ctx.inputs.in ?? []) {
    if (!Number.isFinite(event.time) || !Number.isFinite(event.channel)) continue;
    fireTimers(event.time, true);
    const phase = phaseOf(event);
    const { channel } = event;
    let contact = contacts[channel];
    if (!phase) {
      if (!contact?.claimed) forward(event, null);
      continue;
    }
    if (phase === 'down') contacts[channel] = contact = { claimed: false, last: event };
    else if (!contact) {
      // A hover move, or an end with no contact open: nothing to recognize or claim.
      forward(event, phase);
      continue;
    } else contact.last = event;
    const wasClaimed = phase !== 'down' && contact.claimed;
    claimsNow = [];
    recognizer.event(event, phase, emitter);
    if (claimsNow.includes(channel)) forward({ ...event, phase: 'cancel' }, 'cancel');
    else if (!wasClaimed) forward(event, phase);
    for (const other of claimsNow) if (other !== channel) cancelFor(other, event.time);
    if (phase === 'up' || phase === 'cancel') delete contacts[channel];
  }
  fireTimers(t1, false);
  return out;
}

/** A signal's history: steps in time order, each in force from its time until the next. */
export type Steps<T extends { time: number }> = T[];

/**
 * Adds a step at its time. Steps after it (a ramp's future start, say) are dropped, and one
 * at the same time is replaced: the latest decision wins.
 */
export function record<T extends { time: number }>(steps: Steps<T>, step: T): void {
  while (steps.length && steps.at(-1)!.time >= step.time) steps.pop();
  steps.push(step);
}

/** Forgets steps before t0 − RETAIN, keeping the one in force then, so reads from there on don't change. */
export function prune<T extends { time: number }>(steps: Steps<T>, t0: number): void {
  let drop = 0;
  while (drop + 1 < steps.length && steps[drop + 1]!.time <= t0 - RETAIN) drop++;
  if (drop) steps.splice(0, drop);
}

/** The step in force at t, or null before the first. */
export function stepAt<T extends { time: number }>(steps: Steps<T> | undefined, t: number): T | null {
  if (!steps || !Number.isFinite(t)) return null;
  let lo = 0, hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid]!.time <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? null : steps[lo - 1]!;
}

/**
 * The step in force at t on `channel`; a channel with no history (channel 0, say) reads the
 * channel that changed most recently by t, as Pointer's signals do, so a clock-driven note can
 * follow whoever played last.
 */
export function channelStepAt<T extends { time: number }>(tracks: Record<number, Steps<T>>, channel: number, t: number): T | null {
  if (tracks[channel]?.length) return stepAt(tracks[channel], t);
  let best: T | null = null;
  for (const steps of Object.values(tracks)) {
    const step = stepAt(steps, t);
    if (step && (!best || step.time > best.time)) best = step;
  }
  return best;
}

/** Prunes every channel's history at a window start. */
export function pruneTracks<T extends { time: number }>(tracks: Record<number, Steps<T>>, t0: number): void {
  for (const steps of Object.values(tracks)) prune(steps, t0);
}

/** The recognizer's own state slot, created on first use. */
export const slot = <T>(state: NodeState, key: string, init: () => T): T => (state[key] ??= init()) as T;

/** An In event's payload for a gesture event: everything but `phase`. */
export function payloadOf(event: EngineEvent): EngineEvent {
  const { phase: _phase, ...rest } = event;
  return rest as EngineEvent;
}

/**
 * A contact's motion as Flow's stroke tracker measured it (gestures.js `GestureTracker`), in
 * seconds and canvas units: Flick, Circle and Stroke share it. Plain data. Changed from Flow:
 * no aspect correction (Flow scaled x by the canvas's width over height; events carry no canvas
 * size, so x and y are each 0–1 canvas units) and no clamp of x and y to 0–1 (the source
 * already clamps; positions are taken as they come).
 */
export interface Motion {
  /** The last sample that counted (moved more than MIN_STEP). */
  x: number;
  y: number;
  time: number;
  /** Smoothed speed, canvas units per second, and the heading of the last step (radians, atan2(dy, dx)). */
  speed: number;
  heading: number;
  /** The last step's vector, or null before the first. */
  vx: number | null;
  vy: number | null;
  /** Path length since the down. */
  path: number;
}

/** Steps shorter than this are jitter and don't count (Flow: 0.0008). */
export const MIN_STEP = 0.0008;
/** A step's duration is clamped to this range before its speed is taken (Flow: 8–120 ms). */
export const STEP_TIME: readonly [number, number] = [0.008, 0.12];
/** Fastest step speed counted, canvas units per second (Flow: 4). */
export const MAX_SPEED = 4;
/** Each step moves the smoothed speed this far toward its own (Flow: 0.4). */
export const SPEED_SMOOTHING = 0.4;

export const motionAt = (x: number, y: number, time: number): Motion => ({ x, y, time, speed: 0, heading: 0, vx: null, vy: null, path: 0 });

/** One step of a contact's motion: its vector, length and turn from the previous step. */
export interface MotionStep {
  time: number;
  dx: number;
  dy: number;
  length: number;
  /** Signed turn from the previous step, radians; positive is clockwise on screen (y down). */
  turn: number;
}

/** Folds a sample in (Flow `move`), returning the step it made, or null when it moved under MIN_STEP. */
export function moveMotion(m: Motion, x: number, y: number, time: number): MotionStep | null {
  const dx = x - m.x, dy = y - m.y, length = Math.hypot(dx, dy);
  if (!(length > MIN_STEP)) return null;
  const dt = Math.min(STEP_TIME[1], Math.max(STEP_TIME[0], time - m.time));
  m.speed += (Math.min(MAX_SPEED, length / dt) - m.speed) * SPEED_SMOOTHING;
  const turn = m.vx === null || m.vy === null ? 0 : Math.atan2(m.vx * dy - m.vy * dx, m.vx * dx + m.vy * dy);
  m.heading = Math.atan2(dy, dx);
  Object.assign(m, { vx: dx, vy: dy, x, y, time });
  m.path += length;
  return { time, dx, dy, length, turn };
}

/** The smoothed speed at t, fading once the contact stops moving (Flow: after 35 ms, over 170 ms). */
export const liveSpeed = (m: Motion, t: number): number => m.speed * Math.exp(-Math.max(0, t - m.time - 0.035) / 0.17);
