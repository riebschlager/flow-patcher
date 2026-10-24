import type { EngineEvent, NodeDefinition } from '@flow-patcher/engine';
import { channelStepAt, CLAIM_PARAM, IN_PORT, motionAt, moveMotion, num, PASS_PORTS, payloadOf, pruneTracks, record, runRecognizer, slot, type Motion, type MotionStep, type Steps } from './recognizer';

/** Seconds of steps an orbit is judged over (Flow: 2.2 s). */
export const WINDOW = 2.2;
/** Turn over the window that starts an orbit, radians: Flow's orbit > 0.15 at full speed, (|turn| − 2.5) / 2.5 > 0.15. */
export const START_TURN = 2.875;
/** |net turn| / total |turn| over the window: the turning must mostly go one way (Flow: 0.65). */
export const COHERENCE = 0.65;
/** Steps kept per contact, however fast the source samples: 2.2 s at 240 Hz fits. */
const MAX_STEPS = 1024;

interface Contact {
  motion: Motion;
  steps: MotionStep[];
  /** Turn since the down, radians, unwrapped; positive is clockwise on screen. */
  angle: number;
  started: boolean;
}

/** Angle from `time` on. */
interface Step {
  time: number;
  angle: number;
}

interface CircleState {
  contacts: Record<number, Contact>;
  tracks: Record<number, Steps<Step>>;
}

const direction = (angle: number) => (angle > 0 ? 1 : angle < 0 ? -1 : 0);
const fieldsOf = (angle: number) => ({ angle, revolutions: Math.abs(angle) / (2 * Math.PI), direction: direction(angle) });

/**
 * Gesture recognizer: a contact circling (docs/nodes/gesture-recognizers.md). Flow's Orbit
 * (gestures.js `GestureTracker.sample`: `orbit` and `spin`).
 *
 * Per channel, the contact's path is cut into steps as Flow's tracker cuts it (moves further
 * than MIN_STEP), each with its turn from the step before. Over the steps of the last WINDOW
 * seconds, once
 * - the net turn reaches START_TURN (about 0.46 of a revolution),
 * - it mostly goes one way (COHERENCE),
 * - the path is round enough: the net displacement is under Closure tolerance × the path's
 *   length (Flow: 0.75), and
 * - its radius, path length over net turn, is at least Minimum radius (canvas units),
 * Circle claims the channel (ADR 0028) at that move and emits Orbit start. Its up emits
 * Orbit end; a cancel ends the orbit without it.
 *
 * Changed from Flow: Flow's orbit needed a path over 0.2 long and scaled with speed, so a
 * slow circle never counted; here the radius and the turn decide, and speed doesn't matter.
 *
 * Signals, per channel, following the contact from its Orbit start and holding after it
 * ends, until the channel's next down sets them to 0:
 * - Angle: the turn since the down, radians, unwrapped (positive clockwise on screen);
 * - Revolutions: |Angle| / 2π;
 * - Direction: 1 clockwise, −1 counterclockwise (Flow's spin), 0 before an orbit.
 * Channel 0 (or any channel with no history) reads the contact that changed most recently.
 * Orbit start and Orbit end carry the In event's payload (without `phase`) with `angle`,
 * `revolutions` and `direction`.
 */
export const circle: NodeDefinition = {
  type: 'circle',
  version: 1,
  label: 'Circle',
  category: 'gesture-recognizers',
  description: 'A contact circling: claims it, with Orbit start and Orbit end events and Angle, Revolutions and Direction signals.',
  ports: [
    IN_PORT,
    ...PASS_PORTS,
    { name: 'start', type: 'event', direction: 'out', label: 'Orbit start' },
    { name: 'end', type: 'event', direction: 'out', label: 'Orbit end' },
    { name: 'angle', type: 'signal', direction: 'out', label: 'Angle' },
    { name: 'revolutions', type: 'signal', direction: 'out', label: 'Revolutions' },
    { name: 'direction', type: 'signal', direction: 'out', label: 'Direction' },
  ],
  params: [
    { name: 'minRadius', kind: 'number', min: 0, max: 0.5, default: 0.03, label: 'Minimum radius' },
    { name: 'closure', kind: 'number', min: 0.05, max: 1, default: 0.75, label: 'Closure tolerance' },
    CLAIM_PARAM,
  ],
  query(ctx) {
    const s = slot<CircleState>(ctx.state, 'circle', () => ({ contacts: {}, tracks: {} }));
    pruneTracks(s.tracks, ctx.t0);
    return runRecognizer(ctx, {
      event(event, phase, out) {
        const { channel, time } = event;
        const track = (s.tracks[channel] ??= []);
        if (phase === 'down') {
          s.contacts[channel] = { motion: motionAt(num(event.x, 0), num(event.y, 0), time), steps: [], angle: 0, started: false };
          record(track, { time, angle: 0 });
          return;
        }
        const contact = s.contacts[channel];
        if (!contact) return;
        if (phase === 'cancel') {
          delete s.contacts[channel];
          return;
        }
        const step = moveMotion(contact.motion, num(event.x, contact.motion.x), num(event.y, contact.motion.y), time);
        if (step) {
          contact.angle += step.turn;
          contact.steps.push(step);
          while (contact.steps.length && (time - contact.steps[0]!.time >= WINDOW || contact.steps.length > MAX_STEPS)) contact.steps.shift();
          if (contact.started) record(track, { time, angle: contact.angle });
        }
        const fields = (): EngineEvent => ({ ...payloadOf(event), ...fieldsOf(contact.angle) });
        if (phase === 'up') {
          if (contact.started) out.emit('end', fields());
          delete s.contacts[channel];
          return;
        }
        if (contact.started || !step || !orbits(contact.steps, ctx.param('minRadius', time, channel), ctx.param('closure', time, channel))) return;
        contact.started = true;
        record(track, { time, angle: contact.angle });
        out.claim(channel);
        out.emit('start', fields());
      },
    });
  },
  signal({ state }, port, t, channel) {
    const tracks = ((state.circle as CircleState | undefined)?.tracks ?? {}) as Record<number, Steps<Step>>;
    const angle = channelStepAt(tracks, channel, t)?.angle ?? 0;
    const fields = fieldsOf(angle);
    return port === 'angle' ? fields.angle : port === 'revolutions' ? fields.revolutions : port === 'direction' ? fields.direction : 0;
  },
};

/** Whether the steps of the window make an orbit (Flow's `orbit` test, with a radius for its length floor). */
function orbits(steps: readonly MotionStep[], minRadius: number, closure: number): boolean {
  let length = 0, turn = 0, turnTotal = 0, dx = 0, dy = 0;
  for (const step of steps) {
    length += step.length;
    turn += step.turn;
    turnTotal += Math.abs(step.turn);
    dx += step.dx;
    dy += step.dy;
  }
  const net = Math.abs(turn);
  return net >= START_TURN && net / (turnTotal + 0.001) > COHERENCE && Math.hypot(dx, dy) < length * closure && length / net >= minRadius;
}
